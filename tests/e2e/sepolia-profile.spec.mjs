import { createServer } from 'node:http';
import { test as base, expect } from '@playwright/test';
import { createScope, findFreePort } from '../support/owned-env.mjs';

const disclosure = 'This is an illustrative testnet rehearsal, not a real booking. No parking or physical access is provided. Only faucet-funded Sepolia test ETH is used; it is test currency, not payment for parking.';
const address = '0x1234567890123456789012345678901234567890';
const config = {
  profile: 'sepolia',
  chainId: 11155111,
  confirmation: 'finalized',
  explorerUrl: 'https://sepolia.etherscan.io',
  contractAddress: address,
  abi: [],
  currency: 'ETH',
  networkName: 'Sepolia',
  deploymentBlock: 1,
  deploymentBlockHash: `0x${'a'.repeat(64)}`,
};

const test = base.extend({
  sepolia: [async ({}, use) => {
    const scope = await createScope('e2e-sepolia');
    let requests = 0;
    const canary = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('rpc-canary');
    });
    try {
      await new Promise((resolve, reject) => {
        canary.once('error', reject);
        canary.listen(0, '127.0.0.1', resolve);
      });
      const canaryUrl = `http://127.0.0.1:${canary.address().port}`;
      const port = await findFreePort();
      const webUrl = `http://127.0.0.1:${port}`;
      await scope.startService({
        label: 'Sepolia E2E Vite server',
        args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        env: {
          BIDPARK_PROFILE: 'sepolia',
          BIDPARK_WEB_PORT: String(port),
          BIDPARK_API_URL: canaryUrl,
          BIDPARK_RPC_URL: canaryUrl,
        },
        ready: async () => (await fetch(webUrl, { signal: AbortSignal.timeout(1000) })).ok,
      });
      await use({ webUrl, canaryRequests: () => requests });
    } finally {
      await scope.close();
      if (canary.listening) await new Promise((resolve, reject) => canary.close((error) => error ? reject(error) : resolve()));
    }
  }, { scope: 'worker', timeout: 120_000 }],
});

async function interceptRequests(page, webUrl, configResponse) {
  const origin = new URL(webUrl).origin;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/config') return configResponse(route);
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ json: { listings: [], chain: null } });
    }
    return route.continue();
  });
}

test('shows the rehearsal disclosure and only browser wallets before configuration is available', async ({ page, sepolia }) => {
  let releaseConfig;
  const pendingConfig = new Promise((resolve) => { releaseConfig = resolve; });
  await interceptRequests(page, sepolia.webUrl, async (route) => {
    await pendingConfig;
    await route.fulfill({ status: 503, json: { error: 'Blockchain service unavailable' } });
  });
  try {
    await page.goto(sepolia.webUrl);
    await expect(page.getByRole('complementary', { name: 'Prototype disclosures' })).toContainText(disclosure);
    await expect(page.getByRole('banner')).toContainText('11155111');
    await page.getByRole('banner').getByRole('button', { name: /Connect Wallet/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect & Switch Wallet' });
    await expect(dialog.getByRole('button', { name: /Injected Web3 Provider/ })).toBeVisible();
    await expect(dialog.getByText(/Local Test Wallets/)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Account #\d+/ })).toHaveCount(0);
  } finally {
    releaseConfig();
  }
});

for (const [field, value] of [['profile', 'local'], ['chainId', 31337], ['confirmation', 'latest']]) {
  test(`rejects API configuration with a mismatched ${field}`, async ({ page, sepolia }) => {
    await interceptRequests(page, sepolia.webUrl, (route) => route.fulfill({ json: { ...config, [field]: value } }));
    await page.goto(sepolia.webUrl);
    await expect(page.getByText('API network configuration does not match this application build.')).toBeVisible();
    await expect(page.locator(`a[href="${config.explorerUrl}/address/${address}"]`)).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Prototype disclosures' })).toContainText(disclosure);
  });
}

test('uses the trusted Sepolia explorer for a finalized deployment', async ({ page, sepolia }) => {
  await interceptRequests(page, sepolia.webUrl, (route) => route.fulfill({ json: config }));
  await page.goto(sepolia.webUrl);
  await expect(page.locator(`a[href="${config.explorerUrl}/address/${address}"]`)).toBeVisible();
});

test('does not proxy RPC even when a loopback RPC target is configured', async ({ sepolia }) => {
  const response = await fetch(`${sepolia.webUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(5000),
  });
  expect(await response.text()).not.toBe('rpc-canary');
  expect(sepolia.canaryRequests()).toBe(0);
});
