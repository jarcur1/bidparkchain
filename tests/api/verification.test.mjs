import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp, publicSettings } from '../../server/app.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

// Wallet 1 is a host, wallet 2 another user, wallet 3 a moderator, wallet 4 a moderator who also hosts.
const HOST = 1, OTHER = 2, MOD = 3, MOD_HOST = 4;
const EVIDENCE = 'Utility bill for 12 Elm St, account ref 99-private-ref, phone 555-0100';
const metadata = {
  title: 'Elm St driveway', address: '12 Elm Street', neighborhood: 'Hyde Park',
  latitude: 30.3, longitude: -97.73, description: 'Driveway space next to the house.',
  image: '/images/driveway.jpg', kind: 'driveway', amenities: [],
};
const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(metadata).normalized)));

let scope, chain, deployment, runtime, server, url;
const cookies = {};
const call = async (index, route, body) => {
  const res = await fetch(`${url}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json', ...(index === null ? {} : { cookie: cookies[index] }) },
  });
  return { status: res.status, text: await res.clone().text(), json: await res.json() };
};
const submit = (index, spaceId, evidence = EVIDENCE) => call(index, `/api/spaces/${spaceId}/verification`, { evidence });
const decide = (index, spaceId, action, reason, note) =>
  call(index, `/api/moderation/verifications/${spaceId}`, { action, reason, note });
const listing = async () => (await call(null, '/api/listings')).json.listings.find((l) => l.spaceId === '1');

beforeAll(async () => {
  scope = await createScope('api-verification');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  const host = deployment.contract.connect(chain.wallet(HOST));
  await (await host.registerSpace()).wait(); // space 1
  await (await deployment.contract.connect(chain.wallet(MOD_HOST)).registerSpace()).wait(); // space 2
  const now = await chain.latestTimestamp();
  await (await host.createSpaceAuction(1, metadataHash, ethers.parseEther('0.01'), now + 600, now + 1200, now + 1800)).wait();
  const dataDir = scope.tempDir();
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
    moderators: [chain.wallet(MOD).address, chain.wallet(MOD_HOST).address.toLowerCase()],
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [HOST, OTHER, MOD, MOD_HOST]) cookies[index] = await signInCookie(url, chain.wallet(index));
  expect((await call(HOST, '/api/listings', { auctionId: '1', metadata })).status).toBe(201);
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('rejects an invalid moderator allowlist', () => {
  expect(() => publicSettings({ moderators: 'not-an-address' })).toThrow('Invalid moderator address');
  expect(publicSettings({}, {}).moderators.size).toBe(0);
});

it('requires sign-in and keeps moderation to the allowlist', async () => {
  expect((await call(null, '/api/verifications/mine')).status).toBe(401);
  expect((await submit(null, 1)).status).toBe(401);
  expect((await call(null, '/api/moderation/verifications')).status).toBe(401);
  expect((await call(HOST, '/api/moderation/verifications')).status).toBe(403);
  expect((await decide(HOST, 1, 'approve', 'control-verified')).status).toBe(403);
  expect((await call(HOST, '/api/verifications/mine')).json).toEqual({ moderator: false, verifications: [] });
  expect((await call(MOD, '/api/verifications/mine')).json.moderator).toBe(true);
});

it('lets only the on-chain space owner request verification, with bounded evidence', async () => {
  expect((await submit(OTHER, 1)).status).toBe(403);
  expect((await submit(HOST, 2)).status).toBe(403);
  expect((await submit(HOST, 'abc')).status).toBe(400);
  expect((await submit(HOST, 1, 'too short')).status).toBe(400);
  expect((await submit(HOST, 1, 'x'.repeat(2001))).status).toBe(400);
  const created = await submit(HOST, 1);
  expect(created.status).toBe(201);
  expect(created.json).toMatchObject({ spaceId: '1', status: 'pending', audit: [{ action: 'submit', reason: 'initial-request' }] });
  expect((await submit(HOST, 1)).status).toBe(409);
});

it('never returns evidence outside the moderator queue', async () => {
  for (const [index, route] of [[null, '/api/listings'], [HOST, '/api/verifications/mine'], [OTHER, '/api/listings']]) {
    const { text } = await call(index, route);
    expect(text).not.toContain('99-private-ref');
  }
  expect((await listing()).verification).toBe('unverified');
  const queue = (await call(MOD, '/api/moderation/verifications')).json.queue;
  expect(queue.find((q) => q.spaceId === '1')).toMatchObject({ status: 'pending', evidence: EVIDENCE });
});

it('moves through approve, revoke and re-review with an append-only audit trail', async () => {
  expect((await decide(MOD, 1, 'revoke', 'control-lost')).status).toBe(409);
  expect((await decide(MOD, 1, 'approve', 'made-up')).status).toBe(400);
  expect((await decide(MOD, 1, 'approve', 'control-verified', 'y'.repeat(281))).status).toBe(400);
  expect((await decide(MOD, 1, 'approve', 'control-verified', 'Bill matches address')).json.status).toBe('approved');
  expect((await listing()).verification).toBe('verified');
  expect((await submit(HOST, 1)).status).toBe(409);

  expect((await call(OTHER, '/api/spaces/1/report', { reason: 'fraudulent-listing', note: 'Same photo as space 9' })).status).toBe(201);
  expect((await call(OTHER, '/api/spaces/99/report', { reason: 'fraudulent-listing' })).status).toBe(404);
  expect((await call(OTHER, '/api/spaces/1/report', { reason: 'spam' })).status).toBe(400);

  expect((await decide(MOD, 1, 'revoke', 'fraudulent-listing', 'Report confirmed')).json.status).toBe('suspended');
  expect((await listing()).verification).toBe('unverified');
  // Revoking clears the stored evidence; a re-review needs new evidence.
  expect((await call(MOD, '/api/moderation/verifications')).json.queue[0]).toMatchObject({ spaceId: '1', evidence: '' });
  expect((await submit(HOST, 1, 'New lease covering the driveway')).json.audit.at(-1)).toMatchObject({ reason: 're-review' });
  expect((await decide(MOD, 1, 'reject', 'insufficient-evidence')).json.status).toBe('rejected');

  const mine = (await call(HOST, '/api/verifications/mine')).json.verifications[0];
  expect(mine.status).toBe('rejected');
  // The host sees decisions on their space, but not who reported it.
  expect(mine.audit.map((a) => [a.action, a.status, a.reason])).toEqual([
    ['submit', 'pending', 'initial-request'], ['approve', 'approved', 'control-verified'],
    ['revoke', 'suspended', 'fraudulent-listing'], ['submit', 'pending', 're-review'],
    ['reject', 'rejected', 'insufficient-evidence'],
  ]);
  const full = (await call(MOD, '/api/moderation/verifications')).json.queue[0].audit;
  expect(full.find((a) => a.action === 'report')).toMatchObject({ actor: chain.wallet(OTHER).address, note: 'Same photo as space 9' });
  expect(full.every((a) => typeof a.at === 'number' && ethers.isAddress(a.actor))).toBe(true);

  expect(() => runtime.db.db.exec('UPDATE verification_audit SET reason = \'edited\'')).toThrow('append-only');
  expect(() => runtime.db.db.exec('DELETE FROM verification_audit')).toThrow('append-only');
});

it('does not let a moderator decide on their own space', async () => {
  expect((await submit(MOD_HOST, 2)).status).toBe(201);
  expect((await decide(MOD_HOST, 2, 'approve', 'control-verified')).status).toBe(403);
  expect((await decide(MOD, 2, 'approve', 'control-verified')).status).toBe(200);
});
