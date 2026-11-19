import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp, publicSettings } from '../../server/app.mjs';
import { createScope } from '../support/owned-env.mjs';

const SITE = 'https://staging.bidpark.example';
let scope;
beforeAll(async () => { scope = await createScope('api-hardening'); });
afterAll(async () => { await scope?.close(); });

async function withApi(options, run) {
  const dataDir = scope.tempDir();
  const runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: path.join(dataDir, 'none.json'), rpcUrl: 'http://127.0.0.1:9', ...options });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.db.close();
    runtime.provider.destroy();
  }
}
const post = (url, route, origin) => fetch(`${url}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: '{}',
});

it('validates hosted origins and keeps local defaults when none are configured', () => {
  expect(publicSettings({}, {})).toMatchObject({ hosted: false, writesPerMinute: 0, rpcTimeoutMs: 10_000 });
  expect(publicSettings({}, { BIDPARK_ALLOWED_ORIGINS: `${SITE}, http://localhost:4173` })).toMatchObject({ hosted: true, writesPerMinute: 60 });
  expect(() => publicSettings({ allowedOrigins: ['http://staging.bidpark.example'] })).toThrow(/https/);
  expect(() => publicSettings({ allowedOrigins: [`${SITE}/path`] })).toThrow(/exact/);
  expect(() => publicSettings({ allowedOrigins: ['*'] })).toThrow(/Invalid allowed origin/);
});

it('sends safe headers and caps URL length in every mode', async () => {
  await withApi({}, async (url) => {
    const response = await fetch(`${url}/api/health/live`);
    expect(Object.fromEntries(['x-content-type-options', 'referrer-policy', 'x-frame-options', 'cache-control', 'content-security-policy', 'x-powered-by']
      .map((h) => [h, response.headers.get(h)]))).toEqual({
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-powered-by': null,
    });
    expect((await fetch(`${url}/api/health/live?q=${'x'.repeat(3000)}`)).status).toBe(414);
  });
});

it('in hosted mode, gives CORS only to exact origins, refuses cross-site writes, and limits write rate', async () => {
  await withApi({ allowedOrigins: [SITE], writesPerMinute: 3 }, async (url) => {
    const allowed = await fetch(`${url}/api/health/live`, { headers: { Origin: SITE } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(SITE);
    const local = await fetch(`${url}/api/health/live`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(local.headers.get('access-control-allow-origin')).toBeNull();

    expect((await post(url, '/api/listings/stage', 'https://evil.example')).status).toBe(403);
    // Same-site write: passes the origin check and reaches auth (not signed in).
    // The refused cross-site write is not counted; three writes per minute are allowed, the fourth is not.
    for (let i = 0; i < 3; i++) expect((await post(url, '/api/listings/stage', SITE)).status).toBe(401);
    const limited = await post(url, '/api/listings/stage', SITE);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Reads are never rate-limited.
    expect((await fetch(`${url}/api/health/live`)).status).toBe(200);
  });
});

it('bounds RPC calls so a stalled node cannot hold requests open', async () => {
  const stalled = http.createServer(() => { /* never answers */ });
  stalled.listen(0, '127.0.0.1');
  await once(stalled, 'listening');
  try {
    await withApi({ rpcUrl: `http://127.0.0.1:${stalled.address().port}`, rpcTimeoutMs: 300 }, async (url) => {
      const started = Date.now();
      const ready = await (await fetch(`${url}/api/health/ready`)).json();
      expect(ready.checks.chain).not.toBe('ok');
      expect(Date.now() - started).toBeLessThan(4000);
    });
  } finally {
    stalled.closeAllConnections();
    await new Promise((resolve) => stalled.close(resolve));
  }
});
