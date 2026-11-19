import type { DeploymentIdentity, Listing, UnindexedAuction } from '../types';
import type { AuctionEvent } from '../services/api';
import { resolveListing, type ListingTarget } from './eligibility';
import { reservationLifecycle, type Lifecycle, type LifecycleState } from './lifecycle';

/**
 * A listing for an auction whose details were never registered: the contract fields are real, the
 * descriptive ones say so. It gives the history a lifecycle state and the detail dialog something to open.
 */
export function unregisteredListing(u: UnindexedAuction): Listing {
  return {
    id: u.id, spaceId: u.spaceId, timeZone: u.timeZone, owner: u.owner, minBid: u.minBid, highestBid: u.highestBid,
    highestBidder: u.highestBidder, bidEnd: u.bidEnd, parkingStart: u.parkingStart, parkingEnd: u.parkingEnd,
    settled: u.settled, cancelled: u.cancelled, payoutClaimed: u.payoutClaimed, metadataHash: u.metadataHash, booking: u.booking,
    inventoryBlocked: u.inventoryBlocked,
    title: `Auction #${u.id}`, address: 'Details not registered by the seller yet', neighborhood: '', latitude: 0, longitude: 0,
    description: 'The seller has not registered public details for this auction. The times and amounts shown come from the contract.',
    image: '', kind: 'driveway', amenities: [],
  };
}

/**
 * Resolves a dialog target against one chain snapshot: registered listings and auctions without
 * registered details are both candidates, and the exact deployment and metadata hash must match.
 * The one resolver for what a dialog shows and what a write is judged against.
 */
export function resolveSnapshotListing(
  snapshot: { listings: readonly Listing[]; unindexed?: readonly UnindexedAuction[]; chain: DeploymentIdentity | null },
  target: ListingTarget | null,
): Listing | null {
  const registered = resolveListing(snapshot.listings, snapshot.chain, target);
  if (registered || !target) return registered;
  const unindexed = snapshot.unindexed?.find((auction) => auction.id === target.id);
  return unindexed ? resolveListing([unregisteredListing(unindexed)], snapshot.chain, target) : null;
}

export interface HistoryRow {
  auctionId: string;
  listing: Listing | null;
  lifecycle: Lifecycle | null;
  /** Indexed events of this auction that involve the wallet, oldest first. */
  events: AuctionEvent[];
  /** This wallet's last bid (ETH) from the index, if any. */
  lastBid: string | null;
  /** Newest block time among the events, for ordering and display. */
  lastEventTime: number | null;
  lastEventBlock: number;
}

/**
 * One row per auction this wallet bid on or won, from the event index plus the contract-derived
 * listings. Newest activity first. A listing the API does not know gives a row without a lifecycle.
 */
export function buildHistoryRows(
  events: AuctionEvent[],
  listings: Listing[],
  address: string,
  nowSec: number,
  knownBidIds: Set<string> | null = null,
): HistoryRow[] {
  const me = address.toLowerCase();
  const byAuction = new Map<string, AuctionEvent[]>();
  for (const e of events) {
    if (!e.auctionId) continue;
    byAuction.set(e.auctionId, [...(byAuction.get(e.auctionId) ?? []), e]);
  }
  const ids = new Set<string>(knownBidIds ?? []);
  for (const [id, list] of byAuction) {
    if (list.some((e) => e.event === 'BidPlaced' && e.account?.toLowerCase() === me)) ids.add(id);
  }
  for (const l of listings) if (l.highestBidder?.toLowerCase() === me && parseFloat(l.highestBid) > 0) ids.add(l.id);

  const rows = [...ids].map((auctionId): HistoryRow => {
    const list = byAuction.get(auctionId) ?? [];
    const listing = listings.find((l) => l.id === auctionId) ?? null;
    const mine = list.filter((e) => e.event === 'BidPlaced' && e.account?.toLowerCase() === me);
    const last = list[list.length - 1];
    return {
      auctionId,
      listing,
      lifecycle: listing ? reservationLifecycle(listing, address, nowSec, true) : null,
      events: list,
      lastBid: mine.length ? mine[mine.length - 1].amount : null,
      lastEventTime: last?.blockTime ?? null,
      lastEventBlock: last?.blockNumber ?? 0,
    };
  });
  return rows.sort((a, b) => b.lastEventBlock - a.lastEventBlock || Number(BigInt(b.auctionId) - BigInt(a.auctionId)));
}

export const PAGE_SIZE = 8;

/** Rows matching a text query (auction id, title, address, neighborhood, state label) and a state filter. */
export function filterHistory(rows: HistoryRow[], query: string, state: LifecycleState | 'all' = 'all'): HistoryRow[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  return rows.filter((r) => {
    if (state !== 'all' && r.lifecycle?.state !== state) return false;
    if (!q) return true;
    const l = r.listing;
    return [r.auctionId, l?.title, l?.address, l?.neighborhood, r.lifecycle?.label]
      .some((field) => field?.toLowerCase().includes(q));
  });
}

export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: items.slice((p - 1) * size, p * size), page: p, pages };
}

/** A link to one auction's history that only resolves on the network and contract it names. */
export function historyLink(deployment: { chainId: number; contractAddress: string }, auctionId: string): string {
  const p = new URLSearchParams({
    tab: 'activity', chain: String(deployment.chainId), contract: deployment.contractAddress.toLowerCase(), auction: auctionId,
  });
  return `?${p.toString()}`;
}

/** Reads a history link; 'mismatch' when it names another network or contract than the one served. */
export function readHistoryLink(
  search: string,
  deployment: { chainId: number; contractAddress: string } | null,
): { auctionId: string } | 'mismatch' | null {
  const p = new URLSearchParams(search);
  const auctionId = p.get('auction');
  if (p.get('tab') !== 'activity' || !auctionId || !/^\d{1,78}$/.test(auctionId)) return null;
  if (!deployment || p.get('chain') !== String(deployment.chainId) ||
      p.get('contract')?.toLowerCase() !== deployment.contractAddress.toLowerCase()) return 'mismatch';
  return { auctionId };
}
