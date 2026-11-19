import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../../src/types';
import { FilterBar } from '../../src/components/FilterBar';
import { SpotCard } from '../../src/components/SpotCard';
import { searchListingsPages } from '../../src/services/api';
import {
  DEFAULT_FILTERS,
  MY_LOCATION_LABEL,
  amenityOptions,
  areaFromBounds,
  parseArea,
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

  it('applies a map area locally and to the server query, and keeps it in the URL', () => {
    const area = '30.260000,-97.750000,30.270000,-97.730000';
    expect(parseArea(area)).toEqual({ minLat: 30.26, minLon: -97.75, maxLat: 30.27, maxLon: -97.73 });
    for (const bad of ['', '1,2,3', '30.3,-97,30.2,-96', '91,0,92,1', 'a,b,c,d']) expect(parseArea(bad), bad).toBeNull();
    // The viewport is clamped to valid coordinates (a world-wrapped map reports longitudes past 180).
    expect(areaFromBounds({ south: -95, west: -200, north: 30.123456789, east: 250 })).toBe('-90.000000,-180.000000,30.123457,180.000000');
    expect(ids({ area })).toEqual(['1']);
    expect(ids({ area: 'junk' }).sort()).toEqual(['1', '2']);
    expect(new URLSearchParams(searchQuery(f({ area }), null)).get('bbox')).toBe(area);
    expect(new URLSearchParams(searchQuery(f({ area: 'junk' }), null)).has('bbox')).toBe(false);
    expect(filtersFromSearch(filtersToSearch(f({ area }))).area).toBe(area);
    expect(filtersFromSearch('?area=junk').area).toBe('');
    expect(describeFilters(f({ area }), null)).toContain('Inside the searched map area');
  });

  it('keeps a shared position out of the URL', () => {
    expect(filtersToSearch(f({ destination: MY_LOCATION_LABEL }))).toBe('');
    expect(filtersToSearch(f({ destination: 'Far Rd' }))).toBe('?dest=Far+Rd');
  });

  it('offers location only when given a handler and shows why it was refused', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const props = { filters: DEFAULT_FILTERS, onFilterChange: () => {}, totalSpots: 2, filteredCount: 2, listingsStatus: 'ready' as const, viewMode: 'split' as const, onViewModeChange: () => {} };
    const buttons = () => [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Use my location');
    act(() => root.render(<FilterBar {...props} />));
    expect(buttons()).toHaveLength(0);
    const onUseLocation = vi.fn();
    act(() => root.render(<FilterBar {...props} onUseLocation={onUseLocation} locationMessage="Location not shared. Type a destination instead." />));
    act(() => buttons()[0].click());
    expect(onUseLocation).toHaveBeenCalledOnce();
    expect(host.querySelector('#destination-hint')?.textContent).toMatch(/Location not shared/);
    act(() => root.unmount());
  });

  it('names the space time zone on a card, or says it is not set', () => {
    const render = (over: Partial<Listing>) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      act(() => root.render(<SpotCard listing={listing(over)} currentAddress={null} isSelected={false} onSelect={() => {}} onOpenBid={() => {}} onOpenDetail={() => {}} onSettle={() => {}} />));
      const text = host.querySelector('.window-zone')?.textContent;
      act(() => root.unmount());
      return text;
    };
    expect(render({ timeZone: 'America/Chicago' })).toBe('Space time zone: America/Chicago');
    expect(render({ timeZone: '' })).toMatch(/not set/);
  });
});

describe('search pages', () => {
  afterEach(() => vi.unstubAllGlobals());
  const page = (n: number, next: string | null) => ({ listings: [{ id: String(n) }], total: 3, nextCursor: next, chain: null });

  it('reloads as many pages as were shown, on one cursor chain, and keeps what it has if a later page fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (cursor === 'c2') return new Response(JSON.stringify({ error: 'gone' }), { status: 409 });
      return new Response(JSON.stringify(cursor === 'c1' ? page(2, 'c2') : page(1, 'c1')));
    }));
    const two = await searchListingsPages('limit=1', 2);
    expect(two.listings.map((l) => l.id)).toEqual(['1', '2']);
    expect(two.nextCursor).toBe('c2');
    expect(calls).toEqual(['/api/listings/search?limit=1', '/api/listings/search?limit=1&cursor=c1']);
    // The cursor for page 3 is refused: the pages already read are kept.
    const three = await searchListingsPages('limit=1', 3);
    expect(three.listings.map((l) => l.id)).toEqual(['1', '2']);
  });
});
