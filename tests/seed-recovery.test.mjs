import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ethers } from 'ethers';
import { network } from 'hardhat';
import { EscrowDatabase } from '../server/db.mjs';
import { getProvider } from '../scripts/helpers/chain.mjs';
import { compileEscrowContract } from '../scripts/helpers/compiler.mjs';
import { computeMetadataHash, getSeededListings } from '../scripts/helpers/seed-data.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('resumes an unregistered seed auction at its cutoff without replacing it or touching user listings', { timeout: 60_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bidpark-seed-recovery-'));
  let server;
  let provider;
  t.after(async () => {
    provider?.destroy();
    try {
      await server?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  server = await network.createServer('hardhat', '127.0.0.1', 0);
  const { port } = await server.listen();
  const rpcUrl = `http://127.0.0.1:${port}`;
  provider = getProvider(rpcUrl);
  const dbPath = path.join(dataDir, 'bidpark.db');
  const env = { ...process.env, RPC_URL: rpcUrl, BIDPARK_DATA_DIR: dataDir };
  delete env.DEMO_MNEMONIC;
  const deploy = () => run(process.execPath, ['scripts/deploy.mjs'], { cwd: root, env, timeout: 20_000 });

  const { abi, bytecode } = compileEscrowContract();
  const owner = await provider.getSigner(0);
  const buyer = await provider.getSigner(1);
  const user = await provider.getSigner(2);
  const contract = await new ethers.ContractFactory(abi, bytecode, owner).deploy();
  const receipt = await contract.deploymentTransaction().wait();
  const contractAddress = receipt.contractAddress;
  await writeFile(path.join(dataDir, 'deployment.json'), JSON.stringify({
    contractAddress, deploymentTxHash: receipt.hash, deploymentBlock: receipt.blockNumber,
  }));

  const seeds = getSeededListings((await provider.getBlock('latest')).timestamp);
  const [expired, remaining] = seeds;
  const userListing = { ...expired.metadata, title: 'Existing user listing' };
  const userHash = computeMetadataHash(userListing);
  const createAuction = async (signer, metadataHash, timing) => {
    await (await contract.connect(signer).createAuction(
      metadataHash, timing.minBidWei, timing.bidEnd, timing.parkingStart, timing.parkingEnd,
    )).wait();
  };
  await createAuction(user, userHash, remaining);
  // Interrupt after the auction exists, before its registration and configured bid.
  await createAuction(owner, expired.metadataHash, expired);

  let originalUserRow;
  const initialDb = new EscrowDatabase(dbPath);
  try {
    initialDb.setMeta(`seed_status_${contractAddress}`, 'pending');
    initialDb.upsertListing({ ...userListing, auctionId: '1', contractAddress, metadataHash: userHash });
    originalUserRow = initialDb.getListing('1', contractAddress);
  } finally {
    initialDb.close();
  }

  await provider.send('evm_setNextBlockTimestamp', [expired.bidEnd]);
  await provider.send('evm_mine', []);
  assert.equal((await provider.getBlock('latest')).timestamp, expired.bidEnd);
  const { stdout, stderr } = await deploy();
  assert.match(stderr, /Skipped initial demo bid for auction #2: bidding deadline passed/);
  assert.match(stdout, /7 demo listings ready; skipped 1 initial demo bids/);
  assert.equal(await contract.nextAuctionId(), BigInt(seeds.length + 2));
  const expiredAuction = await contract.auctions(2);
  assert.equal(expiredAuction.bidEnd, BigInt(expired.bidEnd));
  assert.equal(expiredAuction.highestBid, 0n);
  const liveAuction = await contract.auctions(3);
  assert.equal(liveAuction.metadataHash, remaining.metadataHash);
  assert.equal(liveAuction.highestBidder, buyer.address);
  assert.equal(liveAuction.highestBid, ethers.parseEther(remaining.initialBidEth));

  const readRows = () => {
    const db = new EscrowDatabase(dbPath);
    try {
      return db.getAllListings(contractAddress);
    } finally {
      db.close();
    }
  };
  const rows = readRows();
  assert.equal(rows.length, seeds.length + 1);
  assert.deepEqual(rows[0], originalUserRow);
  assert.equal(rows[1].metadata_hash, expired.metadataHash);

  const recoveredBlock = await provider.getBlockNumber();
  const rerun = await deploy();
  assert.match(rerun.stderr, /Seeding previously finished with skipped initial demo bids/);
  assert.equal(await provider.getBlockNumber(), recoveredBlock);
  assert.deepEqual(readRows(), rows);
});
