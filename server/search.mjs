import { ethers } from 'ethers';
import { distanceKm } from '../shared/geo.js';

/** Query contract for GET /api/listings/search (docs/listing-search.md). */
export const SEARCH_KINDS = ['garage', 'driveway', 'covered'];
export const SEARCH_STATUSES = ['all', 'active', 'ending-soon', 'ended', 'settled'];
export const SEARCH_SORTS = ['ending-soon', 'starts-soon', 'price-asc', 'price-desc', 'newest', 'distance'];
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;
export const MAX_RADIUS_KM = 100;
export const ENDING_SOON_SECONDS = 1800;
export const PRICE_NOTE =
  'minBid is the opening bid and highestBid the current highest bid. Neither is a final booking price: ' +
  'bids can rise until bidEnd, and the winning bid is only known once the auction settles.';

const KEYS = new Set(['arrive', 'depart', 'near', 'radiusKm', 'bbox', 'kind', 'amenity', 'minPrice', 'maxPrice',
  'status', 'q', 'sort', 'limit', 'cursor']);
const COORD = /^-?\d{1,3}(\.\d{1,10})?$/;
const ETH = /^\d{1,12}(\.\d{1,18})?$/;

/** A malformed query; the route answers 400 with its message. */
export class QueryError extends Error {}

function fail(message) {
  throw new QueryError(message);
}

function coords(raw, name, count) {
  const parts = raw.split(',');
  if (parts.length !== count || !parts.every((p) => COORD.test(p))) fail(`${name} must be ${count} comma-separated decimal degrees`);
  return parts.map(Number);
}

function checkLatLon(lat, lon, name) {
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) fail(`${name} is outside valid latitude/longitude`);
}

/**
 * Validates a search query (Express 'simple' parser output) and returns normalized parameters.
 * Throws QueryError for any unknown, repeated or malformed parameter.
 */
export function parseSearchQuery(query) {
  for (const key of Object.keys(query)) if (!KEYS.has(key)) fail(`Unknown parameter: ${key}`);
  const one = (key) => {
    const v = query[key];
    if (v !== undefined && typeof v !== 'string') fail(`${key} must be given once`);
    return v === undefined || v === '' ? undefined : v;
  };
  const time = (key) => {
    const v = one(key);
    if (v === undefined) return null;
    if (!/^\d{1,11}$/.test(v) || Number(v) <= 0) fail(`${key} must be a unix time in seconds`);
    return Number(v);
  };
  const eth = (key) => {
    const v = one(key);
    if (v === undefined) return null;
    if (!ETH.test(v)) fail(`${key} must be a non-negative ETH amount`);
    return ethers.parseEther(v);
  };

  const arrive = time('arrive');
  const depart = time('depart');
  if (arrive !== null && depart !== null && depart <= arrive) fail('depart must be after arrive');

  let near = null;
  if (one('near') !== undefined) {
    const [latitude, longitude] = coords(one('near'), 'near', 2);
    checkLatLon(latitude, longitude, 'near');
    near = { latitude, longitude };
  }
  let radiusKm = null;
  if (one('radiusKm') !== undefined) {
    if (!near) fail('radiusKm requires near');
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(one('radiusKm'))) fail('radiusKm must be a number of kilometres');
    radiusKm = Number(one('radiusKm'));
    if (radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) fail(`radiusKm must be above 0 and at most ${MAX_RADIUS_KM}`);
  }
  let bbox = null;
  if (one('bbox') !== undefined) {
    const [minLat, minLon, maxLat, maxLon] = coords(one('bbox'), 'bbox', 4);
    checkLatLon(minLat, minLon, 'bbox');
    checkLatLon(maxLat, maxLon, 'bbox');
    if (minLat > maxLat || minLon > maxLon) fail('bbox must be minLat,minLon,maxLat,maxLon with min <= max');
    bbox = { minLat, minLon, maxLat, maxLon };
  }

  const kind = one('kind') ?? null;
  if (kind !== null && !SEARCH_KINDS.includes(kind)) fail(`kind must be one of ${SEARCH_KINDS.join(', ')}`);
  const status = one('status') ?? 'all';
  if (!SEARCH_STATUSES.includes(status)) fail(`status must be one of ${SEARCH_STATUSES.join(', ')}`);
  const sort = one('sort') ?? 'ending-soon';
  if (!SEARCH_SORTS.includes(sort)) fail(`sort must be one of ${SEARCH_SORTS.join(', ')}`);
  if (sort === 'distance' && !near) fail('sort=distance requires near');

  const rawAmenities = query.amenity === undefined ? [] : [query.amenity].flat();
  if (rawAmenities.length > 10) fail('At most 10 amenity values are allowed');
  const amenities = [...new Set(rawAmenities.map((a) => a.trim()))].sort();
  if (amenities.some((a) => !a || a.length > 40)) fail('Each amenity must be 1 to 40 characters');

  const q = one('q')?.trim().toLowerCase() || null;
  if (q && q.length > 100) fail('q must be at most 100 characters');

  const minPrice = eth('minPrice');
  const maxPrice = eth('maxPrice');
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) fail('minPrice is above maxPrice');

  const rawLimit = one('limit');
  if (rawLimit !== undefined && !/^\d{1,3}$/.test(rawLimit)) fail('limit must be an integer');
  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (limit < 1 || limit > MAX_PAGE_SIZE) fail(`limit must be between 1 and ${MAX_PAGE_SIZE}`);

  const params = { arrive, depart, near, radiusKm, bbox, kind, amenities, q, minPrice, maxPrice, status, sort };
  // Identifies the query a cursor was issued for; the page size may change between pages.
  const key = ethers.id(JSON.stringify(params, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).slice(2, 18);
  const cursor = one('cursor');
  return { ...params, limit, key, cursor: cursor === undefined ? null : decodeCursor(cursor, key) };
}

