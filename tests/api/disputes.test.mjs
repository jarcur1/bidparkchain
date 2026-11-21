import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { disputeReference } from '../../server/disputes.mjs';
import { signInCookie } from '../support/auth.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';

const HOUR = 3600;
let scope, chain, deployment, runtime, server, url, c;
const cookies = {};
const as = (index) => ({ cookie: cookies[index], 'Content-Type': 'application/json' });
const post = (route, index, body) => fetch(`${url}${route}`, { method: 'POST', headers: as(index), body: JSON.stringify(body) });
const get = (route, index) => fetch(`${url}${route}`, { headers: index === undefined ? {} : as(index) });
// 0 host (and deployer), 1 winner, 2 other driver, 3 resolver
const [HOST, WINNER, OTHER, RESOLVER] = [0, 1, 2, 3];

async function settledAuction({ afterParking = true } = {}) {
  const now = await chain.latestTimestamp();
  const id = (await c.nextAuctionId()).toString();
  await (await c.createProtectedAuction(0, ethers.id(`d-${id}`), ethers.parseEther('0.01'), now + 600, now + 2400, now + 6000)).wait();
  await (await c.connect(chain.wallet(WINNER)).bid(id, { value: ethers.parseEther('0.02') })).wait();
  await chain.increaseTime(700);
  await (await c.settle(id)).wait();
  if (afterParking) await chain.increaseTime(6000);
  return id;
}

beforeAll(async () => {
  scope = await createScope('api-disputes');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  c = deployment.contract;
  await (await c.setResolver(chain.wallet(RESOLVER).address, true)).wait();
  const dataDir = scope.tempDir();
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [HOST, WINNER, OTHER, RESOLVER]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('requires a session and rejects unknown, unprotected and malformed requests', async () => {
  expect((await get('/api/auctions/1/dispute')).status).toBe(401);
  expect((await get('/api/disputes/queue')).status).toBe(401);
  expect((await post('/api/auctions/x/dispute/evidence', WINNER, {})).status).toBe(400);
  expect((await post('/api/auctions/999/dispute/evidence', WINNER, { text: 'x'.repeat(20) })).status).toBe(404);
  const now = await chain.latestTimestamp();
  await (await c.createAuction(ethers.id('plain'), ethers.parseEther('0.01'), now + 600, now + 1200, now + 1800)).wait();
  const plain = (await c.nextAuctionId()) - 1n;
  expect((await post(`/api/auctions/${plain}/dispute/evidence`, WINNER, { text: 'x'.repeat(20) })).status).toBe(409);
  const id = await settledAuction();
  expect((await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text: 'short' })).status).toBe(400);
  expect((await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text: 'x'.repeat(2001) })).status).toBe(400);
});

it('stores evidence for the parties only, with a reference the chain accepts and an audit trail', async () => {
  const id = await settledAuction();
  const text = 'Gate was locked; photo https://example.com/gate.jpg';
  expect((await post(`/api/auctions/${id}/dispute/evidence`, OTHER, { text })).status).toBe(403);
  const res = await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text });
  expect(res.status).toBe(201);
  const { reference, createdAt } = await res.json();
  expect(reference).toBe(disputeReference({
    chainId: 31337, contract: deployment.address, auctionId: id, kind: 'report', author: chain.wallet(WINNER).address, uphold: null, body: text, createdAt,
  }));

  expect((await get(`/api/auctions/${id}/dispute`, OTHER)).status).toBe(403);
  expect((await get(`/api/auctions/${id}/dispute`)).status).toBe(401);
  await (await c.connect(chain.wallet(WINNER)).reportSellerFailure(id, reference)).wait();
  const seen = await (await get(`/api/auctions/${id}/dispute`, HOST)).json();
  expect(seen).toMatchObject({ open: true, reporter: chain.wallet(WINNER).address, openReference: reference });
  expect(seen.records).toEqual([expect.objectContaining({ kind: 'report', body: text, reference })]);
  expect((await get(`/api/auctions/${id}/dispute`, RESOLVER)).status).toBe(200);
  // A second report cannot be filed while one is open.
  expect((await post(`/api/auctions/${id}/dispute/evidence`, HOST, { text })).status).toBe(409);
  const audit = (await (await get(`/api/auctions/${id}/dispute`, WINNER)).json()).audit;
  expect(audit.map((a) => [a.action, a.actor])).toEqual([
    ['submit-report', chain.wallet(WINNER).address.toLowerCase()],
    ['view', chain.wallet(HOST).address.toLowerCase()],
    ['view', chain.wallet(RESOLVER).address.toLowerCase()],
    ['view', chain.wallet(WINNER).address.toLowerCase()],
  ]);
});

