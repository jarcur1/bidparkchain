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

it('keeps a review tied to the period when proof was submitted, even when the same host regains ownership', async () => {
  const host = deployment.contract.connect(chain.wallet(HOST));
  const other = deployment.contract.connect(chain.wallet(OTHER));
  await (await host.registerSpace()).wait();
  const spaceId = 3;
  const route = `/api/moderation/verifications/${spaceId}/attestation`;
  expect((await submit(HOST, spaceId)).status).toBe(201);
  expect((await decide(MOD, spaceId, 'approve', 'control-verified')).status).toBe(200);
  expect((await call(OTHER, route)).status).toBe(403);
  const reviewed = (await call(MOD, route)).json;
  expect(reviewed).toMatchObject({ action: 'approve', epoch: String(await host.spaceOwnershipEpoch(spaceId)) });
  await (await host.transferSpace(spaceId, chain.wallet(OTHER).address)).wait();
  await (await other.transferSpace(spaceId, chain.wallet(HOST).address)).wait();
  expect((await call(MOD, route)).json.epoch).toBe(reviewed.epoch);
  expect((await submit(HOST, spaceId, 'New lease after transfer')).status).toBe(201);
  expect((await call(MOD, route)).json).toMatchObject({ action: null, epoch: String(await host.spaceOwnershipEpoch(spaceId)) });
});

it('lets the host of a rejected space leave one appeal note that moderators see', async () => {
  const route = '/api/spaces/1/appeal';
  const note = 'The lease covers the driveway, uploading the signed page now';
  expect((await call(null, route, { note })).status).toBe(401);
  expect((await call(OTHER, route, { note })).status).toBe(403);
  expect((await call(HOST, route, { note: 'short' })).status).toBe(400);
  expect((await call(MOD_HOST, '/api/spaces/2/appeal', { note })).status).toBe(409); // approved, nothing to appeal
  const sent = await call(HOST, route, { note });
  expect(sent.status).toBe(201);
  expect(sent.json).toMatchObject({ status: 'rejected' });
  expect(sent.json.audit.at(-1)).toMatchObject({ action: 'appeal', reason: 'host-appeal', note });
  expect((await call(HOST, route, { note })).status).toBe(409);
  const queued = (await call(MOD, '/api/moderation/verifications')).json.queue.find((q) => q.spaceId === '1');
  expect(queued).toMatchObject({ status: 'rejected' });
  expect(queued.audit.at(-1)).toMatchObject({ action: 'appeal', note });
  // New proof reopens the review, and a rejected space can be appealed again after the next decision.
  expect((await submit(HOST, 1, 'Signed lease page attached to the request')).status).toBe(201);
  expect((await decide(MOD, 1, 'reject', 'insufficient-evidence')).status).toBe(200);
  expect((await call(HOST, route, { note })).status).toBe(201);
});

it('warns about and flags a space at the same address under another host', async () => {
  const other = deployment.contract.connect(chain.wallet(OTHER));
  const hostContract = deployment.contract.connect(chain.wallet(HOST));
  await (await other.registerSpace()).wait(); // space 4
  await (await hostContract.registerSpace()).wait(); // space 5
  const now = await chain.latestTimestamp();
  const list = async (contract, spaceId, details, from) => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(details).normalized)));
    await (await contract.createSpaceAuction(spaceId, hash, ethers.parseEther('0.01'), now + from, now + from + 600, now + from + 1200)).wait();
    return String(Number(await contract.nextAuctionId()) - 1);
  };
  const alias = { ...metadata, title: 'Spot behind the house', address: '12 ELM ST., Apt 3' };
  const second = { ...metadata, title: 'Second stall', address: '12 Elm Street #B' };
  const aliasAuction = await list(other, 4, alias, 3000);
  const secondAuction = await list(hostContract, 5, second, 4000);

  // Space 1 belongs to another host and shares the normalized address and the location.
  const first = await call(OTHER, '/api/listings', { auctionId: aliasAuction, metadata: alias });
  expect(first.status).toBe(201);
  expect(first.json.duplicateSpaces).toEqual([{ spaceId: '1', match: ['address', 'location'] }]);
  await call(OTHER, '/api/listings', { auctionId: aliasAuction, metadata: alias }); // no second flag
  const queue = (await call(MOD, '/api/moderation/verifications')).json.queue;
  const flags = (id) => queue.find((q) => q.spaceId === String(id)).audit.filter((a) => a.actor === 'system');
  expect(flags(4)).toEqual([expect.objectContaining({ action: 'report', reason: 'duplicate-listing', note: 'Possible duplicate of space #1 (same address and location)' })]);
  expect(flags(1)).toEqual([expect.objectContaining({ note: 'Possible duplicate of space #4 (same address and location)' })]);

  // The host's own space 1 is not a duplicate of space 5; only the other host's space 4 is.
  const mine = await call(HOST, '/api/listings', { auctionId: secondAuction, metadata: second });
  expect(mine.json.duplicateSpaces).toEqual([{ spaceId: '4', match: ['address', 'location'] }]);
  // Hosts never see the system flags in their own history.
  const history = (await call(HOST, '/api/verifications/mine')).json.verifications.find((v) => v.spaceId === '1').audit;
  expect(history.some((a) => a.actor === 'system')).toBe(false);
});

