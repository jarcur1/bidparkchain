import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { deriveInbox, mergeFeed } from '../../server/inbox.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const HOST = 1, WINNER = 2, LOSER = 3, RESOLVER = 4, STRANGER = 5;
let scope, chain, deployment, runtime, server, url;
const cookies = {};
const parse = (eth) => ethers.parseEther(eth);
const escrow = (index) => deployment.contract.connect(chain.wallet(index));
const send = async (tx) => (await tx).wait();
const api = async (index, route, body) => {
  const res = await fetch(`${url}${route}`, body === undefined ? { headers: { cookie: cookies[index] } } : {
    method: 'POST', headers: { cookie: cookies[index], 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const inbox = async (index) => {
  await runtime.syncIndexOnce();
  const { status, body } = await api(index, '/api/inbox');
  expect(status).toBe(200);
  return body;
};
const feed = (body) => body.items.map((item) => (item.change ? `booking:${item.change}` : item.kind));

beforeAll(async () => {
  scope = await createScope('api-inbox-bookings');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  await send(deployment.contract.setResolver(chain.wallet(RESOLVER).address, true));
  const dataDir = scope.tempDir();
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [HOST, WINNER, LOSER, RESOLVER, STRANGER]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('requires a session and validates dismiss and preference writes', async () => {
  for (const route of ['/api/inbox/dismiss', '/api/inbox/preferences']) {
    expect((await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[],"hidden":[]}' })).status).toBe(401);
  }
  expect((await api(WINNER, '/api/inbox/dismiss', { ids: ['checkin:0'] })).status).toBe(400);
  expect((await api(WINNER, '/api/inbox/dismiss', { ids: 'all' })).status).toBe(400);
  expect((await api(WINNER, '/api/inbox/preferences', { hidden: ['spam'] })).status).toBe(400);
});

it('walks a protected booking through both parties\' inboxes in order and keeps each wallet private', async () => {
  const now = await chain.latestTimestamp();
  const id = (await deployment.contract.nextAuctionId()).toString();
  const start = now + 600 + 2 * 86400;
  await send(escrow(HOST).createProtectedAuction(0, ethers.id('inbox-booking'), parse('0.01'), now + 600, start, start + 3600));
  await send(escrow(LOSER).bid(id, { value: parse('0.02') }));
  await send(escrow(WINNER).bid(id, { value: parse('0.03') }));
  await chain.increaseTime(700);
  await send(escrow(STRANGER).settle(id));
  expect(feed(await inbox(WINNER))).toEqual(['won']); // more than a day out: no reservation entry yet

  // Inside 24 hours: upcoming; inside the hour: arrival, saying instructions exist without their text.
  await chain.increaseTime(2 * 86400 - 100 - 20 * 60);
  runtime.db.setArrivalKey(Buffer.alloc(32, 1));
  const host = await api(HOST, `/api/auctions/${id}/arrival`, { instructions: 'Gate code QX-SECRET-7731' });
  expect(host.status).toBe(200);
  runtime.db.setArrivalKey(null);
  let winner = await inbox(WINNER);
  expect(feed(winner)).toEqual(['arrival', 'upcoming', 'won']);
  expect(winner.items[0]).toMatchObject({ id: `arrival:${id}`, hasInstructions: true, parkingStart: start, category: 'reservations', read: false });
  expect(JSON.stringify(winner)).not.toContain('QX-SECRET');

  // The winner checks in; only the host is told.
  await chain.increaseTime(10 * 60);
  expect((await api(WINNER, `/api/auctions/${id}/check-in`, {})).status).toBe(201);
  expect(feed(await inbox(HOST))).toEqual(['checked-in']);
  for (const other of [LOSER, RESOLVER, STRANGER]) {
    expect((await inbox(other)).items.filter((item) => item.auctionId === id && item.kind !== 'outbid')).toEqual([]);
  }

  // The host records a no-show, the winner reports a seller failure and a resolver upholds it.
  await chain.increaseTime(40 * 60);
  await send(escrow(HOST).recordNoShow(id));
  await send(escrow(WINNER).reportSellerFailure(id, ethers.id('evidence')));
  await send(escrow(RESOLVER).resolveDispute(id, true, ethers.id('decision')));

  winner = await inbox(WINNER);
  expect(feed(winner)).toEqual(['booking-refund', 'booking:dispute-upheld', 'booking:dispute-opened', 'booking:no-show', 'won']);
  expect(winner.items.find((item) => item.change === 'no-show')).toMatchObject({ role: 'winner', byMe: false, auctionId: id });
  expect(winner.items.find((item) => item.change === 'dispute-opened')).toMatchObject({ byMe: true });
  const hostFeed = await inbox(HOST);
  expect(feed(hostFeed)).toEqual(['booking:dispute-upheld', 'booking:dispute-opened', 'booking:no-show', 'checked-in']);
  expect(hostFeed.items.find((item) => item.change === 'no-show')).toMatchObject({ role: 'host', byMe: true });
  expect(feed(await inbox(LOSER))).toEqual(['outbid']);
  expect((await inbox(RESOLVER)).items).toEqual([]);
  expect((await inbox(STRANGER)).items).toEqual([]);

  // Dismissal is per wallet: another wallet dismissing these ids changes nothing for their owners.
  const hostIds = hostFeed.items.map((item) => item.id);
  expect((await api(STRANGER, '/api/inbox/dismiss', { ids: hostIds })).status).toBe(200);
  expect(feed(await inbox(HOST))).toHaveLength(4);
  const dismissed = await api(HOST, '/api/inbox/dismiss', { ids: [hostIds[3]] });
  expect(feed(dismissed.body)).toEqual(['booking:dispute-upheld', 'booking:dispute-opened', 'booking:no-show']);
  expect(dismissed.body.unread).toBe(3);
  expect((await api(HOST, '/api/inbox/dismiss', { ids: [hostIds[3]] })).status).toBe(200); // idempotent

  // Preferences hide whole categories, for this wallet only, and survive a reload.
  const hidden = await api(WINNER, '/api/inbox/preferences', { hidden: ['bookings'] });
  expect(feed(hidden.body)).toEqual(['won']);
  expect(hidden.body).toMatchObject({ unread: 1, preferences: { hidden: ['bookings'] } });
  expect(feed(await inbox(WINNER))).toEqual(['won']);
  expect(feed(await inbox(HOST))).toHaveLength(3);
  expect(feed((await api(WINNER, '/api/inbox/preferences', { hidden: [] })).body)).toHaveLength(5);
});

it('tells the host when a report expires and when a winner cancels late', async () => {
  const now = await chain.latestTimestamp();
  const late = (await deployment.contract.nextAuctionId()).toString();
  const start = now + 600 + 3600;
  await send(escrow(HOST).createProtectedAuction(0, ethers.id('inbox-late'), parse('0.01'), now + 600, start, start + 3600));
  await send(escrow(WINNER).bid(late, { value: parse('0.02') }));
  await chain.increaseTime(700);
  await send(escrow(WINNER).settle(late));
  await send(escrow(WINNER).cancelBooking(late)); // inside 24 hours: recorded, not refunded
  await send(escrow(HOST).reportSellerFailure(late, ethers.id('host-report')));
  await chain.increaseTime(3600 + 3600 + 72 * 3600);
  await send(escrow(STRANGER).expireDispute(late));
  const mine = (body) => feed({ items: body.items.filter((item) => item.auctionId === late) });
  expect(mine(await inbox(HOST))).toEqual(['booking:dispute-expired', 'booking:dispute-opened', 'booking:late-cancelled']);
  // A late cancellation ends the reservation, so no upcoming or arrival entry ever appears for it.
  expect(mine(await inbox(WINNER))).toEqual(['booking-refund', 'booking:dispute-opened', 'booking:late-cancelled', 'won']);
});

it('derives denials and merges off-chain entries by time without reordering chain entries', () => {
  const ev = (event, account, i, tx = `0x${i}`) => ({
    event, auction_id: '9', account, amount: null, block_hash: `0x${String(i).padStart(64, '0')}`, log_index: 0, block_number: i, tx_hash: tx,
  });
  const items = deriveInbox([
    ev('AuctionCreated', '0xHOST', 1), ev('AuctionSettled', '0xWIN', 2),
    ev('DisputeOpened', '0xWIN', 3), ev('DisputeResolved', '0xRES', 4), ev('DisputeOpened', '0xHOST', 5),
  ], '0xhost');
  expect(items.map((item) => [item.change, item.byMe, item.role])).toEqual([
    ['dispute-opened', true, 'host'], ['dispute-denied', false, 'host'], ['dispute-opened', false, 'host'],
  ]);
  expect(deriveInbox([ev('DisputeOpened', '0xWIN', 3)], '0xother')).toEqual([]);

  const chainItems = [{ id: 'c', at: 300 }, { id: 'b', at: null }, { id: 'a', at: 100 }];
  expect(mergeFeed(chainItems, [{ id: 'x', at: 50 }, { id: 'y', at: 300 }, { id: 'z', at: 200 }]).map((item) => item.id))
    .toEqual(['y', 'c', 'b', 'z', 'a', 'x']);
});
