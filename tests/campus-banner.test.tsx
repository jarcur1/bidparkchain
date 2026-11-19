import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CampusScenarioBanner } from '../src/components/CampusScenarioBanner';
import { CAMPUS_TIER_LABELS } from '../shared/campus.js';
import { getSeededListings } from '../scripts/helpers/seed-data.mjs';
import type { Listing } from '../src/types';
import type { ReadStatus } from '../src/utils/readState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const listingsFor = (scenario: string) =>
  getSeededListings(0, scenario).map((l: { metadata: object }) => l.metadata as Listing);

function show(scenario: string | undefined, listings: Listing[], status: ReadStatus = 'success') {
  act(() => root.render(<CampusScenarioBanner scenario={scenario} listings={listings} listingsStatus={status} />));
  return container.textContent ?? '';
}

it('frames each campus scenario with counts from the seeded listings', () => {
  expect(show('campus-baseline', listingsFor('campus-baseline'))).toContain('Near-campus spots listed: 4 of 7 (3 farther away).');
  const text = show('campus-expansion', listingsFor('campus-expansion'), 'stale');
  expect(text).toContain('Unofficial campus-parking parody');
  expect(text).toContain('Scenario: After the dorm expansion.');
  expect(text).toContain('1 of 4 (3 farther away), from the last successful read.');
  expect(text).toContain('simulated test ETH');
});

it('shows no counts while listings are unknown and nothing for other seeds', () => {
  expect(show('campus-expansion', [], 'failed')).toContain('Spot counts are unavailable until listings load.');
  expect(show('campus-expansion', [], 'loading')).not.toContain('0 of 0');
  expect(show('austin', [{ neighborhood: CAMPUS_TIER_LABELS.near } as Listing])).toBe('');
  expect(show(undefined, [])).toBe('');
});
