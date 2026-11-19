import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { validateSpotMetadata } from '../../shared/validation.js';
import { CAMPUS_EXPANSION_REMOVED, getSeededListings } from '../../scripts/helpers/seed-data.mjs';
import { createScope, runDeployScript } from '../support/owned-env.mjs';

const EXPECTED = {
  'campus-baseline': { total: 7, near: 4, far: 3 },
  'campus-expansion': { total: 4, near: 1, far: 3 },
};
const NEAR = 'Near campus · 3-5 min walk';
const FAR = 'Farther away · 15-20 min walk';

it('keeps tiers, opening bids and window identical; only the removed near spots differ', () => {
  const baseline = getSeededListings(1_000_000, 'campus-baseline');
  const expansion = getSeededListings(1_000_000, 'campus-expansion');
  const ids = (list) => list.map((item) => item.fixtureId);
  expect(ids(baseline).filter((id) => !ids(expansion).includes(id))).toEqual(CAMPUS_EXPANSION_REMOVED);
  for (const item of expansion) {
    expect(baseline.find((b) => b.fixtureId === item.fixtureId)).toEqual(item);
  }
  for (const item of baseline) {
    expect(validateSpotMetadata(item.metadata).valid).toBe(true);
    expect(item.metadata.title).toContain('[Fictional Class Demo]');
    expect(item.metadata.neighborhood).toBe(item.tier === 'near' ? NEAR : FAR);
    expect(item.minBidEth).toBe(item.tier === 'near' ? '0.03' : '0.01');
    expect([item.bidEnd, item.parkingStart, item.parkingEnd]).toEqual([1_003_600, 1_005_400, 1_019_800]);
    expect(item.initialBidEth).toBeNull();
  }
  expect(() => getSeededListings(0, 'campus')).toThrow(/Unknown BIDPARK_SCENARIO/);
});

let scope;
beforeAll(async () => { scope = await createScope('api-campus'); });
afterAll(async () => { await scope?.close(); });

it('seeds each campus scenario on its own deployment without mixing listings', async () => {
  const dataDir = scope.tempDir();
  const chain = await scope.startChain();
  let api;
  const deploy = async (scenario) => {
    const result = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: scenario } });
    expect(result.code, result.output).toBe(0);
    return result.output;
  };
  const listings = async () => (await (await fetch(`${api.url}/api/listings`)).json()).listings;
  const descriptor = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'deployment.json'), 'utf8'));
  const counts = (list) => ({
    total: list.length,
    near: list.filter((l) => l.neighborhood === NEAR).length,
    far: list.filter((l) => l.neighborhood === FAR).length,
  });
  try {
    await deploy('campus-baseline');
    api = await scope.startApi({ rpcUrl: chain.rpcUrl, dataDir });
    const baseline = await listings();
    expect(counts(baseline)).toEqual(EXPECTED['campus-baseline']);
    expect(baseline.every((l) => l.highestBid === '0.0')).toBe(true);
    const baselineDeployment = descriptor();
    expect(baselineDeployment.seedScenario).toBe('campus-baseline');
    expect(await deploy('campus-baseline')).toContain('Skipping');
    expect(descriptor()).toEqual(baselineDeployment);

    expect(await deploy('campus-expansion')).toContain('Seed scenario changed from campus-baseline to campus-expansion');
    expect(descriptor().contractAddress).not.toBe(baselineDeployment.contractAddress);
    const expansion = await listings();
    expect(counts(expansion)).toEqual(EXPECTED['campus-expansion']);
    for (const id of CAMPUS_EXPANSION_REMOVED) {
      expect(expansion.some((l) => l.title.startsWith(`${id} `))).toBe(false);
    }

    await deploy('campus-baseline');
    const again = await listings();
    expect(again.map((l) => l.metadataHash)).toEqual(baseline.map((l) => l.metadataHash));

    const bad = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: 'campus' } });
    expect(bad.code).not.toBe(0);
    expect(bad.output).toContain('Unknown BIDPARK_SCENARIO');
  } finally {
    await api?.stop();
    chain.provider.destroy();
  }
}, 180_000);
