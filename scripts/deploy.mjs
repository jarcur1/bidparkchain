import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { compileEscrowContract } from './helpers/compiler.mjs';
import { resolveRuntimeProfile, assertProfileDirectory } from './helpers/runtime-profile.mjs';
import { runPersistentDeployment } from './helpers/persistent-deployment.mjs';
import {
  getProvider,
  getWallet,
  isNodeReachable,
  hasDeployedCode,
  assertLocalChain,
  HARDHAT_CHAIN_ID,
  HARDHAT_MNEMONIC,
} from './helpers/chain.mjs';
import { getSeededListings, resolveSeedScenario } from './helpers/seed-data.mjs';
import { EscrowDatabase } from '../server/db.mjs';
import { canonicalizeAuctionId } from '../server/app.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.BIDPARK_DATA_DIR || path.resolve(ROOT_DIR, 'data'));
const DEPLOYMENT_PATH = path.resolve(DATA_DIR, 'deployment.json');

const UNSENDABLE_BID_ERRORS = {
  AlreadyCancelled: 'auction was cancelled',
  AlreadySettled: 'auction was settled',
  AuctionEnded: 'bidding deadline passed',
};

async function placeSeedBid(contract, buyerWallet, provider, auctionId, amount) {
  const block = await provider.getBlock('latest');
  const auction = await contract.auctions(auctionId, { blockTag: block.number });
  if (auction.highestBidder !== ethers.ZeroAddress) return;
  if (auction.cancelled) return UNSENDABLE_BID_ERRORS.AlreadyCancelled;
  if (auction.settled) return UNSENDABLE_BID_ERRORS.AlreadySettled;
  if (auction.bidEnd <= BigInt(block.timestamp)) return UNSENDABLE_BID_ERRORS.AuctionEnded;

  try {
    const tx = await contract.connect(buyerWallet).bid(auctionId, { value: ethers.parseEther(amount) });
    await tx.wait();
  } catch (error) {
    // The auction may close between the eligibility check and transaction execution.
    // Only skip known contract rejections; surface RPC failures and other unexpected errors.
    const rpcData = error.info?.error?.data;
    const data = error.data ?? (typeof rpcData === 'string' ? rpcData : rpcData?.data);
    const selector = typeof data === 'string' ? data.slice(0, 10) : null;
    for (const [name, reason] of Object.entries(UNSENDABLE_BID_ERRORS)) {
      if (selector === contract.interface.getError(name).selector) return reason;
    }
    throw error;
  }
  console.log(`     Placed initial bid of ${amount} ETH on demo auction #${auctionId}`);
}

