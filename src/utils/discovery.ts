import type { AuctionStatusFilter, FilterState, Listing, SortOption, SpotKindFilter } from '../types';
import { distanceKm } from '../../shared/geo.js';
import { AUSTIN_PRESET_LOCATIONS } from './constants';

// Discovery filters. The marketplace sends them to GET /api/listings/search (searchQuery) and falls
// back to discoverListings on the loaded snapshot while that answer is pending or unavailable.

export const DEFAULT_FILTERS: FilterState = {
  search: '',
  kind: 'all',
  status: 'all',
  minPrice: '',
  maxPrice: '',
  sortBy: 'ending-soon',
  destination: '',
  radiusKm: '',
  arrive: '',
  depart: '',
  amenities: [],
  area: '',
};

/** Destination label for a position the driver shared; it is never written to the page URL. */
export const MY_LOCATION_LABEL = 'My location';

export const RADIUS_OPTIONS_KM = ['0.5', '1', '2', '5'] as const;

export interface Place {
  label: string;
  latitude: number;
  longitude: number;
}

/** Price the budget is compared with: the current highest bid, or the opening bid if none. */
export function listingPrice(listing: Listing): number {
  const highest = parseFloat(listing.highestBid);
  return highest > 0 ? highest : parseFloat(listing.minBid);
}

export { distanceKm } from '../../shared/geo.js';

export function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

