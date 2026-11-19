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
