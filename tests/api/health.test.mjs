import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';

let scope, chain, deployment;
beforeAll(async () => {
  scope = await createScope('api-health');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
});
afterAll(async () => {
  chain?.provider.destroy();
  await scope?.close();
});

async function withApi(options, run) {
  const dataDir = scope.tempDir();
  const runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl, ...options(dataDir) });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const get = async (route) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, json: await response.json() };
  };
  try {
    await run(get, runtime);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (runtime.db.db.isOpen) runtime.db.close();
    runtime.provider.destroy();
  }
}

it('separates liveness from readiness, and checks index freshness only when configured', async () => {
  await withApi(() => ({ maxIndexLag: 0 }), async (get, runtime) => {
    expect(await get('/api/health/live')).toMatchObject({ status: 200, json: { live: true } });
    let ready = await get('/api/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.json).toMatchObject({
      ready: false, profile: 'local', chainId: 31337, contractAddress: deployment.address,
      checks: { database: 'ok', chain: 'ok', contract: 'ok', index: 'not indexed yet' },
    });
    await runtime.syncIndexOnce();
    ready = await get('/api/health/ready');
    expect(ready).toMatchObject({ status: 200, json: { ready: true, checks: { index: 'ok' } } });
  });
  await withApi(() => ({}), async (get) => {
    expect((await get('/api/health/ready')).json.checks).toEqual({ database: 'ok', chain: 'ok', contract: 'ok' });
  });
});

it('reports a missing contract, an unreachable chain and a closed database without leaking details', async () => {
  await withApi((dataDir) => {
    const file = path.join(dataDir, 'deployment.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), contractAddress: '0x000000000000000000000000000000000000dEaD' }));
    return {};
  }, async (get) => {
    expect((await get('/api/health/ready')).json.checks.contract).toBe('no contract code at the deployment address');
  });

  const secretRpc = 'http://127.0.0.1:9/secret-operator-token';
  await withApi(() => ({ rpcUrl: secretRpc }), async (get, runtime) => {
    runtime.db.close();
    const ready = await get('/api/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.json.checks).toMatchObject({ database: 'failed', chain: expect.not.stringContaining('ok') });
    expect(JSON.stringify(ready.json)).not.toContain('secret-operator-token');
    expect((await get('/api/health/live')).status).toBe(200);
  });
}, 60_000);
