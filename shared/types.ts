import type { InterfaceAbi } from 'ethers';

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
  chainId: number;
  contractAddress: string;
  abi: InterfaceAbi;
  currency: 'ETH';
  networkName: string;
  demoMnemonic: string;
  demoAccountIndex: number;
  deploymentBlock: number;
  deploymentBlockHash: string;
}
