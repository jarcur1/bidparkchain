import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WEB_CSP } from '../../server/app.mjs';
import { serve } from '../../server/index.mjs';
import { createScope } from '../support/owned-env.mjs';

let scope;
beforeAll(async () => { scope = await createScope('api-hosted'); });
afterAll(async () => { await scope?.close(); });

it('serves the built web app and the API from one origin, with no RPC proxy', async () => {
  const dataDir = scope.tempDir();
  const webDir = scope.tempDir();
  fs.mkdirSync(path.join(webDir, 'assets'));
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>BidPark</title>');
  fs.writeFileSync(path.join(webDir, 'assets', 'index-abc123.js'), 'console.log(1)');
  const api = serve({
    port: 0, indexIntervalMs: 0, webDir, allowedOrigins: ['https://staging.bidpark.example'],
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: path.join(dataDir, 'none.json'), rpcUrl: 'http://127.0.0.1:9',
  });
  await once(api.server, 'listening');
  const url = `http://127.0.0.1:${api.server.address().port}`;
  try {
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>BidPark</title>');
    expect(page.headers.get('content-security-policy')).toBe(WEB_CSP);
    expect(page.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`${url}/assets/index-abc123.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // Client-side routes fall back to the app; API routes never do.
    expect(await (await fetch(`${url}/activity`)).text()).toContain('<title>BidPark</title>');
    const missing = await fetch(`${url}/api/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'API route GET /nope not found' });
    expect((await fetch(`${url}/api/health/live`)).headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");

    // There is no JSON-RPC endpoint on the hosted origin.
    const rpc = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_accounts"}' });
    expect(rpc.status).toBe(404);
  } finally {
    await api.close();
  }
});
