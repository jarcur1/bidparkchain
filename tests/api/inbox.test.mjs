import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { deriveInbox } from '../../server/inbox.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

let scope, chain, deployment, runtime, server, url;
const parse = (eth) => ethers.parseEther(eth);
const cookies = {};

async function createAuction() {
  const now = await chain.latestTimestamp();
  const id = await deployment.contract.nextAuctionId();
  await (await deployment.contract.createAuction(ethers.id(`spot-${id}`), parse('0.01'), now + 600, now + 1200, now + 1800)).wait();
  return id.toString();
}
const bid = async (index, id, eth) => (await deployment.contract.connect(chain.wallet(index)).bid(id, { value: parse(eth) })).wait();
const as = (index) => ({ cookie: cookies[index] });
const inbox = async (index) => {
  const res = await fetch(`${url}/api/inbox`, { headers: as(index) });
  expect(res.status).toBe(200);
  return res.json();
};
const kinds = (body) => body.items.map((item) => [item.kind, item.auctionId, item.amount]);
const markRead = (index, ids) => fetch(`${url}/api/inbox/read`, {
  method: 'POST', headers: { ...as(index), 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
});

beforeAll(async () => {
  scope = await createScope('api-inbox');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  const dataDir = scope.tempDir();
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [0, 1, 2, 3]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('requires a signed-in wallet and validates read requests', async () => {
  expect((await fetch(`${url}/api/inbox`)).status).toBe(401);
  expect((await fetch(`${url}/api/inbox/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }),
  })).status).toBe(401);
  expect((await markRead(1, ['not-an-id'])).status).toBe(400);
  expect((await markRead(1, 'all')).status).toBe(400);
});

it('reports an unindexed inbox as not indexed rather than empty and current', async () => {
  const body = await inbox(1);
  expect(body).toMatchObject({ items: [], unread: 0, index: { indexedBlock: null, lastSyncAt: null } });
});

it('derives outbid, win, refund and payout entries per wallet with persisted read state', async () => {
  const id = await createAuction();
  runtime.db.upsertListing({
    contractAddress: deployment.address, auctionId: id, metadataHash: ethers.id(`spot-${id}`),
    title: 'Maple Street driveway', address: '1 Maple St', neighborhood: 'Downtown', latitude: 1, longitude: 1,
    description: 'Covered spot', image: '', kind: 'driveway', amenities: [],
  });
  await bid(1, id, '0.02');
  await bid(2, id, '0.03');
  await (await deployment.contract.connect(chain.wallet(1)).withdrawRefund()).wait();
  await chain.increaseTime(700);
  await (await deployment.contract.settle(id)).wait();
  await chain.increaseTime(1200);
  await (await deployment.contract.claimPayout(id)).wait();
  await runtime.syncIndexOnce();

  const driver = await inbox(1);
  expect(kinds(driver)).toEqual([['refund', null, '0.02'], ['outbid', id, '0.02']]);
  expect(driver.items[1]).toMatchObject({ title: 'Maple Street driveway', read: false, txHash: expect.stringMatching(/^0x/) });
  expect(driver.unread).toBe(2);
  expect(driver.index).toMatchObject({ lagBlocks: 0, lastSyncError: null, indexedBlock: await chain.provider.getBlockNumber() });
  expect(kinds(await inbox(2))).toEqual([['won', id, '0.03']]);
  expect(kinds(await inbox(0))).toEqual([['payout', id, '0.03']]);
  expect(kinds(await inbox(3))).toEqual([]);

  // Read state is per wallet: wallet 2 marking wallet 1's entry changes nothing for wallet 1.
  expect((await markRead(2, [driver.items[1].id])).status).toBe(200);
  expect((await inbox(1)).unread).toBe(2);
  const afterRead = await (await markRead(1, [driver.items[1].id])).json();
  expect(afterRead.unread).toBe(1);
  expect(afterRead.items.map((item) => item.read)).toEqual([false, true]);
  expect((await markRead(1, [driver.items[1].id])).status).toBe(200); // idempotent
  expect((await inbox(1)).unread).toBe(1);
});

it('drops entries whose events were orphaned by a reorg and shows the replacement history', async () => {
  const id = await createAuction();
  await runtime.syncIndexOnce();
  const snapshot = await chain.provider.send('evm_snapshot', []);
  await bid(3, id, '0.02');
  await bid(1, id, '0.04');
  await runtime.syncIndexOnce();
  expect(kinds(await inbox(3))).toEqual([['outbid', id, '0.02']]);

  // Replacement branch: wallet 3 is never outbid; it wins.
  await chain.provider.send('evm_revert', [snapshot]);
  await bid(2, id, '0.02');
  await bid(3, id, '0.05');
  await chain.increaseTime(700);
  await (await deployment.contract.settle(id)).wait();
  await runtime.syncIndexOnce();
  // The auction starts within the hour, so the winner also gets reservation entries (checked separately).
  expect(kinds(await inbox(3)).filter(([kind]) => kind === 'won' || kind === 'outbid')).toEqual([['won', id, '0.05']]);
  expect(kinds(await inbox(2))[0]).toEqual(['outbid', id, '0.02']);
  expect(kinds(await inbox(1)).filter(([, auction]) => auction === id)).toEqual([]);
});

it('only reports an outbid when the wallet held the highest bid', () => {
  const ev = (event, auction, account, amount, i) => ({
    event, auction_id: auction, account, amount, block_hash: `0x${String(i).padStart(64, '0')}`, log_index: 0, block_number: i, tx_hash: '0x',
  });
  const items = deriveInbox([
    ev('BidPlaced', '1', '0xAA', '1', 1),
    ev('BidPlaced', '1', '0xBB', '2', 2),
    ev('BidPlaced', '1', '0xCC', '3', 3), // 0xAA was already outbid; no second entry
    ev('BidPlaced', '2', '0xBB', '1', 4),
    ev('BidPlaced', '2', '0xaa', '2', 5), // own bid, any case
    ev('BidPlaced', '2', '0xDD', '3', 6),
  ], '0xaa');
  expect(items.map((item) => [item.kind, item.auctionId, item.amount, item.blockNumber])).toEqual([
    ['outbid', '2', '2', 6],
    ['outbid', '1', '1', 2],
  ]);
});

it('tells a protected-booking winner when the bid is credited back, and lists the booking state', async () => {
  const now = await chain.latestTimestamp();
  const id = (await deployment.contract.nextAuctionId()).toString();
  const start = now + 600 + 2 * 86400;
  await (await deployment.contract.createProtectedAuction(0, ethers.id(`spot-${id}`), parse('0.01'), now + 600, start, start + 3600)).wait();
  runtime.db.upsertListing({
    contractAddress: deployment.address, auctionId: id, metadataHash: ethers.id(`spot-${id}`),
    title: 'Protected driveway', address: '2 Maple St', neighborhood: 'Downtown', latitude: 1, longitude: 1,
    description: 'Covered spot', image: '', kind: 'driveway', amenities: [],
  });
  await bid(3, id, '0.04');
  await chain.increaseTime(700);
  await (await deployment.contract.hostCancelBooking(id)).wait();
  await runtime.syncIndexOnce();
  expect(kinds(await inbox(3))[0]).toEqual(['booking-refund', id, '0.04']);
  const { listings } = await (await fetch(`${url}/api/listings`)).json();
  expect(listings.find((l) => l.id === id).booking).toEqual({
    protected: true, outcome: 'host-cancelled', lateCancelled: false, noShowRecorded: false, disputeReporter: null,
  });
  expect(listings.find((l) => l.id !== id).booking).toMatchObject({ protected: false, outcome: 'none' });
});
