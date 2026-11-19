import type { ChainSnapshot, Config, DeploymentIdentity, Listing, ListingSearchResponse, ListingsResponse, SpotMetadata, UnindexedAuction } from '../types';
import { webProfile } from '../utils/networkProfile';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  let msg = `HTTP error ${res.status}`;
  try {
    const raw: unknown = await res.json();
    if (raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string') {
      msg = raw.error;
    }
  } catch {
    // ignore json parse error
  }
  return msg;
}

export async function fetchConfig(): Promise<Config> {
  const res = await fetch('/api/config');
  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    throw new ApiError(msg, res.status);
  }
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' ||
      !('profile' in data) || data.profile !== webProfile.id ||
      !('chainId' in data) || data.chainId !== webProfile.chainId ||
      !('confirmation' in data) || data.confirmation !== webProfile.confirmation) {
    throw new ApiError('API network configuration does not match this application build.', res.status);
  }
  return data as Config;
}

/** Pages of GET /api/listings followed per refresh; the server caps each page (BIDPARK_LISTINGS_SCAN_LIMIT). */
const MAX_LISTING_PAGES = 20;

async function fetchListingsPage(cursor: string | null): Promise<ListingsResponse & { nextCursor: string | null }> {
  const res = await fetch(cursor ? `/api/listings?cursor=${encodeURIComponent(cursor)}` : '/api/listings');
  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    throw new ApiError(msg, res.status);
  }
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('listings' in data) || !Array.isArray(data.listings)) {
    return { listings: [], unindexed: [], chain: null, nextCursor: null };
  }
  const chain =
    'chain' in data && data.chain && typeof data.chain === 'object' ? (data.chain as ChainSnapshot) : null;
  const unindexed = 'unindexed' in data && Array.isArray(data.unindexed) ? (data.unindexed as UnindexedAuction[]) : [];
  const nextCursor = 'nextCursor' in data && typeof data.nextCursor === 'string' ? data.nextCursor : null;
  return { listings: data.listings as Listing[], unindexed, chain, nextCursor };
}

/** Every listing, following the server's bounded pages; the snapshot carries the last page's chain identity. */
export async function fetchListings(): Promise<ListingsResponse> {
  let page = await fetchListingsPage(null);
  const listings = [...page.listings];
  const unindexed = [...page.unindexed];
  for (let n = 1; page.nextCursor && n < MAX_LISTING_PAGES; n++) {
    page = await fetchListingsPage(page.nextCursor);
    listings.push(...page.listings);
    unindexed.push(...page.unindexed);
  }
  return { listings, unindexed, chain: page.chain };
}

/** One page of GET /api/listings/search for a query built by searchQuery(); a cursor continues it. */
export async function searchListings(query: string, cursor?: string): Promise<ListingSearchResponse> {
  const params = new URLSearchParams(query);
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/listings/search?${params}`);
  if (!res.ok) throw new ApiError(await extractErrorMessage(res), res.status);
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('listings' in data) || !Array.isArray(data.listings) ||
      !('total' in data) || typeof data.total !== 'number') {
    throw new ApiError('Invalid response shape from listing search', res.status);
  }
  return data as ListingSearchResponse;
}

/**
 * The first `pages` pages of a search, each continuing the previous one's cursor so they share one block.
 * A failure after the first page keeps what was read; the first page failing is the search failing.
 */
export async function searchListingsPages(query: string, pages: number): Promise<ListingSearchResponse> {
  let result = await searchListings(query);
  for (let n = 1; n < pages && result.nextCursor; n++) {
    let page: ListingSearchResponse;
    try {
      page = await searchListings(query, result.nextCursor);
    } catch {
      break;
    }
    result = { ...page, listings: [...result.listings, ...page.listings] };
  }
  return result;
}

/** Saves metadata under its hash before the auction is created, so a lost registration is recoverable. */
export async function stageListingMetadata(metadata: SpotMetadata, deployment?: DeploymentIdentity): Promise<void> {
  const res = await fetch('/api/listings/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata, ...(deployment === undefined ? {} : { deployment }) }),
  });
  if (!res.ok) throw new ApiError(await extractErrorMessage(res), res.status);
}

export async function createListingRecord(
  auctionId: string,
  metadata: SpotMetadata,
  deployment?: DeploymentIdentity,
): Promise<Listing> {
  const res = await fetch('/api/listings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auctionId,
      metadata,
      ...(deployment === undefined ? {} : { deployment }),
    }),
  });

  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    throw new ApiError(msg, res.status);
  }

  const data: unknown = await res.json();
  if (data && typeof data === 'object' && 'listing' in data) {
    return data.listing as Listing;
  }

  throw new ApiError('Invalid response shape from POST /api/listings', res.status);
}

export interface AuctionEvent {
  event: string;
  auctionId?: string | null;
  account: string | null;
  amount: string | null;
  blockNumber: number;
  /** Block timestamp (unix seconds); null when the node could not be read for it. */
  blockTime?: number | null;
  logIndex: number;
  txHash: string;
}

export interface AuctionHistory {
  /** Last indexed block; null when the index has not run yet, so no events does not mean none happened. */
  indexedBlock: number | null;
  syncError: string | null;
  events: AuctionEvent[];
}

export async function fetchAuctionHistory(auctionId: string): Promise<AuctionHistory> {
  const res = await fetch(`/api/auctions/${encodeURIComponent(auctionId)}/events`);
  if (!res.ok) throw new ApiError(await extractErrorMessage(res), res.status);
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('events' in data) || !Array.isArray(data.events)) {
    throw new ApiError('Invalid response shape from auction history', res.status);
  }
  return data as AuctionHistory;
}

export interface AccountHistory {
  chainId: number;
  contractAddress: string;
  indexedBlock: number | null;
  syncError: string | null;
  events: AuctionEvent[];
}

/** Indexed events for one wallet's bids and auctions, with the deployment they were read from. */
export async function fetchAccountHistory(address: string): Promise<AccountHistory> {
  const res = await fetch(`/api/accounts/${encodeURIComponent(address)}/history`);
  if (!res.ok) throw new ApiError(await extractErrorMessage(res), res.status);
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('events' in data) || !Array.isArray(data.events)) {
    throw new ApiError('Invalid response shape from account history', res.status);
  }
  return data as AccountHistory;
}
