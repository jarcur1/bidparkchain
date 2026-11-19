import { afterAll, beforeAll, expect, it } from 'vitest';
import { compareScenarios, runCommuters } from '../../scripts/demo.mjs';
import { createScope, runDeployScript } from '../support/owned-env.mjs';

let scope;
beforeAll(async () => { scope = await createScope('api-compare'); });
afterAll(async () => { await scope?.close(); });

async function commutersOn(scenario) {
  const dataDir = scope.tempDir();
  const chain = await scope.startChain();
  try {
    const deployed = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: scenario } });
    expect(deployed.code, deployed.output).toBe(0);
    const api = await scope.startApi({ rpcUrl: chain.rpcUrl, dataDir });
    const listings = (await (await fetch(`${api.url}/api/listings`)).json()).listings;
    const result = await runCommuters({ rpcUrl: chain.rpcUrl, dataDir });
    await expect(runCommuters({ rpcUrl: chain.rpcUrl, dataDir })).rejects.toThrow(/Restart npm run dev/);
    await api.stop();
    return { listings, result };
  } finally {
    chain.provider.destroy();
  }
}

it('compares fixture-derived counts and runs the same commuters against both seeds', async () => {
  const { scenarios, removedForExpansion } = compareScenarios();
  expect(removedForExpansion).toEqual(['N2', 'N3', 'N4']);
  expect(scenarios['campus-baseline']).toMatchObject({ near: 4, far: 3, openingBids: { near: '0.03', far: '0.01' } });
  expect(scenarios['campus-expansion']).toMatchObject({ near: 1, far: 3, openingBids: { near: '0.03', far: '0.01' } });

  const baseline = await commutersOn('campus-baseline');
  const expansion = await commutersOn('campus-expansion');
  for (const [name, run] of [['campus-baseline', baseline], ['campus-expansion', expansion]]) {
    const nearListed = run.listings.filter((l) => l.neighborhood.startsWith('Near campus')).length;
    expect(nearListed).toBe(scenarios[name].near);
    expect(run.listings.length - nearListed).toBe(scenarios[name].far);
  }

  expect(baseline.result).toMatchObject({ nearWinners: 4, farWinners: 0 });
  expect(baseline.result.results.every((r) => r.winningBid === '0.03')).toBe(true);
  expect(expansion.result).toMatchObject({ nearWinners: 1, farWinners: 3 });
  expect(expansion.result.results).toEqual([
    { commuter: 'Commuter 1', spot: 'F1', tier: 'far', winningBid: '0.01' },
    { commuter: 'Commuter 2', spot: 'F2', tier: 'far', winningBid: '0.01' },
    { commuter: 'Commuter 3', spot: 'F3', tier: 'far', winningBid: '0.01' },
    { commuter: 'Commuter 4', spot: 'N1', tier: 'near', winningBid: '0.06' },
  ]);
}, 240_000);