it('lets only a non-party resolver store a decision, and lists open reports in the resolver queue', async () => {
  const id = await settledAuction();
  const { reference } = await (await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text: 'The space was occupied by another car.' })).json();
  const decide = (index, body) => post(`/api/auctions/${id}/dispute/decision`, index, body);
  // No open report yet: nothing to decide.
  expect((await decide(RESOLVER, { uphold: true, reason: 'x'.repeat(12) })).status).toBe(409);
  await (await c.connect(chain.wallet(WINNER)).reportSellerFailure(id, reference)).wait();

  expect((await decide(OTHER, { uphold: true, reason: 'x'.repeat(12) })).status).toBe(403);
  expect((await decide(RESOLVER, { uphold: 'yes', reason: 'x'.repeat(12) })).status).toBe(400);
  expect((await decide(RESOLVER, { uphold: true, reason: 'no' })).status).toBe(400);

  expect((await get('/api/disputes/queue', OTHER)).status).toBe(403);
  const queue = (await (await get('/api/disputes/queue', RESOLVER)).json()).items;
  const item = queue.find((entry) => entry.auctionId === id);
  expect(item).toMatchObject({ reporter: chain.wallet(WINNER).address, hasRecord: true, isParty: false, action: 'resolveDispute' });
  expect(item.resolveBy - item.parkingEnd).toBe(72 * HOUR);

  const made = await decide(RESOLVER, { uphold: true, reason: 'Photo shows the space occupied.' });
  expect(made.status).toBe(201);
  await (await c.connect(chain.wallet(RESOLVER)).resolveDispute(id, true, (await made.json()).reference)).wait();
  expect((await (await get('/api/disputes/queue', RESOLVER)).json()).items.some((entry) => entry.auctionId === id)).toBe(false);
  const record = await (await get(`/api/auctions/${id}/dispute`, WINNER)).json();
  expect(record.open).toBe(false);
  expect(record.records.map((r) => [r.kind, r.uphold])).toEqual([['report', null], ['decision', true]]);
});

it('closes the channel with the on-chain windows and switches the queue to expireDispute', async () => {
  const id = await settledAuction();
  const { reference } = await (await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text: 'Entrance blocked by a barrier.' })).json();
  await (await c.connect(chain.wallet(WINNER)).reportSellerFailure(id, reference)).wait();
  await chain.increaseTime(72 * HOUR);
  expect((await post(`/api/auctions/${id}/dispute/decision`, RESOLVER, { uphold: false, reason: 'Too late to decide.' })).status).toBe(409);
  const item = (await (await get('/api/disputes/queue', RESOLVER)).json()).items.find((entry) => entry.auctionId === id);
  expect(item.action).toBe('expireDispute');

  const late = await settledAuction();
  await chain.increaseTime(25 * HOUR);
  expect((await post(`/api/auctions/${late}/dispute/evidence`, WINNER, { text: 'Reporting after the window.' })).status).toBe(409);
});

it('keeps records and the audit log append-only', () => {
  const { db } = runtime;
  expect(() => db.db.exec('UPDATE dispute_records SET body = 1')).toThrow(/append-only/);
  expect(() => db.db.exec('DELETE FROM dispute_records')).toThrow(/append-only/);
  expect(() => db.db.exec('UPDATE dispute_audit SET actor = 1')).toThrow(/append-only/);
  expect(() => db.db.exec('DELETE FROM dispute_audit')).toThrow(/append-only/);
});

it('pages the resolver queue in auction id order without repeating or dropping reports', async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const id = await settledAuction();
    const { reference } = await (await post(`/api/auctions/${id}/dispute/evidence`, WINNER, { text: `Space ${i} was occupied.` })).json();
    await (await c.connect(chain.wallet(WINNER)).reportSellerFailure(id, reference)).wait();
    ids.push(id);
  }
  const full = await (await get('/api/disputes/queue?limit=100', RESOLVER)).json();
  expect(full.nextAfter).toBeNull();
  const pages = [];
  let after = null;
  do {
    const page = await (await get(`/api/disputes/queue?limit=2${after === null ? '' : `&after=${after}`}`, RESOLVER)).json();
    pages.push(page);
    after = page.nextAfter;
  } while (after !== null);
  const paged = pages.flatMap((page) => page.items.map((entry) => entry.auctionId));
  const numeric = paged.map(Number);
  expect(pages.length).toBeGreaterThan(1);
  expect(paged).toEqual(full.items.map((entry) => entry.auctionId));
  expect(new Set(paged).size).toBe(paged.length);
  expect(numeric).toEqual([...numeric].sort((a, b) => a - b));
  expect(paged).toEqual(expect.arrayContaining(ids));
  // A report closed between two page loads must not shift the next page.
  const first = await (await get('/api/disputes/queue?limit=1', RESOLVER)).json();
  const rest = await (await get(`/api/disputes/queue?limit=100&after=${first.nextAfter}`, RESOLVER)).json();
  expect(rest.items.map((entry) => entry.auctionId)).toEqual(paged.slice(1));
  // Invalid parameters are rejected, never silently defaulted.
  for (const q of ['limit=0', 'limit=101', 'limit=-5', 'limit=abc', 'limit=1.5', 'after=-3', 'after=x', 'after=99999999999999999999']) {
    expect((await get(`/api/disputes/queue?${q}`, RESOLVER)).status, q).toBe(400);
  }
});
