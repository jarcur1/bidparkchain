import React from 'react';
import {
  Car,
  ChevronDown,
  Layers,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import type { AppTab } from '../types';
import { DEMO_ACCOUNTS } from '../utils/constants';
import { formatEth, shortenAddress } from '../utils/formatters';

interface HeaderProps {
  currentTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  onOpenCreate: () => void;
  onOpenWalletModal: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  claimableRefundEth?: string;
  activeBidsCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  onTabChange,
  onOpenCreate,
  onOpenWalletModal,
  onRefresh,
  isRefreshing,
  claimableRefundEth,
  activeBidsCount,
}) => {
  const { walletState, wrongChain } = useWallet();

  const activeDemo =
    walletState.type === 'local'
      ? DEMO_ACCOUNTS.find((a) => a.index === walletState.localAccountIndex)
      : null;

  const hasClaimable = claimableRefundEth && parseFloat(claimableRefundEth) > 0;

  return (
    <header className="site-header">
      <div className="header-inner">
        {/* Brand identity */}
        <button
          type="button"
          className="header-brand"
          onClick={() => onTabChange('marketplace')}
          aria-label="BidPark home: discover spots"
        >
          <span className="brand-icon-wrapper">
            <Car className="brand-icon" size={22} />
          </span>
          <span className="brand-titles">
            <span className="brand-logo-row">
              <span className="brand-title">BidPark</span>
              <span className="brand-badge">Austin MVP</span>
            </span>
            <span className="brand-tagline">Private parking auctions • Smart contract escrow</span>
          </span>
        </button>

        {/* Primary Navigation */}
        <nav className="header-nav">
          <button
            type="button"
            className={`nav-tab-btn ${currentTab === 'marketplace' ? 'active' : ''}`}
            onClick={() => onTabChange('marketplace')}
          >
            <Layers size={16} />
            <span>Discover Spots</span>
          </button>

          <button
            type="button"
            className={`nav-tab-btn ${currentTab === 'activity' ? 'active' : ''}`}
            onClick={() => onTabChange('activity')}
          >
            <Sparkles size={16} />
            <span>My Activity</span>
            {(hasClaimable || activeBidsCount > 0) && (
              <span className="nav-badge-alert" title={hasClaimable ? 'Refund ready to withdraw!' : 'Active bids'}>
                {hasClaimable ? 'Refund' : activeBidsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            className="nav-action-create"
            onClick={onOpenCreate}
            title="List your private driveway or garage"
          >
            <PlusCircle size={16} />
            <span>List a Spot</span>
          </button>
        </nav>

        {/* Wallet & Controls */}
        <div className="header-actions">
          {/* Manual refresh button */}
          <button
            type="button"
            className={`btn-icon-subtle ${isRefreshing ? 'is-spinning' : ''}`}
            onClick={onRefresh}
            title="Refresh listings and contract balances"
            aria-label="Refresh data"
          >
            <RefreshCw size={16} />
          </button>

          {/* Network indicator pill */}
          <div className={`network-pill ${wrongChain ? 'wrong-network' : 'healthy-network'}`}>
            <span className="network-dot" />
            <span className="network-name">{wrongChain ? 'Wrong Chain' : 'Hardhat 31337'}</span>
          </div>

          {/* Wallet selector button */}
          {!walletState.isReady ? (
            <button
              type="button"
              className="wallet-btn wallet-btn-unconnected"
              onClick={onOpenWalletModal}
              title="Connect Local Test Wallet or Browser Wallet"
            >
              <Wallet size={15} />
              <span className="wallet-btn-label">Connect Wallet</span>
              <span className="badge-optin-pill">Testnet Ready</span>
            </button>
          ) : (
            <button
              type="button"
              className="wallet-btn"
              onClick={onOpenWalletModal}
              title="Switch local test account or connect browser wallet"
            >
              <div className="wallet-btn-left">
                <Wallet size={15} />
                <div className="wallet-btn-info">
                  <span className="wallet-btn-label">
                    {walletState.type === 'local'
                      ? activeDemo?.label || `Test Account #${walletState.localAccountIndex}`
                      : 'Injected Wallet'}
                  </span>
                  <span className="wallet-btn-addr">
                    {shortenAddress(walletState.address)}
                  </span>
                </div>
              </div>

              <div className="wallet-btn-right">
                <span className="wallet-btn-balance">
                  {formatEth(walletState.balance)} ETH
                </span>
                <ChevronDown size={14} className="wallet-btn-caret" />
              </div>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
