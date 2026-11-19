import { parseEther } from 'ethers';
import type { DeploymentIdentity, Listing } from '../types';

// ---------------------------------------------------------------------------
// Chain clock: the server reports the chain's time with each listing snapshot.
// Between snapshots it advances with the monotonic browser clock, so a skewed
// or adjusted browser wall clock cannot reopen or close an auction.
// ---------------------------------------------------------------------------

let anchor: { chainTimeSec: number; atMs: number } | null = null;

function monotonicMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function syncChainClock(chainTimeSec: number): void {
  anchor = { chainTimeSec, atMs: monotonicMs() };
}

export function resetChainClock(): void {
  anchor = null;
}

/** Current chain time in unix seconds; falls back to the browser clock before any snapshot. */
export function getChainNowSec(): number {
  if (!anchor) return Math.floor(Date.now() / 1000);
  return Math.floor(anchor.chainTimeSec + (monotonicMs() - anchor.atMs) / 1000);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function deploymentKey(d: DeploymentIdentity | null | undefined): string {
  if (!d) return 'unknown';
  return [d.chainId, d.contractAddress.toLowerCase(), d.deploymentBlock, d.deploymentBlockHash].join(':');
}

/** Stable identity of one auction: deployment + auction id + committed metadata hash. */
export interface ListingTarget {
  deployment: string;
  id: string;
  metadataHash: string;
}

export function makeListingTarget(listing: Listing, deployment: DeploymentIdentity | null): ListingTarget {
  return { deployment: deploymentKey(deployment), id: listing.id, metadataHash: listing.metadataHash.toLowerCase() };
}

export function targetKey(t: ListingTarget | null): string {
  return t ? `${t.deployment}|${t.id}|${t.metadataHash}` : 'closed';
}

/** Resolves a target against current state; null when the deployment, id, or metadata hash no longer matches. */
export function resolveListing(
  listings: readonly Listing[],
  deployment: DeploymentIdentity | null,
  target: ListingTarget | null
): Listing | null {
  if (!target) return null;
  if (deploymentKey(deployment) !== target.deployment) return null;
  const found = listings.find((l) => l.id === target.id);
  if (!found || found.metadataHash.toLowerCase() !== target.metadataHash) return null;
  return found;
}

// ---------------------------------------------------------------------------
// The single bid eligibility rule (mirrors ParkingAuctionEscrow.bid reverts).
// ---------------------------------------------------------------------------

export type BidBlockReason = 'missing' | 'cancelled' | 'settled' | 'ended' | 'owner' | 'inventory';

export interface BidEligibility {
  canBid: boolean;
  reason: BidBlockReason | null;
  message: string | null;
}

/** The contract rejects bids once block.timestamp >= bidEnd. */
export function isAuctionOpen(listing: Listing, nowSec: number = getChainNowSec()): boolean {
  return !listing.cancelled && !listing.settled && nowSec < listing.bidEnd;
}

export function isOwnerOf(listing: Listing, account: string | null | undefined): boolean {
  return Boolean(account) && listing.owner.toLowerCase() === account?.toLowerCase();
}

export function getBidEligibility(
  listing: Listing | null | undefined,
  account: string | null | undefined,
  nowSec: number = getChainNowSec()
): BidEligibility {
  const blocked = (reason: BidBlockReason, message: string): BidEligibility => ({
    canBid: false,
    reason,
    message,
  });
  if (!listing) return blocked('missing', 'This listing is no longer available.');
  if (listing.cancelled) return blocked('cancelled', 'This auction was cancelled.');
  if (listing.settled) return blocked('settled', 'This auction has been settled.');
  if (nowSec >= listing.bidEnd) return blocked('ended', 'Bidding has closed for this auction.');
  if (isOwnerOf(listing, account)) return blocked('owner', 'Spot owners cannot bid on their own listing.');
  if (listing.inventoryBlocked) return blocked('inventory', 'Bidding is paused because this space or its lister is no longer eligible.');
  return { canBid: true, reason: null, message: null };
}

/** Smallest bid the contract accepts: the opening price, or one wei above the highest bid. */
export function getMinimumBidWei(listing: Listing): bigint {
  const highest = parseEther(listing.highestBid);
  return highest > 0n ? highest + 1n : parseEther(listing.minBid);
}
