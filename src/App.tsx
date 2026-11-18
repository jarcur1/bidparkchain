import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityView } from './components/ActivityView';
import { BidModal } from './components/BidModal';
import { CreateListingModal } from './components/CreateListingModal';
import { DetailModal } from './components/DetailModal';
import { DisclosuresBanner } from './components/DisclosuresBanner';
import { FilterBar } from './components/FilterBar';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ParkingMap } from './components/ParkingMap';
import { SpotGrid } from './components/SpotGrid';
import { Toast } from './components/Toast';
import { WalletModal } from './components/WalletModal';
import { useWallet, WalletProvider } from './context/WalletContext';
import { createListingRecord, fetchConfig, fetchListings } from './services/api';
import {
  cancelAuction,
  claimPayout,
  createAuctionOnChain,
  fetchPendingReturns,
  getContractInstance,
  parseContractError,
  placeBid,
  settleAuction,
  withdrawRefund,
} from './services/blockchain';
import { parseEther } from 'ethers';
import type {
  AppTab,
  ChainSnapshot,
  Config,
  FilterState,
  Listing,
  ListingsResponse,
  SpotMetadata,
  ToastMessage,
} from './types';
import {
  deploymentKey,
  getBidEligibility,
  getChainNowSec,
  getMinimumBidWei,
  makeListingTarget,
  resolveListing,
  syncChainClock,
  targetKey,
  type ListingTarget,
} from './utils/eligibility';
import { formatEth } from './utils/formatters';

/** A bid rejected by revalidation against current chain state; no transaction was sent. */
class BidPreflightError extends Error {}

