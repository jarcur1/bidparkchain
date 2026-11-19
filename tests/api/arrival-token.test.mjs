import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { CHECK_IN_OPENS_BEFORE } from '../../server/arrival.mjs';
import { TOKEN_TTL } from '../../server/arrival-token.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const HOST = 1, WINNER = 2, OTHER = 4;
const DAY = 24 * 3600;
const hash = ethers.id('arrival-token-test');

let scope, chain, deployment, escrow, runtime, server, url, S;
const cookies = {};
const ids = {};

const call = async (index, route, body) => {
  const res = await fetch(`${url}${route}`, {
    method: 'POST', body: JSON.stringify(body ?? {}),
    headers: { 'Content-Type': 'application/json', cookie: cookies[index] },
  });
  return { status: res.status, json: await res.json() };
};
const issue = (index, id) => call(index, `/api/auctions/${id}/arrival-token`);
const verify = (index, id, token) => call(index, `/api/auctions/${id}/arrival/verify`, { token });
const as = (index) => escrow.connect(chain.wallet(index));
const send = async (promise) => (await promise).wait();
const toCheckIn = async () => chain.increaseTime(S - CHECK_IN_OPENS_BEFORE + 60 - (await chain.latestTimestamp()));

beforeAll(async () => {
  scope = await createScope('api-arrival-token');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  escrow = deployment.contract;
  const B = (await chain.latestTimestamp()) + 600;
  S = B + 3 * DAY;
  for (const name of ['main', 'expired', 'revoked']) {
    ids[name] = (await escrow.nextAuctionId()).toString();
    await send(as(HOST).createProtectedAuction(0, hash, ethers.parseEther('0.01'), B, S, S + 4 * 3600));
    await send(as(WINNER).bid(ids[name], { value: ethers.parseEther('0.02') }));
  }
  const dataDir = scope.tempDir();
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const i of [HOST, WINNER, OTHER]) cookies[i] = await signInCookie(url, chain.wallet(i));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

describe('one-use arrival tokens', () => {
  it('refuses a token before settlement, before the window, and to anyone but the winner', async () => {
    expect((await issue(WINNER, ids.main)).json.reason).toBe('unsettled');
    await chain.increaseTime(600);
    for (const id of Object.values(ids)) await send(as(OTHER).settle(id));
    expect((await issue(WINNER, ids.main)).json.reason).toBe('too-early');
    await toCheckIn();
    expect((await issue(OTHER, ids.main)).json.reason).toBe('not-winner');
    expect((await issue(HOST, ids.main)).json.reason).toBe('not-winner');
  });

  it('lets the host verify a token once, records the check-in, and rejects a replay', async () => {
    const { status, json } = await issue(WINNER, ids.main);
    expect(status).toBe(200);
    expect(json.expiresAt).toBeLessThanOrEqual((await chain.latestTimestamp()) + TOKEN_TTL + 5);
    const { token } = json;

    expect((await verify(WINNER, ids.main, token)).status).toBe(403);
    expect((await verify(OTHER, ids.main, token)).status).toBe(403);
    expect((await verify(HOST, ids.main, token + 'x')).json.reason).toBe('invalid');
    expect((await verify(HOST, ids.main, 'bp1.e30.AAAA')).json.reason).toBe('invalid');
    expect((await verify(HOST, ids.main, undefined)).status).toBe(400);
    // Bound to its auction.
    expect((await verify(HOST, ids.expired, token)).json.reason).toBe('invalid');

    const first = await verify(HOST, ids.main, token);
    expect(first.status).toBe(201);
    expect(first.json.checkIn).toMatchObject({ winner: chain.wallet(WINNER).address, verifiedBy: chain.wallet(HOST).address });
    const again = await verify(HOST, ids.main, token);
    expect(again.status).toBe(409);
    expect(again.json.reason).toBe('replayed');

    // A fresh token for an already verified auction returns the same record.
    const second = await verify(HOST, ids.main, (await issue(WINNER, ids.main)).json.token);
    expect(second.status).toBe(200);
    expect(second.json.checkIn).toEqual(first.json.checkIn);
    expect((await call(WINNER, `/api/auctions/${ids.main}/check-in`)).json.checkIn).toEqual(first.json.checkIn);
  });

  it('rejects an expired token, and one whose reservation was cancelled after it was issued', async () => {
    const old = (await issue(WINNER, ids.expired)).json.token;
    const revoked = (await issue(WINNER, ids.revoked)).json.token;
    await send(as(WINNER).cancelBooking(ids.revoked));
    expect((await verify(HOST, ids.revoked, revoked)).json.reason).toBe('cancelled');
    await chain.increaseTime(TOKEN_TTL + 60);
    const res = await verify(HOST, ids.expired, old);
    expect(res.status).toBe(410);
    expect(res.json.reason).toBe('expired');
  });
});
