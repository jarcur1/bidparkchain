// Class demo helpers for a local campus scenario (#38). Local Hardhat chain only.
//   npm run demo -- walkthrough   scripted bid, outbid, refund, settle on spot N1
//   npm run demo -- advance       move the chain clock past every open bidding deadline
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { assertLocalChain, getProvider, getWallet, HARDHAT_RPC_URL } from './helpers/chain.mjs';
import { getSeededListings } from './helpers/seed-data.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Simulated roles: Hardhat development accounts 0-2. */
export const DEMO_ROLES = { host: 0, driverA: 1, driverB: 2 };
/** Scripted amounts, chosen for the demo; they are not derived from the fixtures. */
export const DEMO_BIDS = { driverA: '0.03', driverB: '0.05' };

async function openDemo(rpcUrl, dataDir) {
  if (process.env.BIDPARK_PROFILE && process.env.BIDPARK_PROFILE !== 'local') {
    throw new Error('Demo helpers only run with the local profile.');
  }
  if (!LOOPBACK.has(new URL(rpcUrl).hostname)) throw new Error(`Refusing non-loopback RPC ${rpcUrl}.`);
  const provider = getProvider(rpcUrl);
  await assertLocalChain(provider);
  const file = path.join(dataDir, 'deployment.json');
  if (!fs.existsSync(file)) throw new Error('No local deployment found. Start the stack with npm run dev first.');
  const deployment = JSON.parse(fs.readFileSync(file, 'utf8'));
  if ((await provider.getCode(deployment.contractAddress)) === '0x') {
    throw new Error('The deployment in this data directory is not on this chain. Restart npm run dev.');
  }
  const contract = new ethers.Contract(deployment.contractAddress, deployment.abi, provider);
  return { provider, contract, scenario: deployment.seedScenario ?? 'austin' };
}

async function chainNow(provider) {
  return (await provider.getBlock('latest')).timestamp;
}

async function advanceTo(provider, timestamp) {
  const delta = timestamp - (await chainNow(provider));
  if (delta > 0) await provider.send('evm_increaseTime', [delta]);
  await provider.send('evm_mine', []);
}

/** Moves chain time to one second past the latest open bidding deadline. */
export async function advancePastBidding({ rpcUrl = HARDHAT_RPC_URL, dataDir }) {
  const { provider, contract } = await openDemo(rpcUrl, dataDir);
  try {
    const now = await chainNow(provider);
    let latest = 0;
    for (let id = 1n; id < (await contract.nextAuctionId()); id++) {
      const a = await contract.auctions(id);
      if (!a.settled && !a.cancelled && Number(a.bidEnd) > now) latest = Math.max(latest, Number(a.bidEnd));
    }
    if (latest) await advanceTo(provider, latest + 1);
    return { advancedSeconds: latest ? latest + 1 - now : 0, chainTime: await chainNow(provider) };
  } finally {
    provider.destroy();
  }
}

/**
 * Driver A bids, driver B outbids, A withdraws the displaced bid, bidding closes, B settles.
 * Requires a fresh campus scenario; restart npm run dev to run it again.
 */
export async function runWalkthrough({ rpcUrl = HARDHAT_RPC_URL, dataDir, log = () => {} }) {
  const { provider, contract, scenario } = await openDemo(rpcUrl, dataDir);
  try {
    if (!scenario.startsWith('campus-')) throw new Error('Run the walkthrough with BIDPARK_SCENARIO=campus-baseline or campus-expansion.');
    const spot = getSeededListings(0, scenario).find((l) => l.fixtureId === 'N1');
    let id;
    for (let i = 1n; i < (await contract.nextAuctionId()); i++) {
      if ((await contract.auctions(i)).metadataHash === spot.metadataHash) id = i;
    }
    if (!id) throw new Error('Spot N1 is not seeded on this deployment.');
    if ((await contract.auctions(id)).highestBidder !== ethers.ZeroAddress) {
      throw new Error('Spot N1 already has bids. Restart npm run dev for a clean run.');
    }
    const [driverA, driverB] = [getWallet(DEMO_ROLES.driverA, provider), getWallet(DEMO_ROLES.driverB, provider)];
    const as = (wallet) => contract.connect(wallet);
    const send = async (tx) => (await tx).wait();

    await send(as(driverA).bid(id, { value: ethers.parseEther(DEMO_BIDS.driverA) }));
    log(`1. Driver A (account ${DEMO_ROLES.driverA}) bids ${DEMO_BIDS.driverA} ETH on N1 (auction #${id}).`);
    await send(as(driverB).bid(id, { value: ethers.parseEther(DEMO_BIDS.driverB) }));
    const refund = await contract.pendingReturns(driverA.address);
    log(`2. Driver B (account ${DEMO_ROLES.driverB}) outbids with ${DEMO_BIDS.driverB} ETH; A can withdraw ${ethers.formatEther(refund)} ETH.`);
    await send(as(driverA).withdrawRefund());
    log(`3. Driver A withdraws the displaced ${ethers.formatEther(refund)} ETH.`);
    await advanceTo(provider, Number((await contract.auctions(id)).bidEnd) + 1);
    log('4. Demo clock moves past the bidding deadline.');
    await send(as(driverB).settle(id));
    const final = await contract.auctions(id);
    log(`5. Settled: winner is driver B with ${ethers.formatEther(final.highestBid)} ETH. Simulated record only; no real parking access.`);
    return {
      scenario,
      auctionId: String(id),
      winner: final.highestBidder === driverB.address ? 'driverB' : final.highestBidder,
      winningBid: ethers.formatEther(final.highestBid),
      refundWithdrawn: ethers.formatEther(refund),
      refundLeft: ethers.formatEther(await contract.pendingReturns(driverA.address)),
      settled: final.settled,
    };
  } finally {
    provider.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = path.resolve(process.env.BIDPARK_DATA_DIR || path.join(ROOT_DIR, 'data'));
  const command = process.argv[2];
  const run = command === 'walkthrough'
    ? runWalkthrough({ dataDir, log: console.log })
    : command === 'advance'
      ? advancePastBidding({ dataDir }).then((r) => console.log(`Advanced the chain clock ${r.advancedSeconds}s. Refresh the app.`))
      : Promise.reject(new Error('Usage: npm run demo -- walkthrough | advance'));
  run.catch((error) => {
    console.error(`[BidPark Demo] ${error.message}`);
    process.exit(1);
  });
}