export const AppContent: React.FC<{
  config: Config | null;
  configError: string | null;
}> = ({ config, configError }) => {
  const { walletState, signer, provider, wrongChain, refreshBalance } = useWallet();

  // Primary state
  const [listings, setListings] = useState<Listing[]>([]);
  const [chain, setChain] = useState<ChainSnapshot | null>(null);
  const [isLoadingListings, setIsLoadingListings] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActionBusy, setIsActionBusy] = useState(false);

  // Navigation & View
  const [currentTab, setCurrentTab] = useState<AppTab>('marketplace');
  const [viewMode, setViewMode] = useState<'split' | 'cards' | 'map'>('split');
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);

  // Modals
  // Dialogs hold a stable identity (deployment + auction id + metadata hash), never a listing snapshot.
  const [detailTarget, setDetailTarget] = useState<ListingTarget | null>(null);
  const [bidTarget, setBidTarget] = useState<ListingTarget | null>(null);
  const detailListing = useMemo(
    () => resolveListing(listings, chain, detailTarget),
    [listings, chain, detailTarget]
  );
  const bidModalListing = useMemo(
    () => resolveListing(listings, chain, bidTarget),
    [listings, chain, bidTarget]
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);

  // Pending metadata registration recovery state
  const [pendingRegistration, setPendingRegistration] = useState<{
    auctionId: string;
    metadata: SpotMetadata;
    txHash?: string;
  } | null>(null);

  // Activity & Refunds
  const [claimableRefundWei, setClaimableRefundWei] = useState<bigint>(0n);

  // Notifications
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Search & Filter State
  const [filters, setFilters] = useState<FilterState>({
    search: '',
    kind: 'all',
    status: 'all',
    minPrice: '',
    maxPrice: '',
    sortBy: 'ending-soon',
  });

  const addToast = useCallback(
    (type: 'success' | 'error' | 'info', title: string, message?: string, txHash?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, type, title, message, txHash }]);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Stable navigation/selection callbacks
  const handleSelectListing = useCallback((listing: Listing) => {
    setSelectedListingId(listing.id);
  }, []);

  const walletAddressRef = useRef(walletState.address);
  walletAddressRef.current = walletState.address;
  const chainRef = useRef(chain);
  chainRef.current = chain;

  const handleOpenBidModal = useCallback((listing: Listing) => {
    const eligibility = getBidEligibility(listing, walletAddressRef.current);
    if (!eligibility.canBid) {
      addToast('info', 'Bidding unavailable', eligibility.message ?? undefined);
      return;
    }
    setBidTarget(makeListingTarget(listing, chainRef.current));
  }, [addToast]);

  const handleOpenDetailModal = useCallback((listing: Listing) => {
    setDetailTarget(makeListingTarget(listing, chainRef.current));
  }, []);

  // Fetch listings from API; the newest response wins and re-anchors the chain clock.
  const listingsReqIdRef = useRef(0);
  const loadListings = useCallback(async (isSilent = false): Promise<ListingsResponse | null> => {
    if (!isSilent) setIsRefreshing(true);
    const reqId = ++listingsReqIdRef.current;
    try {
      const data = await fetchListings();
      if (reqId === listingsReqIdRef.current) {
        if (data.chain) syncChainClock(data.chain.chainTime);
        setListings(data.listings);
        setChain(data.chain);
      }
      return data;
    } catch (err) {
      console.error('Failed to load listings:', err);
      if (!isSilent) {
        addToast('error', 'Failed to load listings', err instanceof Error ? err.message : String(err));
      }
      return null;
    } finally {
      setIsLoadingListings(false);
      setIsRefreshing(false);
    }
  }, [addToast]);

  // Sequence ref to scope refund data identity and ignore stale / superseded responses
  const refundReqIdRef = useRef(0);
  const refundIdentityRef = useRef({ address: walletState.address, chainId: walletState.chainId, provider, contractAddress: config?.contractAddress });
  refundIdentityRef.current = { address: walletState.address, chainId: walletState.chainId, provider, contractAddress: config?.contractAddress };

  // Load pending returns from onchain contract
  const loadPendingRefunds = useCallback(async () => {
    const currentAddress = walletState.address;
    const isCurrentWallet = () => {
      const current = refundIdentityRef.current;
      return current.address === currentAddress && current.chainId === walletState.chainId &&
        current.provider === provider && current.contractAddress === config?.contractAddress;
    };
    if (!isCurrentWallet()) return;
    const thisReqId = ++refundReqIdRef.current;
    if (!config?.contractAddress || !currentAddress || !provider || !walletState.isReady) {
      setClaimableRefundWei(0n);
      return;
    }
    try {
      const readContract = getContractInstance(config.contractAddress, config.abi, provider);
      const wei = await fetchPendingReturns(readContract, currentAddress);
      if (
        thisReqId === refundReqIdRef.current &&
        isCurrentWallet()
      ) {
        setClaimableRefundWei(wei);
      }
    } catch (err) {
      console.warn('Failed to load pending returns:', err);
      if (
        thisReqId === refundReqIdRef.current &&
        isCurrentWallet()
      ) {
        setClaimableRefundWei(0n);
      }
    }
  }, [config, walletState.address, walletState.chainId, walletState.isReady, provider]);

  // Synchronously clear refund data whenever wallet account or chain changes
  useEffect(() => {
    ++refundReqIdRef.current;
    setClaimableRefundWei(0n);
  }, [walletState.address, walletState.chainId]);

  // Manual refresh all
  const handleRefreshAll = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([loadListings(true), loadPendingRefunds(), refreshBalance()]);
    setIsRefreshing(false);
    addToast('info', 'Refreshed', 'Marketplace and wallet data synced.');
  }, [loadListings, loadPendingRefunds, refreshBalance, addToast]);

  // Periodic polling every 10 seconds
  useEffect(() => {
    loadListings();
    loadPendingRefunds();

    const interval = setInterval(() => {
      loadListings(true);
      loadPendingRefunds();
      refreshBalance();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadListings, loadPendingRefunds, refreshBalance]);

  // Close dialogs whose listing vanished or whose deployment / metadata identity changed,
  // so an id reused by a different listing can never reattach to an old dialog.
  useEffect(() => {
    if (isLoadingListings) return;
    if (bidTarget && !bidModalListing) {
      setBidTarget(null);
      addToast(
        'info',
        'Bid dialog closed',
        'This listing changed or is no longer available on the current deployment. No bid was sent.'
      );
    }
    if (detailTarget && !detailListing) setDetailTarget(null);
  }, [isLoadingListings, bidTarget, bidModalListing, detailTarget, detailListing, addToast]);

  // Handle Place Bid
  const handlePlaceBid = async (listing: Listing, amountEth: string) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi) {
      throw new Error('Contract configuration not loaded');
    }
    if (!walletState.isReady || wrongChain || !signer) {
      throw new Error('Wallet is not connected or connected to wrong network (requires Hardhat 31337).');
    }

    setIsActionBusy(true);
    try {
      // Revalidate against the current chain listing and clock before asking the wallet to sign.
      if (!bidTarget || bidTarget.id !== listing.id) {
        throw new BidPreflightError('This bid dialog is no longer active. No bid was sent.');
      }
      const fresh = await loadListings(true);
      if (!fresh || !fresh.chain) {
        throw new BidPreflightError(
          'Could not confirm the current auction state, so no bid was sent. Your amount was kept; try again.'
        );
      }
      if (
        deploymentKey(fresh.chain) !== bidTarget.deployment ||
        fresh.chain.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase()
      ) {
        throw new BidPreflightError(
          'The marketplace deployment changed. Reload the page to continue; no bid was sent.'
        );
      }
      const current = resolveListing(fresh.listings, fresh.chain, bidTarget);
      if (!current) {
        throw new BidPreflightError('This auction is no longer available. No bid was sent.');
      }
      const eligibility = getBidEligibility(current, walletState.address, getChainNowSec());
      if (!eligibility.canBid) {
        throw new BidPreflightError(`${eligibility.message} No bid was sent.`);
      }
      if (parseEther(amountEth) < getMinimumBidWei(current)) {
        const hasBids = parseEther(current.highestBid) > 0n;
        throw new BidPreflightError(
          hasBids
            ? `Another bid raised the price to ${current.highestBid} ETH. Your amount of ${amountEth} ETH was kept; bid higher than ${current.highestBid} ETH to continue. No bid was sent.`
            : `Your amount of ${amountEth} ETH is below the ${current.minBid} ETH opening bid. No bid was sent.`
        );
      }

      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await placeBid(contract, listing.id, amountEth);

      addToast(
        'success',
        'Escrow Bid Placed!',
        `Your bid of ${amountEth} ETH for ${listing.title} is confirmed on-chain.`,
        receipt.hash
      );

      // Auto-refresh data
      await Promise.all([loadListings(true), loadPendingRefunds(), refreshBalance()]);
    } catch (err) {
      if (err instanceof BidPreflightError) throw err;
      const msg = parseContractError(err);
      addToast('error', 'Bid Submission Failed', msg);
      // The chain may have moved (competing bid, cutoff); refresh so the open dialog shows current state.
      void loadListings(true);
      throw new Error(msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Create Listing
  const handleCreateListing = async (
    metadata: SpotMetadata,
    minBidEth: string,
    bidEndSec: number,
    parkingStartSec: number,
    parkingEndSec: number
  ) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi) {
      throw new Error('Contract configuration not loaded');
    }
    if (!walletState.isReady || wrongChain || !signer) {
      throw new Error('Wallet is not connected or connected to wrong network (requires Hardhat 31337).');
    }

    setIsActionBusy(true);
    try {
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const { receipt, auctionId } = await createAuctionOnChain(
        contract,
        metadata,
        minBidEth,
        bidEndSec,
        parkingStartSec,
        parkingEndSec
      );

      // Register metadata on backend with retry retention
      try {
        await createListingRecord(auctionId, metadata);
        setPendingRegistration(null);
      } catch (postErr) {
        setPendingRegistration({ auctionId, metadata, txHash: receipt.hash });
        const errDetail = postErr instanceof Error ? postErr.message : String(postErr);
        throw new Error(
          `Auction #${auctionId} is confirmed on-chain, but metadata registration failed: ${errDetail}. You can retry registration below without re-creating the auction.`
        );
      }

      addToast(
        'success',
        'Spot Auction Created!',
        `Auction #${auctionId} is now live on-chain with ${minBidEth} ETH min bid.`,
        receipt.hash
      );

      await Promise.all([loadListings(true), refreshBalance()]);
      setSelectedListingId(auctionId);
      setCurrentTab('marketplace');
    } catch (err) {
      const msg = parseContractError(err);
      addToast('error', 'Listing Notice', msg);
      throw new Error(msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Retry Metadata Registration
  const handleRetryRegistration = async (auctionId: string, metadata: SpotMetadata) => {
    if (isActionBusy) return;
    setIsActionBusy(true);
    try {
      await createListingRecord(auctionId, metadata);
      addToast(
        'success',
        'Registration Confirmed',
        `Auction #${auctionId} metadata registered successfully.`
      );
      setPendingRegistration(null);
      await loadListings(true);
      setSelectedListingId(auctionId);
      setCurrentTab('marketplace');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast('error', 'Retry Registration Failed', msg);
      throw new Error(msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Withdraw Refund
  const handleWithdrawRefund = async () => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return;
    }

    setIsActionBusy(true);
    try {
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await withdrawRefund(contract);

      addToast(
        'success',
        'Refund Withdrawn!',
        `Withdrew ${formatEth(claimableRefundWei)} ETH back to your wallet.`,
        receipt.hash
      );

      await Promise.all([loadPendingRefunds(), refreshBalance()]);
    } catch (err) {
      const msg = parseContractError(err);
      addToast('error', 'Refund Withdrawal Failed', msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Settle Auction
  const handleSettleListing = async (listing: Listing) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return;
    }

    setIsActionBusy(true);
    try {
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await settleAuction(contract, listing.id);

      addToast(
        'success',
        'Auction Settled!',
        `Auction #${listing.id} escrow finalized. Winner reservation locked.`,
        receipt.hash
      );

      await Promise.all([loadListings(true), refreshBalance()]);
    } catch (err) {
      const msg = parseContractError(err);
      addToast('error', 'Settlement Failed', msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Cancel Auction
  const handleCancelListing = async (listing: Listing) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return;
    }

    setIsActionBusy(true);
    try {
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await cancelAuction(contract, listing.id);

      addToast(
        'success',
        'Auction Cancelled',
        `Auction #${listing.id} cancelled.`,
        receipt.hash
      );

      await loadListings(true);
      setDetailTarget(null);
    } catch (err) {
      const msg = parseContractError(err);
      addToast('error', 'Cancellation Failed', msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Handle Claim Host Payout
  const handleClaimPayout = async (listing: Listing) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return;
    }

    setIsActionBusy(true);
    try {
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await claimPayout(contract, listing.id);

      addToast(
        'success',
        'Payout Claimed!',
        `Host payout of ${formatEth(listing.highestBid)} ETH released to your wallet.`,
        receipt.hash
      );

      await Promise.all([loadListings(true), refreshBalance()]);
    } catch (err) {
      const msg = parseContractError(err);
      addToast('error', 'Payout Claim Failed', msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Filter & Sort Logic
  const filteredListings = useMemo(() => {
    const now = getChainNowSec();
    const searchLower = filters.search.trim().toLowerCase();

    return listings
      .filter((item) => {
        // Search text
        if (searchLower) {
          const matchTitle = item.title.toLowerCase().includes(searchLower);
          const matchAddr = item.address.toLowerCase().includes(searchLower);
          const matchNeigh = item.neighborhood.toLowerCase().includes(searchLower);
          const matchDesc = item.description.toLowerCase().includes(searchLower);
          const matchAmenity = item.amenities?.some((a) =>
            a.toLowerCase().includes(searchLower)
          );
          if (!matchTitle && !matchAddr && !matchNeigh && !matchDesc && !matchAmenity) {
            return false;
          }
        }

        // Kind filter
        if (filters.kind !== 'all' && item.kind !== filters.kind) {
          return false;
        }

        // Status filter
        if (filters.status !== 'all') {
          if (filters.status === 'active') {
            if (item.bidEnd <= now || item.settled || item.cancelled) return false;
          } else if (filters.status === 'ending-soon') {
            if (item.bidEnd <= now || item.bidEnd - now >= 1800 || item.settled || item.cancelled) {
              return false;
            }
          } else if (filters.status === 'ended') {
            if (item.bidEnd > now || item.settled || item.cancelled) return false;
          } else if (filters.status === 'settled') {
            if (!item.settled) return false;
          }
        }

        // Price filter
        const priceNum =
          parseFloat(item.highestBid) > 0
            ? parseFloat(item.highestBid)
            : parseFloat(item.minBid);
        if (filters.minPrice && priceNum < parseFloat(filters.minPrice)) return false;
        if (filters.maxPrice && priceNum > parseFloat(filters.maxPrice)) return false;

        return true;
      })
      .sort((a, b) => {
        const priceA = parseFloat(a.highestBid) > 0 ? parseFloat(a.highestBid) : parseFloat(a.minBid);
        const priceB = parseFloat(b.highestBid) > 0 ? parseFloat(b.highestBid) : parseFloat(b.minBid);

        switch (filters.sortBy) {
          case 'ending-soon': {
            const aEnded = a.bidEnd <= now || a.settled;
            const bEnded = b.bidEnd <= now || b.settled;
            if (aEnded && !bEnded) return 1;
            if (!aEnded && bEnded) return -1;
            return a.bidEnd - b.bidEnd;
          }
          case 'starts-soon':
            return a.parkingStart - b.parkingStart;
          case 'price-asc':
            return priceA - priceB;
          case 'price-desc':
            return priceB - priceA;
          case 'newest':
            return parseInt(b.id, 10) - parseInt(a.id, 10);
          default:
            return 0;
        }
      });
  }, [listings, filters]);

  // Compute active bids count for badge
  const activeBidsCount = useMemo(() => {
    if (!walletState.address) return 0;
    const now = getChainNowSec();
    const addr = walletState.address.toLowerCase();
    return listings.filter(
      (l) =>
        l.highestBidder &&
        l.highestBidder.toLowerCase() === addr &&
        !l.settled &&
        !l.cancelled &&
        l.bidEnd > now
    ).length;
  }, [listings, walletState.address]);

  return (
    <div className="site-wrapper">
      {/* Top Header */}
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        onOpenCreate={() => setIsCreateOpen(true)}
        onOpenWalletModal={() => setIsWalletModalOpen(true)}
        onRefresh={handleRefreshAll}
        isRefreshing={isRefreshing}
        claimableRefundEth={formatEth(claimableRefundWei)}
        activeBidsCount={activeBidsCount}
      />

      {/* Disclosures & Warnings */}
      <DisclosuresBanner />

      {/* Main Content Area */}
      <main className="site-main">
        {currentTab === 'marketplace' && (
          <div className="marketplace-container">
            {pendingRegistration && (
              <div className="pending-registration-alert">
                <div className="pending-alert-content">
                  <strong>Action Required:</strong> On-chain auction #{pendingRegistration.auctionId} was created, but metadata registration was interrupted.
                </div>
                <button
                  type="button"
                  className="btn-retry-registration"
                  onClick={() => setIsCreateOpen(true)}
                  disabled={isActionBusy}
                >
                  Complete Metadata Registration
                </button>
              </div>
            )}

            {/* Filter Toolbar */}
            <FilterBar
              filters={filters}
              onFilterChange={setFilters}
              totalSpots={listings.length}
              filteredCount={filteredListings.length}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />

            {/* Split Screen or Selected View */}
            <div className={`marketplace-layout layout-${viewMode}`}>
              {/* Cards Column */}
              {(viewMode === 'split' || viewMode === 'cards') && (
                <div className="layout-cards-column">
                  <SpotGrid
                    listings={filteredListings}
                    isLoading={isLoadingListings}
                    currentAddress={walletState.address}
                    selectedListingId={selectedListingId}
                    onSelectListing={handleSelectListing}
                    onOpenBid={handleOpenBidModal}
                    onOpenDetail={handleOpenDetailModal}
                    onSettle={handleSettleListing}
                    onResetFilters={() =>
                      setFilters({
                        search: '',
                        kind: 'all',
                        status: 'all',
                        minPrice: '',
                        maxPrice: '',
                        sortBy: 'ending-soon',
                      })
                    }
                  />
                </div>
              )}

              {/* Map Column */}
              {(viewMode === 'split' || viewMode === 'map') && (
                <div className="layout-map-column">
                  <ParkingMap
                    listings={filteredListings}
                    currentAddress={walletState.address}
                    selectedListingId={selectedListingId}
                    onSelectListing={handleSelectListing}
                    onOpenBid={handleOpenBidModal}
                    onOpenDetail={handleOpenDetailModal}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {currentTab === 'activity' && (
          <ActivityView
            currentAddress={walletState.address}
            listings={listings}
            claimableRefundWei={claimableRefundWei}
            onWithdrawRefund={handleWithdrawRefund}
            onSettleListing={handleSettleListing}
            onCancelListing={handleCancelListing}
            onClaimPayoutListing={handleClaimPayout}
            onOpenListingDetail={handleOpenDetailModal}
            onOpenBid={handleOpenBidModal}
            isActionBusy={isActionBusy}
          />
        )}
      </main>

      {/* Footer */}
      <Footer config={config} />

      {/* Detail Modal */}
      <DetailModal
        listing={detailListing}
        contractAddress={config?.contractAddress}
        currentAddress={walletState.address}
        onClose={() => setDetailTarget(null)}
        onOpenBid={handleOpenBidModal}
        onSettle={handleSettleListing}
        onCancel={handleCancelListing}
        onClaimPayout={handleClaimPayout}
        isActionBusy={isActionBusy}
      />

      {/* Bid Modal */}
      <BidModal
        key={targetKey(bidTarget)}
        listing={bidModalListing}
        onClose={() => setBidTarget(null)}
        onSubmitBid={handlePlaceBid}
        isSubmitting={isActionBusy}
      />

      {/* Create Listing Modal */}
      <CreateListingModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSubmitCreate={handleCreateListing}
        onRetryRegistration={handleRetryRegistration}
        pendingRegistration={pendingRegistration}
        isSubmitting={isActionBusy}
      />

      {/* Wallet Management Modal */}
      <WalletModal
        isOpen={isWalletModalOpen}
        onClose={() => setIsWalletModalOpen(false)}
      />

      {/* Toast notifications */}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};

export const App: React.FC = () => {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setConfig(cfg))
      .catch((err) => {
        console.warn('Config fetch error (backend may still be booting):', err);
        setConfigError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <WalletProvider config={config}>
      <AppContent config={config} configError={configError} />
    </WalletProvider>
  );
};
