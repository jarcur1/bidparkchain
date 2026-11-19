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

export async function fetchListings(): Promise<ListingsResponse> {
  const res = await fetch('/api/listings');
  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    throw new ApiError(msg, res.status);
  }
  const data: unknown = await res.json();
  if (!data || typeof data !== 'object' || !('listings' in data) || !Array.isArray(data.listings)) {
    return { listings: [], unindexed: [], chain: null };
  }
  const chain =
    'chain' in data && data.chain && typeof data.chain === 'object' ? (data.chain as ChainSnapshot) : null;
  const unindexed = 'unindexed' in data && Array.isArray(data.unindexed) ? (data.unindexed as UnindexedAuction[]) : [];
  return { listings: data.listings as Listing[], unindexed, chain };
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
