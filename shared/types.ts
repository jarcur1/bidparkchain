import type { InterfaceAbi } from 'ethers';
import type { ConfirmationPolicy, NetworkProfileId } from './network-profiles.mjs';

export interface SpotMetadata {
  title: string;
  address: string;
  neighborhood: string;
  latitude: number;
  longitude: number;
  description: string;
  image: string;
  kind: 'garage' | 'driveway' | 'covered';
  amenities: string[];
}

export interface Listing extends SpotMetadata {
  id: string;
  /** Stable on-chain parking space this auction reserves a window on. */
  spaceId: string;
  owner: string;
  minBid: string;
  highestBid: string;
  highestBidder: string;
  bidEnd: number;
  parkingStart: number;
  parkingEnd: number;
  settled: boolean;
  cancelled: boolean;
  payoutClaimed: boolean;
  metadataHash: string;
}

export interface Config {
  profile: NetworkProfileId;
  confirmation: ConfirmationPolicy;
  explorerUrl: string | null;
  chainId: number;
  contractAddress: string;
  abi: InterfaceAbi;
  currency: 'ETH';
  networkName: string;
  demoMnemonic?: string;
  demoAccountIndex?: number;
  deploymentBlock: number;
  deploymentBlockHash: string;
  /** Local seed scenario (local profile only). */
  seedScenario?: string;
}

/** Identity of the contract deployment a listing snapshot was read from. */
export interface DeploymentIdentity {
  chainId: number;
  contractAddress: string;
  deploymentBlock: number;
  /** Hash of the deployment block; distinguishes a reset chain that reuses address and block number. */
  deploymentBlockHash: string;
}

/** Chain state observed when listings were read. */
export interface ChainSnapshot extends DeploymentIdentity {
  blockNumber: number;
  /** Timestamp of the latest block (unix seconds). */
  blockTimestamp: number;
  /**
   * Lower bound for the timestamp of the next block (unix seconds):
   * max(latest block timestamp, node wall clock). Bids are judged against this clock.
   */
  chainTime: number;
}

/** An auction that exists on-chain but has no registered metadata on this server. */
export interface UnindexedAuction {
  id: string;
  owner: string;
  metadataHash: string;
  highestBid: string;
  bidEnd: number;
  settled: boolean;
  cancelled: boolean;
}

/** A listing returned by GET /api/listings/search; distanceKm is set when the query has `near`. */
export interface SearchListing extends Listing {
  distanceKm?: number;
}

export interface ListingSearchResponse {
  listings: SearchListing[];
  /** Matches across all pages. */
  total: number;
  /** Next page of the same query, read at the same block; null on the last page. */
  nextCursor: string | null;
  /** The one block every read of this response (and of its cursor pages) used. */
  chain: (ChainSnapshot & { blockHash: string }) | null;
  /** Stored listing rows skipped as malformed. */
  skipped: number;
  /** Opening and current bids are not final booking prices. */
  pricing: string;
}

export interface ListingsResponse {
  listings: Listing[];
  unindexed: UnindexedAuction[];
  chain: ChainSnapshot | null;
}
