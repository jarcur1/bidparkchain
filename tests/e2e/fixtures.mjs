import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createScope, findFreePort, runDeployScript } from '../support/owned-env.mjs';

export const test = base.extend({
  stack: [async ({}, use) => {
    const scope = await createScope('e2e');
    let chain;
    try {
      chain = await scope.startChain();
      const dataDir = scope.tempDir('marketplace');
      const deployment = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir });
      if (deployment.code !== 0) throw new Error(`Seeding failed:\n${deployment.output}`);
      const descriptor = JSON.parse(await readFile(path.join(dataDir, 'deployment.json'), 'utf8'));
      const api = await scope.startApi({ rpcUrl: chain.rpcUrl, dataDir });
      const port = await findFreePort();
      const webUrl = `http://127.0.0.1:${port}`;
      await scope.startService({
        label: 'E2E Vite server',
        args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        env: {
          BIDPARK_WEB_PORT: String(port),
          BIDPARK_API_URL: api.url,
          BIDPARK_RPC_URL: chain.rpcUrl,
        },
        ready: async () => (await fetch(webUrl, { signal: AbortSignal.timeout(1000) })).ok,
      });
      await use({ chain, webUrl, apiUrl: api.url, descriptor });
    } finally {
      chain?.provider.destroy();
      await scope.close();
    }
  }, { scope: 'worker', timeout: 120_000 }],

  page: async ({ page, stack }, use) => {
    const origin = new URL(stack.webUrl).origin;
    // All app API and RPC traffic is proxied through our owned Vite origin.
    // Do not let map tiles, remote photos or fonts introduce internet dependencies.
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) await route.continue();
      else await route.fulfill({ status: 200, body: '' });
    });
    await use(page);
  },
});

export { expect };
