import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

// Wallet 1 and 2 host; wallet 3 is a moderator.
const HOST = 1, OTHER = 2, MOD = 3;
const draft = {
  kind: 'draft', name: 'Elm St Friday', title: 'Elm St driveway', address: '12 Elm Street', description: 'Driveway.',
  image: 'https://images.example.com/elm.jpg', minBidEth: '0.05', spaceId: '1',
  cutoff: '2030-03-01T22:30', start: '2030-03-02T00:00', end: '2030-03-02T08:00',
};

let scope, chain, deployment, runtime, server, url;
const cookies = {};
const call = async (index, route, { method = 'GET', body } = {}) => {
  const res = await fetch(`${url}${route}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json', ...(index === null ? {} : { cookie: cookies[index] }) },
  });
  return { status: res.status, json: await res.json() };
};

beforeAll(async () => {
  scope = await createScope('api-drafts');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  for (let i = 0; i < 3; i++) await (await deployment.contract.connect(chain.wallet(HOST)).registerSpace()).wait();
  const dataDir = scope.tempDir();
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
    moderators: [chain.wallet(MOD).address],
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [HOST, OTHER, MOD]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('requires a session to read or write drafts', async () => {
  expect((await call(null, '/api/drafts')).status).toBe(401);
  expect((await call(null, '/api/drafts', { method: 'POST', body: draft })).status).toBe(401);
  expect((await call(null, '/api/drafts/1', { method: 'DELETE' })).status).toBe(401);
});

it('saves, reloads, edits and deletes a draft, privately per wallet', async () => {
  const created = await call(HOST, '/api/drafts', { method: 'POST', body: draft });
  expect(created.status).toBe(201);
  const { id } = created.json;

  const listed = (await call(HOST, '/api/drafts')).json.drafts;
  expect(listed).toEqual([expect.objectContaining({ id, kind: 'draft', name: 'Elm St Friday', cutoff: draft.cutoff, end: draft.end })]);
  expect((await call(OTHER, '/api/drafts')).json.drafts).toEqual([]);

  // Another wallet can neither overwrite nor delete it.
  expect((await call(OTHER, '/api/drafts', { method: 'POST', body: { ...draft, id, name: 'stolen' } })).status).toBe(404);
  expect((await call(OTHER, `/api/drafts/${id}`, { method: 'DELETE' })).status).toBe(404);
  expect((await call(HOST, '/api/drafts')).json.drafts[0].name).toBe('Elm St Friday');

  const edited = await call(HOST, '/api/drafts', { method: 'POST', body: { ...draft, id, kind: 'template', name: 'Elm St template', end: '' } });
  expect(edited.status).toBe(200);
  expect((await call(HOST, '/api/drafts')).json.drafts).toEqual([expect.objectContaining({ id, kind: 'template', end: '' })]);

  expect((await call(HOST, `/api/drafts/${id}`, { method: 'DELETE' })).status).toBe(200);
  expect((await call(HOST, '/api/drafts')).json.drafts).toEqual([]);
});

it('accepts only https or safe local photo references and well-formed fields', async () => {
  for (const image of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://example.com/a.jpg', '//evil.example/a.jpg', 'file:///etc/passwd', '/a b.jpg']) {
    const res = await call(HOST, '/api/drafts', { method: 'POST', body: { ...draft, image } });
    expect(res.status, image).toBe(400);
    expect(res.json.error).toContain('Photo');
  }
  expect((await call(HOST, '/api/drafts', { method: 'POST', body: { ...draft, image: '/images/driveway.jpg' } })).status).toBe(201);
  for (const bad of [{ cutoff: 'tomorrow' }, { minBidEth: '-1' }, { spaceId: '0' }, { spotKind: 'rooftop' }, { name: '' }, { kind: 'other' }, { amenities: 'x' }]) {
    expect((await call(HOST, '/api/drafts', { method: 'POST', body: { ...draft, ...bad } })).status, JSON.stringify(bad)).toBe(400);
  }
  expect((await call(HOST, '/api/drafts', { method: 'POST', body: { ...draft, description: 'x'.repeat(2001) } })).status).toBe(400);
});

it('pages the moderation queue', async () => {
  for (const spaceId of [1, 2, 3]) {
    const res = await call(OTHER, `/api/spaces/${spaceId}/report`, { method: 'POST', body: { reason: 'fraudulent-listing' } });
    expect(res.status).toBe(201);
  }
  const first = (await call(MOD, '/api/moderation/verifications?limit=2')).json;
  expect(first.total).toBe(3);
  expect(first.queue).toHaveLength(2);
  expect(first.nextOffset).toBe(2);
  const second = (await call(MOD, `/api/moderation/verifications?limit=2&offset=${first.nextOffset}`)).json;
  expect(second.queue).toHaveLength(1);
  expect(second.nextOffset).toBeNull();
  const seen = [...first.queue, ...second.queue].map((q) => q.spaceId).sort();
  expect(seen).toEqual(['1', '2', '3']);
  expect((await call(OTHER, '/api/moderation/verifications')).status).toBe(403);
});
