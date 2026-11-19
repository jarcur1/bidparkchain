import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test, expect } from '@playwright/test';
import { serve } from '../../server/index.mjs';

// Builds the Sepolia web app and serves it the hosted way (one process, no Vite dev server, no /rpc
// proxy), then loads it in a browser: the page's Content-Security-Policy must not block anything.
test('the hosted Sepolia build renders under its Content-Security-Policy', async ({ page }) => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidpark-hosted-'));
  const webDir = path.join(dir, 'web');
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', webDir, '--emptyOutDir'], {
    env: { ...process.env, BIDPARK_PROFILE: 'sepolia' }, encoding: 'utf8', windowsHide: true,
  });
  expect(build.status, build.stderr).toBe(0);
  const api = serve({
    port: 0, indexIntervalMs: 0, webDir, allowedOrigins: ['http://127.0.0.1:1'],
    dbPath: path.join(dir, 'bidpark.db'), deploymentPath: path.join(dir, 'none.json'), rpcUrl: 'http://127.0.0.1:9',
  });
  await once(api.server, 'listening');
  try {
    const violations = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
    });
    page.on('pageerror', (error) => violations.push(`page error: ${error.message}`));
    // Third-party fonts, tiles and photos are not needed to prove the app's own code runs.
    await page.route(/^https:\/\//, (route) => route.fulfill({ status: 200, body: '' }));
    await page.goto(`http://127.0.0.1:${api.server.address().port}/`);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByText(/Sepolia/).first()).toBeVisible();
    expect(violations).toEqual([]);
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