/** Landmarks the driver can pick: preset places, then each listing's address and title. */
export function destinationOptions(listings: Listing[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  const add = (label: string, latitude: number, longitude: number) => {
    const key = label.trim().toLowerCase();
    if (!key || seen.has(key) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    seen.add(key);
    out.push({ label: label.trim(), latitude, longitude });
  };
  for (const p of AUSTIN_PRESET_LOCATIONS) add(p.name, p.latitude, p.longitude);
  for (const l of listings) {
    add(l.address, l.latitude, l.longitude);
    add(l.title, l.latitude, l.longitude);
  }
  return out;
}

export function resolveDestination(text: string, options: Place[]): Place | null {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  return options.find((o) => o.label.toLowerCase() === key) ?? null;
}

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** 'minLat,minLon,maxLat,maxLon' within valid coordinates and ordered, or null. */
export function parseArea(area: string): Bbox | null {
  const parts = area.split(',');
  if (parts.length !== 4 || !parts.every((x) => /^-?\d{1,3}(\.\d{1,6})?$/.test(x))) return null;
  const [minLat, minLon, maxLat, maxLon] = parts.map(Number);
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) return null;
  return minLat <= maxLat && minLon <= maxLon ? { minLat, minLon, maxLat, maxLon } : null;
}

/** Map viewport to the area filter value, clamped to valid coordinates and rounded to about 10 cm. */
export function areaFromBounds(b: { south: number; west: number; north: number; east: number }): string {
  const c = (v: number, lim: number) => Math.min(lim, Math.max(-lim, v)).toFixed(6);
  return [c(b.south, 90), c(b.west, 180), c(b.north, 90), c(b.east, 180)].join(',');
}

/** Union of amenities present in the listings, plus any already selected, sorted. */
export function amenityOptions(listings: Listing[], selected: string[] = []): string[] {
  const all = new Set<string>(selected);
  for (const l of listings) for (const a of l.amenities ?? []) all.add(a);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** datetime-local value (browser time zone) to unix seconds, or null. */
export function localToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function epochToLocal(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface FilterErrors {
  time?: string;
  price?: string;
}

/** Invalid ranges are reported and not applied, so a typo never silently empties the results. */
export function validateFilters(f: FilterState): FilterErrors {
  const errors: FilterErrors = {};
  const arrive = localToEpoch(f.arrive);
  const depart = localToEpoch(f.depart);
  if (arrive !== null && depart !== null && depart <= arrive) {
    errors.time = 'Departure must be after arrival.';
  }
  const min = f.minPrice === '' ? null : Number(f.minPrice);
  const max = f.maxPrice === '' ? null : Number(f.maxPrice);
  if ((min !== null && !(min >= 0)) || (max !== null && !(max >= 0))) {
    errors.price = 'Budget must be a positive ETH amount.';
  } else if (min !== null && max !== null && min > max) {
    errors.price = 'Minimum budget is above the maximum.';
  }
  return errors;
}

/** Applies every valid filter and the sort; returns the listings plus distances from the destination. */
export function discoverListings(
  listings: Listing[],
  f: FilterState,
  now: number,
  destination: Place | null,
): { listings: Listing[]; distances: Map<string, number> } {
  const errors = validateFilters(f);
  const searchLower = f.search.trim().toLowerCase();
  const arrive = errors.time ? null : localToEpoch(f.arrive);
  const depart = errors.time ? null : localToEpoch(f.depart);
  const from = arrive ?? depart;
  const to = depart ?? arrive;
  const min = errors.price || f.minPrice === '' ? null : Number(f.minPrice);
  const max = errors.price || f.maxPrice === '' ? null : Number(f.maxPrice);
  const radius = destination && f.radiusKm ? Number(f.radiusKm) : null;
  const area = parseArea(f.area);

  const distances = new Map<string, number>();
  if (destination) for (const l of listings) distances.set(l.id, distanceKm(destination, l));

  const out = listings.filter((item) => {
    if (searchLower) {
      const haystack = [item.title, item.address, item.neighborhood, item.description, ...(item.amenities ?? [])];
      if (!haystack.some((t) => t.toLowerCase().includes(searchLower))) return false;
    }
    if (f.kind !== 'all' && item.kind !== f.kind) return false;
    if (f.status === 'active' && (item.inventoryBlocked || item.bidEnd <= now || item.settled || item.cancelled)) return false;
    if (f.status === 'ending-soon' && (item.inventoryBlocked || item.bidEnd <= now || item.bidEnd - now >= 1800 || item.settled || item.cancelled)) return false;
    if (f.status === 'ended' && (item.bidEnd > now || item.settled || item.cancelled)) return false;
    if (f.status === 'settled' && !item.settled) return false;
    // The parking window must cover the whole requested visit.
    if (from !== null && to !== null && (item.parkingStart > from || item.parkingEnd < to)) return false;
    if (f.amenities.length && !f.amenities.every((a) => item.amenities?.includes(a))) return false;
    const price = listingPrice(item);
    if (min !== null && price < min) return false;
    if (max !== null && price > max) return false;
    if (area && (item.latitude < area.minLat || item.latitude > area.maxLat || item.longitude < area.minLon || item.longitude > area.maxLon)) return false;
    if (radius !== null && (distances.get(item.id) ?? Infinity) > radius) return false;
    return true;
  });

  const sortBy = f.sortBy === 'distance' && !destination ? 'ending-soon' : f.sortBy;
  out.sort((a, b) => {
    switch (sortBy) {
      case 'ending-soon': {
        const aEnded = a.bidEnd <= now || a.settled;
        const bEnded = b.bidEnd <= now || b.settled;
        if (aEnded !== bEnded) return aEnded ? 1 : -1;
        return a.bidEnd - b.bidEnd;
      }
      case 'starts-soon':
        return a.parkingStart - b.parkingStart;
      case 'price-asc':
        return listingPrice(a) - listingPrice(b);
      case 'price-desc':
        return listingPrice(b) - listingPrice(a);
      case 'newest':
        return parseInt(b.id, 10) - parseInt(a.id, 10);
      case 'distance':
        return distances.get(a.id)! - distances.get(b.id)!;
      default:
        return 0;
    }
  });
  return { listings: out, distances };
}

export const SEARCH_PAGE_SIZE = 50;

/**
 * The server query for the filters, with the same semantics as discoverListings: invalid time or
 * budget ranges are left out, and distance sort without a destination falls back to ending soon.
 */
export function searchQuery(f: FilterState, destination: Place | null): string {
  const errors = validateFilters(f);
  const p = new URLSearchParams();
  if (f.search.trim()) p.set('q', f.search.trim());
  if (f.kind !== 'all') p.set('kind', f.kind);
  if (f.status !== 'all') p.set('status', f.status);
  if (!errors.time) {
    const arrive = localToEpoch(f.arrive);
    const depart = localToEpoch(f.depart);
    if (arrive !== null) p.set('arrive', String(arrive));
    if (depart !== null) p.set('depart', String(depart));
  }
  if (!errors.price) {
    if (f.minPrice !== '') p.set('minPrice', f.minPrice);
    if (f.maxPrice !== '') p.set('maxPrice', f.maxPrice);
  }
  for (const a of f.amenities) p.append('amenity', a);
  if (parseArea(f.area)) p.set('bbox', f.area);
  if (destination) {
    p.set('near', `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`);
    if (f.radiusKm) p.set('radiusKm', f.radiusKm);
  }
  p.set('sort', f.sortBy === 'distance' && !destination ? 'ending-soon' : f.sortBy);
  p.set('limit', String(SEARCH_PAGE_SIZE));
  return p.toString();
}

/** A constraint in effect: the chip text (also listed in the no-results note) and the filter values that clear it. */
export interface ActiveFilterChip {
  label: string;
  reset: Partial<FilterState>;
}

/**
 * The constraints in effect, in display order. A filter that is not applied (an invalid visit or budget, a
 * destination that does not resolve, a radius without a destination) has no chip; sort is not a constraint.
 */
export function activeFilterChips(f: FilterState, destination: Place | null): ActiveFilterChip[] {
  const out: ActiveFilterChip[] = [];
  if (f.search.trim()) out.push({ label: `Text "${f.search.trim()}"`, reset: { search: DEFAULT_FILTERS.search } });
  if (f.kind !== 'all') out.push({ label: `Type: ${f.kind}`, reset: { kind: DEFAULT_FILTERS.kind } });
  if (f.status !== 'all') out.push({ label: `Status: ${f.status}`, reset: { status: DEFAULT_FILTERS.status } });
  if (destination) {
    const label = f.radiusKm ? `Within ${f.radiusKm} km of ${destination.label}` : `Near ${destination.label}`;
    out.push({ label, reset: { destination: DEFAULT_FILTERS.destination, radiusKm: DEFAULT_FILTERS.radiusKm } });
  }
  const errors = validateFilters(f);
  if (!errors.time) {
    const fmt = (v: string) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const reset = { arrive: DEFAULT_FILTERS.arrive, depart: DEFAULT_FILTERS.depart };
    if (f.arrive && f.depart) out.push({ label: `Covers ${fmt(f.arrive)} – ${fmt(f.depart)}`, reset });
    else if (f.arrive) out.push({ label: `Covers arrival ${fmt(f.arrive)}`, reset });
    else if (f.depart) out.push({ label: `Covers departure ${fmt(f.depart)}`, reset });
  }
  if (parseArea(f.area)) out.push({ label: 'Inside the searched map area', reset: { area: DEFAULT_FILTERS.area } });
  if (f.amenities.length) out.push({ label: `Amenities: ${f.amenities.join(', ')}`, reset: { amenities: DEFAULT_FILTERS.amenities } });
  if (!errors.price) {
    const reset = { minPrice: DEFAULT_FILTERS.minPrice, maxPrice: DEFAULT_FILTERS.maxPrice };
    if (f.minPrice && f.maxPrice) out.push({ label: `Current price ${f.minPrice}–${f.maxPrice} ETH`, reset });
    else if (f.maxPrice) out.push({ label: `Current price up to ${f.maxPrice} ETH`, reset });
    else if (f.minPrice) out.push({ label: `Current price from ${f.minPrice} ETH`, reset });
  }
  return out;
}

/** Human-readable list of the active constraints, for the no-results state. */
export function describeFilters(f: FilterState, destination: Place | null): string[] {
  return activeFilterChips(f, destination).map((chip) => chip.label);
}

// --- URL query --------------------------------------------------------------------------------

const KINDS: SpotKindFilter[] = ['all', 'garage', 'driveway', 'covered'];
const STATUSES: AuctionStatusFilter[] = ['all', 'active', 'ending-soon', 'ended', 'settled'];
const SORTS: SortOption[] = ['ending-soon', 'starts-soon', 'price-asc', 'price-desc', 'newest', 'distance'];
const URL_KEYS = ['q', 'kind', 'status', 'min', 'max', 'sort', 'dest', 'within', 'arrive', 'depart', 'amenity', 'area'];

/** Reads filters from a query string; unknown or malformed values fall back to defaults. */
export function filtersFromSearch(search: string): FilterState {
  const p = new URLSearchParams(search);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = p.get(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  const num = (key: string) => {
    const v = p.get(key) ?? '';
    return /^\d+(\.\d+)?$/.test(v) ? v : '';
  };
  const time = (key: string) => {
    const v = p.get(key) ?? '';
    return /^\d{9,11}$/.test(v) ? epochToLocal(Number(v)) : '';
  };
  return {
    search: p.get('q') ?? '',
    kind: pick('kind', KINDS, 'all'),
    status: pick('status', STATUSES, 'all'),
    minPrice: num('min'),
    maxPrice: num('max'),
    sortBy: pick('sort', SORTS, 'ending-soon'),
    destination: p.get('dest') ?? '',
    radiusKm: pick<string>('within', RADIUS_OPTIONS_KM, ''),
    arrive: time('arrive'),
    depart: time('depart'),
    amenities: [...new Set(p.getAll('amenity').filter(Boolean))],
    area: parseArea(p.get('area') ?? '') ? (p.get('area') as string) : '',
  };
}

/** Writes non-default filters into a query string, keeping any unrelated parameters. */
export function filtersToSearch(f: FilterState, existing = ''): string {
  const p = new URLSearchParams(existing);
  for (const k of URL_KEYS) p.delete(k);
  const set = (k: string, v: string, def = '') => {
    if (v && v !== def) p.set(k, v);
  };
  set('q', f.search.trim());
  set('kind', f.kind, 'all');
  set('status', f.status, 'all');
  set('min', f.minPrice);
  set('max', f.maxPrice);
  set('sort', f.sortBy, 'ending-soon');
  // A shared position stays in the browser: the link carries only typed destinations.
  set('dest', f.destination.trim() === MY_LOCATION_LABEL ? '' : f.destination.trim());
  set('area', parseArea(f.area) ? f.area : '');
  set('within', f.radiusKm);
  set('arrive', String(localToEpoch(f.arrive) ?? ''));
  set('depart', String(localToEpoch(f.depart) ?? ''));
  for (const a of f.amenities) p.append('amenity', a);
  const s = p.toString();
  return s ? `?${s}` : '';
}
