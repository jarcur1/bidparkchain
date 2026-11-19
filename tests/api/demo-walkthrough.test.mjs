import { spawn } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { advancePastBidding, runWalkthrough } from '../../scripts/demo.mjs';
import { createScope, ROOT_DIR, runDeployScript } from '../support/owned-env.mjs';

let scope;
beforeAll(async () => { scope = await createScope('api-demo'); });
afterAll(async () => { await scope?.close(); });

function demoCli(command, { rpcUrl, dataDir, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/demo.mjs', command], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env, RPC_URL: rpcUrl, BIDPARK_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function freshStack(scenario) {
  const dataDir = scope.tempDir();
  const chain = await scope.startChain();
  const deployed = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: scenario } });
  expect(deployed.code, deployed.output).toBe(0);
  return { chain, dataDir, rpcUrl: chain.rpcUrl };
}

it('produces the same winner on every fresh stack and refuses a dirty rerun', async () => {
  const expected = {
    auctionId: '1', winner: 'driverB', winningBid: '0.05', refundWithdrawn: '0.03', refundLeft: '0.0', settled: true,
  };
  const first = await freshStack('campus-baseline');
  const second = await freshStack('campus-expansion');
  try {
    const cli = await demoCli('walkthrough', first);
    expect(cli.code, cli.output).toBe(0);
    expect(cli.output).toMatch(/5\. Settled: winner is driver B with 0\.05 ETH/);
    expect(await runWalkthrough(second)).toEqual({ scenario: 'campus-expansion', ...expected });

    const again = await demoCli('walkthrough', first);
    expect(again.code).not.toBe(0);
    expect(again.output).toContain('Restart npm run dev');
  } finally {
    first.chain.provider.destroy();
    second.chain.provider.destroy();
  }
}, 180_000);

it('advances the clock past open deadlines and only targets a local deployment', async () => {
  const stack = await freshStack('campus-baseline');
  try {
    const { advancedSeconds } = await advancePastBidding(stack);
    expect(advancedSeconds).toBeGreaterThan(3500);
    expect((await advancePastBidding(stack)).advancedSeconds).toBe(0);

    const remote = await demoCli('advance', { ...stack, rpcUrl: 'http://example.com:8545' });
    expect(remote.code).not.toBe(0);
    expect(remote.output).toContain('non-loopback');
    const sepolia = await demoCli('advance', { ...stack, env: { BIDPARK_PROFILE: 'sepolia' } });
    expect(sepolia.output).toContain('local profile');
    const missing = await demoCli('advance', { ...stack, dataDir: scope.tempDir() });
    expect(missing.output).toContain('No local deployment');
  } finally {
    stack.chain.provider.destroy();
  }
}, 120_000);
