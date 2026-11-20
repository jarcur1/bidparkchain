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

// Seeded metadata has no bid state, so each listing starts with no bids: highestBid '0.0' and bidCount 0.
const listingsFor = (scenario: string) =>
  getSeededListings(0, scenario).map((l: { metadata: object }) => ({ highestBid: '0.0', bidCount: 0, ...l.metadata }) as Listing);
const listingsWithBids = (scenario: string, bids: Record<string, Partial<Listing>>) =>
  listingsFor(scenario).map((l) => ({ ...l, ...bids[l.title.split(' ')[0]] }));
/** Cell text of each walking-distance row in the stats table, keyed by its row header. */
const tierRows = () =>
  Object.fromEntries(
    Array.from(container.querySelectorAll('tbody tr')).map((row) => [
      row.querySelector('th')?.textContent ?? '',
      Array.from(row.querySelectorAll('td'), (td) => td.textContent ?? ''),
    ]),
  );

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

it('shows per-tier bid stats from the listings read', () => {
  show('campus-expansion', listingsWithBids('campus-expansion', {
    N1: { highestBid: '0.05', bidCount: 2 },
    F2: { highestBid: '0.02', bidCount: 1 },
    F3: { highestBid: '0.04', bidCount: 3 },
  }));
  expect(tierRows()[CAMPUS_TIER_LABELS.near]).toEqual(['1', '1', '2', '0.050 ETH', '0.050 ETH']);
  expect(tierRows()[CAMPUS_TIER_LABELS.far]).toEqual(['3', '2', '4', '0.040 ETH', '0.030 ETH']);
});

it('reads no bids as none yet, not as an unknown', () => {
  show('campus-baseline', listingsFor('campus-baseline'));
  expect(tierRows()[CAMPUS_TIER_LABELS.near]).toEqual(['4', '0', '0', 'none yet', 'none yet']);
  expect(tierRows()[CAMPUS_TIER_LABELS.far]).toEqual(['3', '0', '0', 'none yet', 'none yet']);
});

it('keeps the last read stats when stale and says so in the table caption', () => {
  show('campus-expansion', listingsWithBids('campus-expansion', { N1: { highestBid: '0.05', bidCount: 2 } }), 'stale');
  expect(container.querySelector('caption')?.textContent).toBe(
    'Bidding by walking distance, in simulated test ETH, from the last successful read.',
  );
  expect(tierRows()[CAMPUS_TIER_LABELS.near]).toEqual(['1', '1', '2', '0.050 ETH', '0.050 ETH']);
});

it('shows every bid stat as unavailable until listings are read', () => {
  for (const status of ['loading', 'failed'] as const) {
    show('campus-expansion', [], status);
    expect(tierRows()[CAMPUS_TIER_LABELS.near]).toEqual(Array(5).fill('unavailable'));
    expect(tierRows()[CAMPUS_TIER_LABELS.far]).toEqual(Array(5).fill('unavailable'));
  }
});

it('marks only the value that is missing as unavailable', () => {
  show('campus-expansion', listingsWithBids('campus-expansion', {
    F2: { highestBid: '0.02', bidCount: 1 },
    F3: { highestBid: '0.04', bidCount: undefined },
  }));
  expect(tierRows()[CAMPUS_TIER_LABELS.far]).toEqual(['3', '2', 'unavailable', '0.040 ETH', '0.030 ETH']);
  show('campus-expansion', listingsWithBids('campus-expansion', { F2: { highestBid: 'n/a' } }));
  expect(tierRows()[CAMPUS_TIER_LABELS.far]).toEqual(['3', 'unavailable', '0', 'unavailable', 'unavailable']);
});
