import type { SpotMetadata, Listing, Config } from '../../shared/types';

export type { SpotMetadata, Listing, Config };

export type WalletType = 'local' | 'injected';

export interface WalletState {
  type: WalletType;
  address: string | null;
  balance: string | null;
  chainId: number | null;
  isReady: boolean;
  isConnecting: boolean;
  error: string | null;
  localAccountIndex: number;
}

export type SpotKindFilter = 'all' | 'garage' | 'driveway' | 'covered';
export type AuctionStatusFilter = 'all' | 'active' | 'ending-soon' | 'ended' | 'settled';
export type SortOption = 'ending-soon' | 'starts-soon' | 'price-asc' | 'price-desc' | 'newest';

export interface FilterState {
  search: string;
  kind: SpotKindFilter;
  status: AuctionStatusFilter;
  minPrice: string;
  maxPrice: string;
  sortBy: SortOption;
}

export type AppTab = 'marketplace' | 'activity' | 'create';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  txHash?: string;
}

export interface DemoAccount {
  index: number;
  label: string;
  role: string;
  address: string;
}
