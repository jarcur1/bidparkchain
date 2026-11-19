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
  /** IANA time zone name of the space's location; empty when its owner has not set one. */
  timeZone: string;
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

export interface ListingsResponse {
  listings: Listing[];
  unindexed: UnindexedAuction[];
  chain: ChainSnapshot | null;
}
