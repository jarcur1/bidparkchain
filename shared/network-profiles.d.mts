export type NetworkProfileId = 'local' | 'sepolia';
export type ConfirmationPolicy = 'mined' | 'finalized';

export interface NetworkProfile {
  readonly id: NetworkProfileId;
  readonly chainId: number;
  readonly networkName: string;
  readonly currency: 'ETH';
  readonly confirmation: ConfirmationPolicy;
  readonly explorerUrl: string | null;
  readonly walletRpcUrl: string;
}

export const NETWORK_PROFILES: Readonly<Record<NetworkProfileId, NetworkProfile>>;
export function getNetworkProfile(value?: string): NetworkProfile;
