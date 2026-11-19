import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/artifacts',
  reporter: [['list'], ['html', { outputFolder: 'test-results/report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    // Optional installed browser, e.g. BIDPARK_E2E_CHANNEL=chrome; CI uses the bundled Chromium.
    channel: process.env.BIDPARK_E2E_CHANNEL || undefined,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