async function main() {
  const runtime = resolveRuntimeProfile();
  assertProfileDirectory(runtime);
  if (runtime.profile.id === 'sepolia') {
    try {
      const deployment = await runPersistentDeployment(runtime, process.argv.slice(2), process.env);
      console.log(`[BidPark Deploy] Verified Sepolia deployment: ${deployment.contractAddress}`);
    } catch {
      // RPC and wallet errors may contain credentials or signed transaction data.
      throw new Error('Sepolia deployment failed. Check the configuration and pending deployment record; never retry creation until any pending transaction is resolved.');
    }
    return;
  }
  if (process.argv.length > 2) throw new Error('Deployment options are only available for Sepolia.');
  const scenario = resolveSeedScenario();
  if (process.env.BIDPARK_DATA_DIR !== undefined) {
    if (fs.existsSync(`${DEPLOYMENT_PATH}.pending`) || fs.existsSync(`${DEPLOYMENT_PATH}.lock`)) {
      throw new Error('Refusing local deployment in a directory with a pending persistent deployment.');
    }
    if (fs.existsSync(DEPLOYMENT_PATH)) {
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
      } catch {
        throw new Error('Refusing local deployment with an unreadable deployment descriptor.');
      }
      if (existing?.profile === 'sepolia' || Number(existing?.chainId) === 11155111) {
        throw new Error('Refusing local deployment in a Sepolia data directory.');
      }
    }
  }
  console.log(`[BidPark Deploy] Starting deployment process (seed scenario: ${scenario})...`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const provider = getProvider();

  // Verify node accessibility
  const reachable = await isNodeReachable();
  if (!reachable) {
    throw new Error(
      'Local blockchain node is not responding at http://127.0.0.1:8545. Please run `npm run chain` first.'
    );
  }

  // Security guardrail: verify RPC chainId is strictly 31337 before signing anything
  await assertLocalChain(provider);

  const deployerWallet = getWallet(0, provider);
  const buyerWallet = getWallet(1, provider);
  console.log(`[BidPark Deploy] Deployer account (Vendor index 0): ${deployerWallet.address}`);
  console.log(`[BidPark Deploy] Demo buyer account (Buyer index 1): ${buyerWallet.address}`);

  const db = new EscrowDatabase(path.resolve(DATA_DIR, 'bidpark.db'));

  // Compile Solidity contract with Shanghai target
  console.log('[BidPark Deploy] Compiling contracts/ParkingAuctionEscrow.sol (solc, EVM: shanghai)...');
  const { abi, bytecode } = compileEscrowContract();

  // Check for existing valid deployment (idempotence)
  let existingDeployment = null;
  if (fs.existsSync(DEPLOYMENT_PATH)) {
    try {
      existingDeployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
    } catch {
      existingDeployment = null;
    }
  }

  let contractAddress = null;
  let deploymentBlock = 0;
  let deploymentTxHash = null;
  let isFreshDeploy = false;

  const previousScenario = existingDeployment?.seedScenario ?? 'austin';
  if (existingDeployment?.contractAddress && previousScenario !== scenario) {
    // A new contract gives the scenario its own listings; scenarios never share a deployment.
    console.log(`[BidPark Deploy] Seed scenario changed from ${previousScenario} to ${scenario}. Re-deploying.`);
    isFreshDeploy = true;
  } else if (
    existingDeployment &&
    existingDeployment.contractAddress &&
    existingDeployment.deploymentTxHash &&
    (await hasDeployedCode(existingDeployment.contractAddress, provider))
  ) {
    // Verify that the deployment transaction exists in the current node instance
    const deployedTx = await provider.getTransaction(existingDeployment.deploymentTxHash);
    if (deployedTx) {
      console.log(
        `[BidPark Deploy] Active contract code and deployment transaction verified at ${existingDeployment.contractAddress}. Reusing deployment.`
      );
      contractAddress = existingDeployment.contractAddress;
      deploymentBlock = existingDeployment.deploymentBlock ?? 0;
      deploymentTxHash = existingDeployment.deploymentTxHash;
    } else {
      console.log('[BidPark Deploy] Chain history reset detected (fresh node). Re-deploying.');
      isFreshDeploy = true;
    }
  } else {
    isFreshDeploy = true;
  }

  if (isFreshDeploy) {
    console.log('[BidPark Deploy] Deploying new ParkingAuctionEscrow instance...');
    const factory = new ethers.ContractFactory(abi, bytecode, deployerWallet);
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    contractAddress = await contract.getAddress();
    const receipt = await contract.deploymentTransaction()?.wait();
    deploymentBlock = receipt ? receipt.blockNumber : await provider.getBlockNumber();
    deploymentTxHash = contract.deploymentTransaction()?.hash || receipt?.hash || null;

    console.log(
      `[BidPark Deploy] ParkingAuctionEscrow deployed at: ${contractAddress} (block ${deploymentBlock}, tx: ${deploymentTxHash})`
    );

    // Explicit local demo reset: a fresh local chain may reuse the same contract address, so drop its
    // old listings. Deployment history is kept; persistent profiles never reach this code.
    const cleared = db.resetLocalDemo();
    if (cleared > 0) {
      console.log(`[BidPark Deploy] Cleared ${cleared} prior listing records to seed clean database.`);
    }

    db.setMeta('active_contract_address', contractAddress);
    db.setMeta('deployment_block', String(deploymentBlock));
    if (deploymentTxHash) {
      db.setMeta('deployment_tx_hash', deploymentTxHash);
    }
    db.setMeta(`seed_status_${contractAddress}`, 'pending');
  }

  // Write deployment.json artifact
  const deploymentConfig = {
    chainId: HARDHAT_CHAIN_ID,
    contractAddress,
    deploymentTxHash,
    abi,
    currency: 'ETH',
    networkName: 'Hardhat Local',
    demoMnemonic: HARDHAT_MNEMONIC,
    demoAccountIndex: 1,
    deploymentBlock,
    seedScenario: scenario,
  };

  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deploymentConfig, null, 2), 'utf8');
  console.log(`[BidPark Deploy] Deployment artifact updated: ${DEPLOYMENT_PATH}`);

  const contract = new ethers.Contract(contractAddress, abi, deployerWallet);

  // Check seed status and resume any unfinished seed auctions or initial bids
  const seedStatusKey = `seed_status_${contractAddress}`;
  const seedStatus = db.getMeta(seedStatusKey);

  const currentBlock = await provider.getBlock('latest');
  const baseTimestamp = currentBlock ? currentBlock.timestamp : Math.floor(Date.now() / 1000);
  const seedListings = getSeededListings(baseTimestamp, scenario);

  // Check if all seed listings are present in SQLite
  let allPresent = seedStatus === 'completed' || seedStatus === 'degraded';
  if (allPresent) {
    for (const item of seedListings) {
      const found = db.getListingByMetadataHash(contractAddress, item.metadataHash);
      if (!found) {
        allPresent = false;
        break;
      }
    }
  }

  if (isFreshDeploy || !allPresent) {
    console.log(`[BidPark Deploy] Seeding or resuming ${scenario} demo listings...`);
    const nextOnchainId = await contract.nextAuctionId();
    const totalOnchain = Number(nextOnchainId) - 1;
    let skippedBids = 0;

    for (let i = 0; i < seedListings.length; i++) {
      const item = seedListings[i];
      let auctionId = null;

      // Check 1: Is this seed listing already registered in SQLite?
      const existingInDb = db.getListingByMetadataHash(contractAddress, item.metadataHash);
      if (existingInDb) {
        const canonicalDbId = canonicalizeAuctionId(existingInDb.auction_id);
        if (canonicalDbId) {
          const onchain = await contract.auctions(canonicalDbId);
          if (
            onchain &&
            onchain.owner !== ethers.ZeroAddress &&
            onchain.metadataHash.toLowerCase() === item.metadataHash.toLowerCase()
          ) {
            auctionId = canonicalDbId;
          }
        }
      }

      // Check 2: If not in DB, does it already exist onchain from an interrupted run?
      if (!auctionId && totalOnchain > 0) {
        for (let candidateId = 1; candidateId <= totalOnchain; candidateId++) {
          try {
            const onchain = await contract.auctions(candidateId);
            if (
              onchain &&
              onchain.owner !== ethers.ZeroAddress &&
              onchain.metadataHash.toLowerCase() === item.metadataHash.toLowerCase()
            ) {
              auctionId = String(candidateId);
              break;
            }
          } catch {
            // continue scan
          }
        }
      }

      // If not yet onchain, create it now
      if (!auctionId) {
        console.log(`  -> Creating auction [${i + 1}/${seedListings.length}]: "${item.metadata.title}"`);
        const tx = await contract.createAuction(
          item.metadataHash,
          item.minBidWei,
          item.bidEnd,
          item.parkingStart,
          item.parkingEnd
        );
        const receipt = await tx.wait();

        for (const log of receipt.logs) {
          try {
            const parsed = contract.interface.parseLog(log);
            if (parsed && parsed.name === 'AuctionCreated') {
              auctionId = canonicalizeAuctionId(String(parsed.args.id));
              break;
            }
          } catch {
            // not this event
          }
        }

        if (!auctionId) {
          const nextId = await contract.nextAuctionId();
          auctionId = canonicalizeAuctionId(String(Number(nextId) - 1));
        }
      } else {
        console.log(
          `  -> Resuming existing seed auction #${auctionId} [${i + 1}/${seedListings.length}]: "${item.metadata.title}"`
        );
      }

      // Upsert metadata record into SQLite
      db.upsertListing({
        auctionId,
        contractAddress,
        metadataHash: item.metadataHash,
        title: item.metadata.title,
        address: item.metadata.address,
        neighborhood: item.metadata.neighborhood,
        latitude: item.metadata.latitude,
        longitude: item.metadata.longitude,
        description: item.metadata.description,
        image: item.metadata.image,
        kind: item.metadata.kind,
        amenities: item.metadata.amenities,
      });

      // Place initial bid if configured and not yet placed
      if (item.initialBidEth) {
        const reason = await placeSeedBid(contract, buyerWallet, provider, auctionId, item.initialBidEth);
        if (reason) {
          skippedBids++;
          console.warn(`[BidPark Deploy] Skipped initial demo bid for auction #${auctionId}: ${reason}.`);
        }
      }
    }

    db.setMeta(seedStatusKey, skippedBids ? 'degraded' : 'completed');
    console.log(`[BidPark Deploy] ${seedListings.length} demo listings ready; skipped ${skippedBids} initial demo bids.`);
  } else if (seedStatus === 'degraded') {
    console.warn('[BidPark Deploy] Seeding previously finished with skipped initial demo bids. Leaving existing auctions unchanged.');
  } else {
    console.log('[BidPark Deploy] Seeding already complete for this contract deployment. Skipping.');
  }

  db.close();
  console.log('[BidPark Deploy] Deployment and seeding complete.');
}

main().catch((err) => {
  console.error('[BidPark Deploy] Error:', err);
  process.exit(1);
});
