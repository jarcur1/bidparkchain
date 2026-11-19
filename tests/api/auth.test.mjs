import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { createScope } from '../support/owned-env.mjs';

const SITE = 'http://127.0.0.1:5173';
const driver = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

let scope, runtime, server, url;
beforeAll(async () => {
  scope = await createScope('api-auth');
  const dataDir = scope.tempDir();
  // Sign-in never touches the chain; the RPC URL is never dialed.
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: path.join(dataDir, 'none.json'), rpcUrl: 'http://127.0.0.1:9' });
  server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  await scope?.close();
});

async function call(route, { body, origin = SITE, cookie } = {}) {
  const response = await fetch(`${url}${route}`, {
    method: body === undefined && !route.endsWith('logout') ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json(), setCookie: response.headers.get('set-cookie') };
}
const requestNonce = async (wallet = driver, origin = SITE) => (await call('/api/auth/nonce', { body: { address: wallet.address }, origin })).json;
const cookieFrom = (setCookie) => setCookie.split(';')[0];

async function signIn() {
  const { nonce, message } = await requestNonce();
  const verified = await call('/api/auth/verify', { body: { nonce, signature: await driver.signMessage(message) } });
  expect(verified.status).toBe(200);
  return cookieFrom(verified.setCookie);
}

it('issues an EIP-4361 message bound to the site, chain and nonce, and starts an HttpOnly session', async () => {
  const { nonce, message } = await requestNonce();
  expect(message).toContain('127.0.0.1:5173 wants you to sign in with your Ethereum account:');
  expect(message).toContain(`\n${driver.address}\n`);
  expect(message).toContain(`URI: ${SITE}`);
  expect(message).toContain('Chain ID: 31337');
  expect(message).toContain(`Nonce: ${nonce}`);
  expect(message).toMatch(/Expiration Time: \d{4}-/);
  expect(message).toContain('does not verify that you control any parking space');

  const verified = await call('/api/auth/verify', { body: { nonce, signature: await driver.signMessage(message) } });
  expect(verified.json).toEqual({ address: driver.address, chainId: 31337, expiresAt: expect.any(Number) });
  expect(verified.setCookie).toMatch(/^bidpark_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=43200$/);
  const session = await call('/api/auth/session', { cookie: cookieFrom(verified.setCookie) });
  expect(session.json.address).toBe(driver.address);
});

it('rejects a signature from another wallet without burning the nonce', async () => {
  const { nonce, message } = await requestNonce();
  const wrong = await call('/api/auth/verify', { body: { nonce, signature: await stranger.signMessage(message) } });
  expect(wrong).toMatchObject({ status: 401, json: { error: 'The signature does not match the wallet address.' } });
  expect((await call('/api/auth/verify', { body: { nonce, signature: '0x1234' } })).status).toBe(401);
  expect((await call('/api/auth/verify', { body: { nonce, signature: await driver.signMessage(message) } })).status).toBe(200);
});

it('refuses to replay a used nonce and signature', async () => {
  const { nonce, message } = await requestNonce();
  const signature = await driver.signMessage(message);
  expect((await call('/api/auth/verify', { body: { nonce, signature } })).status).toBe(200);
  const replay = await call('/api/auth/verify', { body: { nonce, signature } });
  expect(replay).toMatchObject({ status: 401, json: { error: expect.stringContaining('already used') } });
  expect(replay.setCookie).toBeNull();
});

it('refuses a sign-in request used from another origin, or after it expires', async () => {
  let { nonce, message } = await requestNonce();
  const elsewhere = await call('/api/auth/verify', { body: { nonce, signature: await driver.signMessage(message) }, origin: 'http://evil.test' });
  expect(elsewhere.json.error).toContain('different site');

  ({ nonce, message } = await requestNonce());
  runtime.db.db.prepare('UPDATE auth_nonces SET expires_at = ? WHERE nonce = ?').run(Date.now() - 1, nonce);
  const late = await call('/api/auth/verify', { body: { nonce, signature: await driver.signMessage(message) } });
  expect(late.json.error).toContain('expired');
});

it('ends sessions on expiry, on logout, and outside their origin', async () => {
  const cookie = await signIn();
  expect((await call('/api/auth/session', { cookie, origin: 'http://localhost:5173' })).status).toBe(401);

  runtime.db.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
  expect((await call('/api/auth/session', { cookie })).status).toBe(401);

  const fresh = await signIn();
  expect((await call('/api/auth/session', { cookie: fresh })).status).toBe(200);
  const out = await call('/api/auth/logout', { cookie: fresh });
  expect(out.setCookie).toContain('Max-Age=0');
  expect((await call('/api/auth/session', { cookie: fresh })).status).toBe(401);
  expect((await call('/api/auth/session')).status).toBe(401);
});

it('validates the address and stores only token hashes', async () => {
  expect((await call('/api/auth/nonce', { body: { address: 'not-an-address' } })).status).toBe(400);
  const cookie = await signIn();
  const token = cookie.split('=')[1];
  const stored = runtime.db.db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
  expect(stored).not.toContain(token);
  expect(stored.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
});

it('keeps a minimal driver/host profile for the signed-in wallet only', async () => {
  expect((await call('/api/profile')).status).toBe(401);
  expect((await call('/api/profile', { body: { role: 'host' } })).status).toBe(401);
  const cookie = await signIn();
  expect((await call('/api/profile', { cookie })).json).toEqual({ profile: null });
  expect((await call('/api/profile', { cookie, body: { role: 'owner' } })).status).toBe(400);
  expect((await call('/api/profile', { cookie, body: { role: 'host', displayName: 'x'.repeat(41) } })).status).toBe(400);
  const saved = await call('/api/profile', { cookie, body: { role: 'both', displayName: '  Sam  ' } });
  expect(saved.json).toEqual({ profile: { role: 'both', displayName: 'Sam' } });
  expect((await call('/api/profile', { cookie })).json.profile).toEqual({ role: 'both', displayName: 'Sam' });

  // Another wallet starts with its own empty profile.
  const { nonce, message } = await requestNonce(stranger);
  const other = await call('/api/auth/verify', { body: { nonce, signature: await stranger.signMessage(message) } });
  expect((await call('/api/profile', { cookie: cookieFrom(other.setCookie) })).json).toEqual({ profile: null });
});
