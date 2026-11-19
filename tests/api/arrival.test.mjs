import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { ARRIVAL_OPENS_BEFORE, CHECK_IN_OPENS_BEFORE, winnerAccess } from '../../server/arrival.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const HOST = 1, WINNER = 2, OUTBID = 3, OTHER = 4, LISTER = 5;
const SECRET = 'Gate code 4471, then the second door on the left';
const SPACE_SECRET = 'Space default: buzz unit 9 and wait';
const DAY = 24 * 3600;
const hash = ethers.id('arrival-test');

let scope, chain, deployment, escrow, runtime, server, url;
const cookies = {};
const ids = {};
let S, E;

const call = async (index, route, body) => {
  const res = await fetch(`${url}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json', ...(index === null ? {} : { cookie: cookies[index] }) },
  });
  return { status: res.status, headers: res.headers, text: await res.clone().text(), json: await res.json() };
};
const arrival = (index, id) => call(index, `/api/auctions/${id}/arrival`);
const checkIn = (index, id) => call(index, `/api/auctions/${id}/check-in`, {});
const as = (index) => escrow.connect(chain.wallet(index));
const send = async (promise) => (await promise).wait();
const noSecret = (text) => {
  expect(text).not.toContain('Gate code');
  expect(text).not.toContain('buzz unit');
};
async function denied(index, id, reason) {
  const res = await arrival(index, id);
  expect(res.status).toBe(403);
  expect(res.json.reason).toBe(reason);
  noSecret(res.text);
}

/** Creates a protected auction (space 0 registers a new one) and returns its id. */
async function create(spaceId, bidEnd, start, end) {
  const id = await escrow.nextAuctionId();
  await send(as(HOST).createProtectedAuction(spaceId, hash, ethers.parseEther('0.01'), bidEnd, start, end));
  return id.toString();
}

beforeAll(async () => {
  scope = await createScope('api-arrival');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  escrow = deployment.contract;
  const B = (await chain.latestTimestamp()) + 600;
  S = B + 3 * DAY;
  E = S + 4 * 3600;

  await send(as(HOST).registerSpace()); // space 1
  await send(as(HOST).setSpaceLister(1, chain.wallet(LISTER).address, true));
  ids.main = await create(1, B, S, E);
  ids.early = await create(0, B, S, E); // the winner cancels early: refunded
  ids.hostCancelled = await create(0, B, S, E);
  ids.late = await create(0, B, B + 3600, B + 7200); // the winner cancels late: recorded, not refunded
  ids.unsettled = await create(0, B, B + 3600, B + 7200);
  await send(as(OUTBID).bid(ids.main, { value: ethers.parseEther('0.01') }));
  for (const id of Object.values(ids)) await send(as(WINNER).bid(id, { value: ethers.parseEther('0.02') }));

  const dataDir = scope.tempDir();
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [HOST, WINNER, OUTBID, OTHER, LISTER]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

describe('winnerAccess', () => {
  const winner = '0x' + '2'.repeat(40);
  const base = { owner: '0x' + '1'.repeat(40), highestBidder: winner, settled: true, cancelled: false, parkingStart: 10_000, parkingEnd: 20_000 };
  const at = (chainTime, onchain = {}, booking = { outcome: 0n, lateCancelled: false }) =>
    winnerAccess({ onchain: { ...base, ...onchain }, booking, address: winner, chainTime }).reason ?? 'ok';

  it('opens an hour before parking starts and closes when it ends', () => {
    expect(at(10_000 - ARRIVAL_OPENS_BEFORE - 1)).toBe('too-early');
    expect(at(10_000 - ARRIVAL_OPENS_BEFORE)).toBe('ok');
    expect(at(19_999)).toBe('ok');
    expect(at(20_000)).toBe('closed');
    expect(winnerAccess({
      onchain: base, booking: null, address: winner, chainTime: 10_000 - CHECK_IN_OPENS_BEFORE - 1, opensBefore: CHECK_IN_OPENS_BEFORE,
    }).reason).toBe('too-early');
  });

  it('denies other wallets, unsettled, cancelled and refunded reservations', () => {
    expect(winnerAccess({ onchain: base, booking: null, address: '0x' + '3'.repeat(40), chainTime: 15_000 }).reason).toBe('not-winner');
    expect(winnerAccess({ onchain: { ...base, highestBidder: ethers.ZeroAddress }, booking: null, address: ethers.ZeroAddress, chainTime: 15_000 }).reason).toBe('not-winner');
    expect(at(15_000, { settled: false })).toBe('unsettled');
    expect(at(15_000, { cancelled: true })).toBe('cancelled');
    expect(at(15_000, {}, { outcome: 2n, lateCancelled: false })).toBe('cancelled');
    expect(at(15_000, {}, { outcome: 0n, lateCancelled: true })).toBe('cancelled');
    expect(at(15_000, {}, { outcome: 6n, lateCancelled: false })).toBe('ok');
  });
});

describe('arrival instructions and check-in', () => {
  it('requires a session for every route', async () => {
    expect((await arrival(null, ids.main)).status).toBe(401);
    expect((await checkIn(null, ids.main)).status).toBe(401);
    expect((await call(null, `/api/auctions/${ids.main}/arrival`, { instructions: SECRET })).status).toBe(401);
    expect((await call(null, '/api/spaces/1/arrival', { instructions: SECRET })).status).toBe(401);
  });

  it('lets only the host, space owner or approved lister store instructions', async () => {
    expect((await call(OTHER, `/api/auctions/${ids.main}/arrival`, { instructions: SECRET })).status).toBe(403);
    expect((await call(WINNER, `/api/auctions/${ids.main}/arrival`, { instructions: SECRET })).status).toBe(403);
    expect((await call(OTHER, '/api/spaces/1/arrival', { instructions: SECRET })).status).toBe(403);
    expect((await call(HOST, `/api/auctions/${ids.main}/arrival`, { instructions: 'x'.repeat(2001) })).status).toBe(400);
    expect((await call(HOST, `/api/auctions/${ids.main}/arrival`, { instructions: 42 })).status).toBe(400);
    expect((await call(HOST, '/api/auctions/abc/arrival', { instructions: SECRET })).status).toBe(400);
    expect((await call(HOST, '/api/auctions/999/arrival', { instructions: SECRET })).status).toBe(404);
    expect((await call(LISTER, '/api/spaces/1/arrival', { instructions: SPACE_SECRET })).json).toEqual({ saved: true });
    expect((await call(HOST, `/api/auctions/${ids.main}/arrival`, { instructions: ` ${SECRET} ` })).json).toEqual({ saved: true });
    for (const id of [ids.early, ids.hostCancelled, ids.late, ids.unsettled]) {
      expect((await call(HOST, `/api/auctions/${id}/arrival`, { instructions: SECRET })).status).toBe(200);
    }
    // The lister of space 1 is a host of its auctions too.
    expect((await arrival(LISTER, ids.main)).json).toMatchObject({
      role: 'host', spaceId: '1', auction: { instructions: SECRET }, space: { instructions: SPACE_SECRET }, checkIn: null,
    });
  });

  it('denies every non-host before settlement and outside the window, and after cancellation or refund', async () => {
    await denied(WINNER, ids.main, 'unsettled');
    await chain.increaseTime(600);
    for (const id of [ids.main, ids.early, ids.hostCancelled, ids.late]) await send(as(OTHER).settle(id));
    await send(as(WINNER).cancelBooking(ids.early));
    await send(as(HOST).hostCancelBooking(ids.hostCancelled));
    await send(as(WINNER).cancelBooking(ids.late));
    expect((await escrow.bookings(ids.late)).lateCancelled).toBe(true);

    await denied(WINNER, ids.main, 'too-early');
    await denied(OUTBID, ids.main, 'not-winner');
    await denied(OTHER, ids.main, 'not-winner');
    await denied(WINNER, ids.early, 'cancelled');
    await denied(WINNER, ids.hostCancelled, 'cancelled');
    await denied(WINNER, ids.late, 'cancelled');
    await denied(WINNER, ids.unsettled, 'unsettled');
    expect((await checkIn(WINNER, ids.main)).json.reason).toBe('too-early');
    expect((await checkIn(WINNER, ids.late)).json.reason).toBe('cancelled');
  });

  it('shows the winner the auction instructions, else the space default, inside the window', async () => {
    await chain.increaseTime(S - ARRIVAL_OPENS_BEFORE - (await chain.latestTimestamp()));
    const open = await arrival(WINNER, ids.main);
    expect(open.status).toBe(200);
    expect(open.headers.get('cache-control')).toBe('no-store');
    expect(open.json).toMatchObject({
      role: 'winner', instructions: SECRET, checkIn: null, window: { opensAt: S - ARRIVAL_OPENS_BEFORE, closesAt: E },
    });
    expect(open.json).not.toHaveProperty('space');

    // Clearing the auction's instructions falls back to the space's; a replacement is seen at once.
    expect((await call(HOST, `/api/auctions/${ids.main}/arrival`, { instructions: '' })).json).toEqual({ saved: false });
    expect((await arrival(WINNER, ids.main)).json.instructions).toBe(SPACE_SECRET);
    await call(HOST, `/api/auctions/${ids.main}/arrival`, { instructions: SECRET });
    expect((await arrival(WINNER, ids.main)).json.instructions).toBe(SECRET);
    await denied(OUTBID, ids.main, 'not-winner');
    await denied(OTHER, ids.main, 'not-winner');
  });

  it('records one idempotent check-in for the winner and shows it to the host', async () => {
    expect((await checkIn(WINNER, ids.main)).json.reason).toBe('too-early');
    await chain.increaseTime(S - CHECK_IN_OPENS_BEFORE - (await chain.latestTimestamp()));
    expect((await checkIn(OUTBID, ids.main)).json.reason).toBe('not-winner');
    expect((await checkIn(HOST, ids.main)).json.reason).toBe('not-winner');
    const first = await checkIn(WINNER, ids.main);
    expect(first.status).toBe(201);
    expect(first.json.checkIn).toMatchObject({ winner: chain.wallet(WINNER).address, checkedInAt: expect.any(Number) });
    const again = await checkIn(WINNER, ids.main);
    expect(again.status).toBe(200);
    expect(again.json.checkIn).toEqual(first.json.checkIn);
    expect((await arrival(HOST, ids.main)).json.checkIn).toEqual(first.json.checkIn);
    expect((await arrival(WINNER, ids.main)).json.checkIn).toEqual(first.json.checkIn);
  });

  it('never exposes instructions through public or other private APIs', async () => {
    for (const [index, route] of [
      [null, '/api/listings'], [null, '/api/listings/search'], [OTHER, '/api/listings'],
      [null, `/api/auctions/${ids.main}/events`], [WINNER, '/api/inbox'], [HOST, '/api/drafts'],
    ]) {
      const { text, headers } = await call(index, route);
      noSecret(text);
      expect(headers.get('cache-control')).toBe('no-store');
    }
  });

  it('closes for the winner when parking ends, while the host keeps the record', async () => {
    await chain.increaseTime(E - (await chain.latestTimestamp()));
    await denied(WINNER, ids.main, 'closed');
    expect((await checkIn(WINNER, ids.main)).json.reason).toBe('closed');
    expect((await arrival(HOST, ids.main)).json.checkIn).not.toBeNull();
  });
});
