import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Listing } from '../../src/types';
import { FilterBar } from '../../src/components/FilterBar';
import {
  DEFAULT_FILTERS,
  amenityOptions,
  describeFilters,
  destinationOptions,
  discoverListings,
  distanceKm,
  epochToLocal,
  filtersFromSearch,
  filtersToSearch,
  resolveDestination,
  searchQuery,
  validateFilters,
} from '../../src/utils/discovery';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_899_999_960; // minute-aligned: datetime-local has minute precision
const listing = (over: Partial<Listing>): Listing => ({
  id: '0', owner: '0x1', minBid: '0.02', highestBid: '0', highestBidder: '', bidEnd: T0 + 3600,
  parkingStart: T0 + 7200, parkingEnd: T0 + 18000, settled: false, cancelled: false, payoutClaimed: false,
  metadataHash: '0x', title: 'Spot', address: '1 Main St', neighborhood: 'Downtown', latitude: 30.2676,
  longitude: -97.7397, description: '', image: '', kind: 'garage', amenities: [], ...over,
});
const near = listing({ id: '1', title: 'Near', address: '1 Near St', latitude: 30.268, longitude: -97.74, amenities: ['Gated', 'EV'], highestBid: '0.09' });
const far = listing({ id: '2', title: 'Far', address: '9 Far Rd', latitude: 30.30, longitude: -97.70, amenities: ['Gated'], parkingStart: T0 + 3600 * 3 });
const all = [far, near];
const f = (over: Partial<typeof DEFAULT_FILTERS>) => ({ ...DEFAULT_FILTERS, ...over });
const ids = (over: Partial<typeof DEFAULT_FILTERS>, dest = null as ReturnType<typeof resolveDestination>) =>
  discoverListings(all, f(over), T0, dest).listings.map((l) => l.id);

describe('discovery filters', () => {
  it('resolves presets and listing addresses, sorts and filters by straight-line distance', () => {
    const options = destinationOptions(all);
    expect(resolveDestination('  downtown / 6th st ', options)?.label).toBe('Downtown / 6th St');
    const dest = resolveDestination('1 Near St', options)!;
    expect(dest.latitude).toBe(near.latitude);
    expect(resolveDestination('nowhere', options)).toBeNull();
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.19, 1);
    expect(ids({ sortBy: 'distance' }, dest)).toEqual(['1', '2']);
    expect(ids({ radiusKm: '1' }, dest)).toEqual(['1']);
    // Without a resolved destination, distance has no effect.
    expect(ids({ radiusKm: '1', sortBy: 'distance' })).toEqual(['2', '1']);
  });

  it('keeps only parking windows that cover the whole visit', () => {
    expect(ids({ arrive: epochToLocal(T0 + 7200), depart: epochToLocal(T0 + 18000) })).toEqual(['1']);
    expect(ids({ arrive: epochToLocal(T0 + 3600 * 3), depart: epochToLocal(T0 + 3600 * 4) }).sort()).toEqual(['1', '2']);
    expect(ids({ arrive: epochToLocal(T0 + 3600 * 4), depart: epochToLocal(T0 + 3600 * 6) })).toEqual([]);
    // A reversed visit is reported and not applied.
    const reversed = f({ arrive: epochToLocal(T0 + 18000), depart: epochToLocal(T0 + 7200) });
    expect(validateFilters(reversed).time).toMatch(/after arrival/);
    expect(discoverListings(all, reversed, T0, null).listings).toHaveLength(2);
  });

  it('requires every selected amenity and compares budget with the current price', () => {
    expect(amenityOptions(all, ['Valet'])).toEqual(['EV', 'Gated', 'Valet']);
    expect(ids({ amenities: ['Gated', 'EV'] })).toEqual(['1']);
    expect(ids({ maxPrice: '0.05' })).toEqual(['2']); // near's highest bid 0.09 exceeds it
    expect(ids({ minPrice: '0.05' })).toEqual(['1']);
    expect(validateFilters(f({ minPrice: '0.1', maxPrice: '0.01' })).price).toMatch(/above the maximum/);
    expect(ids({ minPrice: '0.1', maxPrice: '0.01' })).toHaveLength(2);
    expect(describeFilters(f({ maxPrice: '0.05', amenities: ['EV'] }), null)).toEqual([
      'Amenities: EV',
      'Current price up to 0.05 ETH',
    ]);
  });

  it('round-trips filters through the URL query and ignores malformed values', () => {
    const filters = f({
      search: 'garage', kind: 'covered', sortBy: 'distance', destination: 'Downtown / 6th St', radiusKm: '2',
      arrive: epochToLocal(T0), depart: epochToLocal(T0 + 3600), amenities: ['EV', 'Gated'], maxPrice: '0.05',
    });
    const search = filtersToSearch(filters, '?keep=1');
    expect(search).toContain('keep=1');
    expect(search).toContain(`arrive=${T0}`);
    expect(filtersFromSearch(search)).toEqual(filters);
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe('');
    expect(filtersFromSearch('?kind=boat&sort=x&within=7&max=-1&arrive=soon')).toEqual(DEFAULT_FILTERS);
  });

  it('labels every discovery control', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() =>
      root.render(
        <FilterBar
          filters={f({ arrive: epochToLocal(T0 + 3600), depart: epochToLocal(T0) })}
          onFilterChange={() => {}}
          totalSpots={2}
          filteredCount={2}
          listingsStatus="success"
          viewMode="cards"
          onViewModeChange={() => {}}
          destinationChoices={destinationOptions(all)}
          amenityChoices={amenityOptions(all)}
        />
      )
    );
    for (const input of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      const named = input.getAttribute('aria-label') || input.closest('label') || el.querySelector(`label[for="${input.id}"]`);
      expect(named, input.outerHTML).toBeTruthy();
    }
    expect(el.textContent).toContain('Departure must be after arrival. The visit filter is not applied.');
    expect(el.textContent).toContain('Not a final price');
    act(() => root.unmount());
    el.remove();
  });

  it('builds the server query with the same semantics as the local filters', () => {
    const dest = { label: 'X', latitude: 30.123456789, longitude: -97.5 };
    const q = new URLSearchParams(searchQuery(f({
      search: ' gar ', kind: 'garage', status: 'active', arrive: epochToLocal(T0), depart: epochToLocal(T0 + 3600),
      maxPrice: '0.05', amenities: ['EV', 'Gated'], radiusKm: '1', sortBy: 'distance',
    }), dest));
    expect(Object.fromEntries(q)).toMatchObject({
      q: 'gar', kind: 'garage', status: 'active', arrive: String(T0), depart: String(T0 + 3600), maxPrice: '0.05',
      near: '30.123457,-97.500000', radiusKm: '1', sort: 'distance', limit: '50',
    });
    expect(q.getAll('amenity')).toEqual(['EV', 'Gated']);
    // Invalid ranges are left out, as locally; distance sort needs a destination.
    const bad = new URLSearchParams(searchQuery(f({
      arrive: epochToLocal(T0 + 3600), depart: epochToLocal(T0), minPrice: '2', maxPrice: '1', sortBy: 'distance', radiusKm: '1',
    }), null));
    expect(Object.fromEntries(bad)).toEqual({ sort: 'ending-soon', limit: '50' });
  });
});