/** A cursor pins the block, chain clock and offset of the first page, so later pages read the same snapshot. */
export function encodeCursor({ blockNumber, blockHash, chainTime, offset, key }) {
  return Buffer.from(JSON.stringify({ b: blockNumber, h: blockHash, t: chainTime, o: offset, k: key })).toString('base64url');
}

function decodeCursor(raw, key) {
  let c;
  try {
    if (raw.length > 400 || !/^[\w-]+$/.test(raw)) throw new Error();
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    fail('cursor is malformed');
  }
  if (!c || !Number.isSafeInteger(c.b) || c.b < 0 || typeof c.h !== 'string' || !/^0x[0-9a-f]{64}$/i.test(c.h) ||
      !Number.isSafeInteger(c.t) || !Number.isSafeInteger(c.o) || c.o < 0 || typeof c.k !== 'string') {
    fail('cursor is malformed');
  }
  if (c.k !== key) fail('cursor belongs to a different query');
  return { blockNumber: c.b, blockHash: c.h, chainTime: c.t, offset: c.o };
}

/** Off-chain filters: metadata only, applied before any chain read so RPC work is spent on candidates. */
export function matchesMetadata(meta, p) {
  if (p.kind && meta.kind !== p.kind) return false;
  if (p.amenities.length && !p.amenities.every((a) => meta.amenities.includes(a))) return false;
  if (p.bbox && (meta.latitude < p.bbox.minLat || meta.latitude > p.bbox.maxLat ||
      meta.longitude < p.bbox.minLon || meta.longitude > p.bbox.maxLon)) return false;
  if (p.radiusKm !== null && distanceKm(p.near, meta) > p.radiusKm) return false;
  if (p.q) {
    const haystack = [meta.title, meta.address, meta.neighborhood, meta.description, ...meta.amenities];
    if (!haystack.some((t) => t.toLowerCase().includes(p.q))) return false;
  }
  return true;
}

/** Current price in wei: the highest bid, or the opening bid when there is none. */
const priceWei = (l) => {
  const highest = ethers.parseEther(l.highestBid);
  return highest > 0n ? highest : ethers.parseEther(l.minBid);
};

/**
 * On-chain filters and the sort. The parking window must cover the whole visit:
 * parkingStart <= arrive and depart <= parkingEnd (with one bound given, that instant must be covered).
 * Ties break on auction id, so the order is total and pages never overlap.
 */
export function filterAndSort(listings, p, now) {
  const from = p.arrive ?? p.depart;
  const to = p.depart ?? p.arrive;
  const open = (l) => l.bidEnd > now && !l.settled && !l.cancelled;
  const out = [];
  for (const l of listings) {
    if (p.status === 'active' && !open(l)) continue;
    if (p.status === 'ending-soon' && !(open(l) && l.bidEnd - now < ENDING_SOON_SECONDS)) continue;
    if (p.status === 'ended' && (l.bidEnd > now || l.settled || l.cancelled)) continue;
    if (p.status === 'settled' && !l.settled) continue;
    if (from !== null && (l.parkingStart > from || l.parkingEnd < to)) continue;
    const price = priceWei(l);
    if (p.minPrice !== null && price < p.minPrice) continue;
    if (p.maxPrice !== null && price > p.maxPrice) continue;
    out.push(p.near ? { ...l, distanceKm: distanceKm(p.near, l) } : l);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byKey = {
    'ending-soon': (a, b) => cmp(a.bidEnd <= now || a.settled, b.bidEnd <= now || b.settled) || a.bidEnd - b.bidEnd,
    'starts-soon': (a, b) => a.parkingStart - b.parkingStart,
    'price-asc': (a, b) => cmp(priceWei(a), priceWei(b)),
    'price-desc': (a, b) => cmp(priceWei(b), priceWei(a)),
    newest: (a, b) => cmp(BigInt(b.id), BigInt(a.id)),
    distance: (a, b) => a.distanceKm - b.distanceKm,
  }[p.sort];
  return out.sort((a, b) => byKey(a, b) || cmp(BigInt(a.id), BigInt(b.id)));
}
