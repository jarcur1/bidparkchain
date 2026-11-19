import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EscrowDatabase } from '../../server/db.mjs';
import { syncIndex } from '../../server/indexer.mjs';
import { createScope, deployEscrow } from '../support/owned-env.mjs';

let scope, chain, deployment, db;
const parse = (eth) => ethers.parseEther(eth);
const sync = (options = {}) => syncIndex({
  db, provider: chain.provider, address: deployment.address, abi: deployment.abi,
  fromBlock: deployment.deploymentBlock, batch: 2, ...options,
});
const summary = (rows) => rows.map((e) => [e.event, e.auction_id, e.account, e.amount]);

async function createAuction() {
  const now = await chain.latestTimestamp();
  const id = await deployment.contract.nextAuctionId();
  await (await deployment.contract.createAuction(ethers.id(`spot-${id}`), parse('0.01'), now + 600, now + 1200, now + 1800)).wait();
  return id.toString();
}
const bid = async (index, id, eth) => (await deployment.contract.connect(chain.wallet(index)).bid(id, { value: parse(eth) })).wait();

beforeAll(async () => {
  scope = await createScope('api-indexer');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  db = new EscrowDatabase(path.join(scope.tempDir(), 'bidpark.db'));
});
afterAll(async () => {
  db?.close();
  chain?.provider.destroy();
  await scope?.close();
});

it('backfills from the deployment block in batches and is idempotent on replay', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await bid(2, id, '0.03');
  const first = await sync();
  expect(first).toMatchObject({ added: 3, orphaned: 0, lagBlocks: 0 });
  expect(summary(db.getAuctionEvents(deployment.address, id))).toEqual([
    ['AuctionCreated', id, chain.wallet(0).address, null],
    ['BidPlaced', id, chain.wallet(1).address, parse('0.02').toString()],
    ['BidPlaced', id, chain.wallet(2).address, parse('0.03').toString()],
  ]);
  const stored = db.getAuctionEvents(deployment.address, id)[1];
  expect(stored).toMatchObject({ tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), block_hash: expect.stringMatching(/^0x/), canonical: 1 });

  expect(await sync()).toMatchObject({ added: 0 });
  // A crash after events were written but before the checkpoint: the replay inserts nothing twice.
  db.db.prepare('DELETE FROM index_checkpoints').run();
  expect(await sync()).toMatchObject({ added: 0 });
  expect(db.getAuctionEvents(deployment.address, id)).toHaveLength(3);
});

it('catches up after downtime from its checkpoint', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await bid(3, id, '0.05');
  await (await deployment.contract.connect(chain.wallet(1)).withdrawRefund()).wait();
  const caught = await sync();
  expect(caught.added).toBe(4);
  expect(summary(db.getAuctionEvents(deployment.address, null)).filter(([event]) => event === 'RefundWithdrawn'))
    .toEqual([['RefundWithdrawn', null, chain.wallet(1).address, parse('0.04').toString()]]); // 0.02 from each auction
});

it('orphans events from a reorg through a winning settlement and indexes the replacement history', async () => {
  const id = await createAuction();
  await sync();
  const snapshot = await chain.provider.send('evm_snapshot', []);

  // Original branch: driver 1 wins and the auction is settled.
  await bid(1, id, '0.04');
  await chain.increaseTime(700);
  await (await deployment.contract.settle(id)).wait();
  await sync();
  expect(summary(db.getAuctionEvents(deployment.address, id)).map(([event, , account]) => [event, account])).toEqual([
    ['AuctionCreated', chain.wallet(0).address],
    ['BidPlaced', chain.wallet(1).address],
    ['AuctionSettled', chain.wallet(1).address],
  ]);

  // Replacement branch at the same heights: driver 2 outbids driver 3 and wins instead.
  await chain.provider.send('evm_revert', [snapshot]);
  await bid(3, id, '0.04');
  await bid(2, id, '0.06');
  await chain.increaseTime(700);
  await (await deployment.contract.settle(id)).wait();
  const result = await sync();
  expect(result.orphaned).toBe(2);
  expect(summary(db.getAuctionEvents(deployment.address, id)).map(([event, , account]) => [event, account])).toEqual([
    ['AuctionCreated', chain.wallet(0).address],
    ['BidPlaced', chain.wallet(3).address],
    ['BidPlaced', chain.wallet(2).address],
    ['AuctionSettled', chain.wallet(2).address],
  ]);
  const orphans = db.getAuctionEvents(deployment.address, id, { includeOrphaned: true }).filter((e) => !e.canonical);
  expect(orphans.map((e) => [e.event, e.account])).toEqual([
    ['BidPlaced', chain.wallet(1).address],
    ['AuctionSettled', chain.wallet(1).address],
  ]);
  expect(db.getCheckpoint(deployment.address).block_hash).toBe((await chain.provider.getBlock('latest')).hash);
});

it('indexes only finalized blocks under the finalized policy', async () => {
  const head = await chain.provider.getBlock('latest');
  const finalized = await chain.provider.getBlock('finalized');
  const result = await sync({ confirmation: 'finalized' });
  expect(result.headBlock).toBe(finalized.number);
  expect(finalized.number).toBeLessThanOrEqual(head.number);
});

it('serves index freshness and per-auction history from the API', async () => {
  const { createApp } = await import('../../server/app.mjs');
  const { writeDeployment } = await import('../support/owned-env.mjs');
  const dataDir = scope.tempDir();
  const runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => (await fetch(`${url}${route}`)).json();
  try {
    expect(await get('/api/index')).toMatchObject({ confirmation: 'mined', indexedBlock: null, lastSyncAt: null });
    expect(await get('/api/auctions/1/events')).toEqual({ indexedBlock: null, syncError: null, events: [] });
    const [first, second] = await Promise.all([runtime.syncIndexOnce(), runtime.syncIndexOnce()]);
    expect(first).toBe(second);
    const head = await chain.provider.getBlockNumber();
    expect(await get('/api/index')).toMatchObject({ indexedBlock: head, headBlock: head, lagBlocks: 0, lastSyncError: null });
    const { events, indexedBlock } = await get('/api/auctions/1/events');
    expect(indexedBlock).toBe(head);
    expect(events.map((e) => [e.event, e.amount])).toEqual([['AuctionCreated', null], ['BidPlaced', '0.02'], ['BidPlaced', '0.03']]);
    expect(events[1]).toMatchObject({ txHash: expect.stringMatching(/^0x/), blockNumber: expect.any(Number) });
    expect((await fetch(`${url}/api/auctions/0/events`)).status).toBe(400);
    const block = await chain.provider.getBlock(events[1].blockNumber);
    expect(events[1].blockTime).toBe(block.timestamp);
    const mine = await get(`/api/accounts/${chain.wallet(1).address.toLowerCase()}/history`);
    expect(mine).toMatchObject({ chainId: expect.any(Number), contractAddress: deployment.address, indexedBlock: head });
    expect(mine.events.every((e) => typeof e.blockTime === 'number')).toBe(true);
    expect(mine.events.some((e) => e.event === 'BidPlaced' && e.auctionId === '1')).toBe(true);
    expect((await fetch(`${url}/api/accounts/nope/history`)).status).toBe(400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.db.close();
    runtime.provider.destroy();
  }
});
