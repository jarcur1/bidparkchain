import type { ChainSnapshot, Config, Listing, ListingsResponse, SpotMetadata } from '../types';

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
    return { listings: [], chain: null };
  }
  const chain =
    'chain' in data && data.chain && typeof data.chain === 'object' ? (data.chain as ChainSnapshot) : null;
  return { listings: data.listings as Listing[], chain };
}

export async function createListingRecord(
  auctionId: string,
  metadata: SpotMetadata
): Promise<Listing> {
  const res = await fetch('/api/listings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auctionId,
      metadata,
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