it('does not carry an approval or address alias over to the wallet a reorg hands the space id to', async () => {
  const [A, B, C] = [5, 6, 7];
  for (const index of [A, B, C]) cookies[index] ??= await signInCookie(url, chain.wallet(index));
  const as = (index) => deployment.contract.connect(chain.wallet(index));
  const spot = { ...metadata, title: 'Oak garage', address: '77 Oak Avenue', latitude: 30.31, longitude: -97.71 };
  const spotHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(spot).normalized)));
  const list = async (index, spaceId) => {
    const now = await chain.latestTimestamp();
    await (await as(index).createSpaceAuction(spaceId, spotHash, ethers.parseEther('0.01'), now + 9000, now + 9600, now + 10200)).wait();
    return String(Number(await deployment.contract.nextAuctionId()) - 1);
  };
  const badge = async (spaceId) => (await call(null, '/api/listings')).json.listings.find((l) => l.spaceId === spaceId)?.verification;
  const systemFlags = async (spaceId) => (await call(MOD, '/api/moderation/verifications?limit=100')).json.queue
    .find((q) => q.spaceId === spaceId)?.audit.filter((a) => a.actor === 'system') ?? [];

  const snapshot = await chain.provider.send('evm_snapshot', []);
  const spaceId = String(await deployment.contract.nextSpaceId());
  await (await as(A).registerSpace()).wait();
  const auctionId = await list(A, spaceId);
  expect((await call(A, '/api/listings', { auctionId, metadata: spot })).status).toBe(201);
  expect((await submit(A, spaceId, 'Deed for 77 Oak Avenue garage')).status).toBe(201);
  expect((await decide(MOD, spaceId, 'approve', 'control-verified')).status).toBe(200);
  expect(await badge(spaceId)).toBe('verified');

  // The replacement chain gives the same space id to B, who never listed at A's address.
  expect(await chain.provider.send('evm_revert', [snapshot])).toBe(true);
  await (await as(B).registerSpace()).wait();
  expect(await deployment.contract.spaceOwner(spaceId)).toBe(chain.wallet(B).address);
  const flagsBefore = await systemFlags(spaceId);

  // A third host at A's old address is not told it duplicates B's space, and B's space gets no flag.
  const elsewhere = String(await deployment.contract.nextSpaceId());
  await (await as(C).registerSpace()).wait();
  const cAuction = await list(C, elsewhere);
  const registered = await call(C, '/api/listings', { auctionId: cAuction, metadata: spot });
  expect([200, 201]).toContain(registered.status); // the auction id and metadata row may match A's abandoned one
  expect(registered.json.duplicateSpaces).toEqual([]);
  expect(await systemFlags(spaceId)).toEqual(flagsBefore);

  // A's approval is not B's: B's listing is unverified and B can ask for review of the space.
  const bAuction = await list(B, spaceId);
  const bSpot = await call(B, '/api/listings', { auctionId: bAuction, metadata: spot });
  expect(bSpot.json.listing.verification).toBe('unverified');
  expect(bSpot.json.duplicateSpaces).toEqual([{ spaceId: elsewhere, match: ['address', 'location'] }]);
  expect((await submit(B, spaceId, 'Lease for the Oak garage, signed by B')).status).toBe(201);
});
