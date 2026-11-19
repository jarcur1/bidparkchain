import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityView } from './components/ActivityView';
import { BidModal } from './components/BidModal';
import { CreateListingModal } from './components/CreateListingModal';
import { DetailModal } from './components/DetailModal';
import { CampusScenarioBanner } from './components/CampusScenarioBanner';
import { DisclosuresBanner } from './components/DisclosuresBanner';
import { FilterBar } from './components/FilterBar';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ReadStatusBanner, type ReadSource } from './components/ReadStatusBanner';
import { ParkingMap } from './components/ParkingMap';
import { SpotGrid } from './components/SpotGrid';
import { Toast } from './components/Toast';
import { WalletModal } from './components/WalletModal';
import { useWallet, WalletProvider } from './context/WalletContext';
import { SessionProvider } from './context/SessionContext';
import { createListingRecord, fetchConfig, fetchListings, stageListingMetadata } from './services/api';
import {
  cancelAuction,
  claimPayout,
  createAuctionOnChain,
  fetchBidAuctionIds,
  fetchPendingReturns,
  getContractInstance,
  parseContractError,
  placeBid,
  settleAuction,
  TransactionOutcomeUnknown,
  withdrawRefund,
} from './services/blockchain';
import { parseEther } from 'ethers';
import type {
  AppTab,
  ChainSnapshot,
  Config,
  DeploymentIdentity,
  FilterState,
  Listing,
  ListingsResponse,
  SpotMetadata,
  ToastMessage,
  UnindexedAuction,
} from './types';
import {
  deploymentKey,
  getBidEligibility,
  getChainNowSec,
  getMinimumBidWei,
  makeListingTarget,
  resetChainClock,
  resolveListing,
  syncChainClock,
  targetKey,
  type ListingTarget,
} from './utils/eligibility';
import { formatEth } from './utils/formatters';
import { webProfile } from './utils/networkProfile';
import {
  LOADING_READ,
  READ_OK,
  READ_SKIPPED,
  READ_SUPERSEDED,
  readFailed,
  readFailure,
  readSucceeded,
  type ReadResult,
  type ReadState,
} from './utils/readState';

interface ListingsState {
  deployment: string | null;
  data: Listing[];
  unindexed: UnindexedAuction[];
  chain: ChainSnapshot | null;
  deploymentChanged: boolean;
  read: ReadState;
}

type ListingsReadResult = ReadResult & { snapshot?: ListingsResponse };

interface RefundIdentity {
  address: string | null;
  chainId: number | null;
  provider: unknown;
  deployment: string | null;
}

interface RefundState {
  identity: RefundIdentity;
  wei: bigint | null;
  // Auctions this account bid on; null when the bid history could not be read.
  bidIds: Set<string> | null;
  read: ReadState;
}

const EMPTY_LISTINGS: ListingsState = {
  deployment: null, data: [], unindexed: [], chain: null, deploymentChanged: false, read: LOADING_READ,
};
const UNKNOWN_REFUND = { wei: null, bidIds: null, read: LOADING_READ };

const sameRefundIdentity = (a: RefundIdentity, b: RefundIdentity) =>
  a.address === b.address && a.chainId === b.chainId && a.provider === b.provider &&
  a.deployment === b.deployment;

export const deploymentKeyOf = (config: Config | null) =>
  config
    ? `${config.chainId}:${config.contractAddress.toLowerCase()}:${config.deploymentBlock}:${config.deploymentBlockHash}`
    : null;

/** A bid rejected by revalidation against current chain state; no transaction was sent. */
class BidPreflightError extends Error {}

export const AppContent: React.FC<{
  config: Config | null;
  configRead: ReadState;
  onRefreshConfig: () => Promise<ReadResult>;
}> = ({ config, configRead, onRefreshConfig }) => {
  const { walletState, signer, isCurrentSigner, provider, wrongChain, refreshBalance, balanceRead } = useWallet();

  // Primary state
  const [listingsState, setListingsState] = useState<ListingsState>(EMPTY_LISTINGS);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActionBusy, setIsActionBusy] = useState(false);

  // Never show listings read from a different deployment alongside the current config.
  const configDeployment = deploymentKeyOf(config);
  const deploymentRef = useRef(configDeployment);
  const configRef = useRef(config);
  configRef.current = config;
  deploymentRef.current = configDeployment;
  const listingsView =
    configDeployment === null || listingsState.deployment === configDeployment ? listingsState : EMPTY_LISTINGS;
  const listings = listingsView.data;
  const chain = listingsView.deploymentChanged ? null : listingsView.chain;

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
    deployment: DeploymentIdentity;
    txHash?: string;
  } | null>(null);
  const [unconfirmedCreation, setUnconfirmedCreation] = useState<string | null>(null);
  const unconfirmedCreationRef = useRef<string | null>(null);

  // Activity & Refunds
  const [refundState, setRefundState] = useState<RefundState | null>(null);

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
    if (!chainRef.current) {
      addToast('info', 'Bidding unavailable', 'Refresh the marketplace to confirm the current deployment.');
      return;
    }
    const eligibility = getBidEligibility(listing, walletAddressRef.current);
    if (!eligibility.canBid) {
      addToast('info', 'Bidding unavailable', eligibility.message ?? undefined);
      return;
    }
    setBidTarget(makeListingTarget(listing, chainRef.current));
  }, [addToast]);

  const handleOpenDetailModal = useCallback((listing: Listing) => {
    if (chainRef.current) setDetailTarget(makeListingTarget(listing, chainRef.current));
  }, []);

  const listingsReqRef = useRef(0);
  const bidReadRef = useRef<{ deployment: string | null; promise: Promise<ListingsReadResult> } | null>(null);

  // Only the newest request for the current deployment may publish or re-anchor the clock.
  const readListings = useCallback(async (): Promise<ListingsReadResult> => {
    const reqId = ++listingsReqRef.current;
    const requestedDeployment = deploymentRef.current;
    const isSuperseded = () =>
      reqId !== listingsReqRef.current || requestedDeployment !== deploymentRef.current;
    const fail = (error: unknown, deploymentChanged = false) => {
      setListingsState((prev) => {
        const base = prev.deployment === requestedDeployment ? prev : EMPTY_LISTINGS;
        return {
          ...base,
          deployment: requestedDeployment,
          deploymentChanged: base.deploymentChanged || deploymentChanged,
          read: readFailed(base.read, error),
        };
      });
      return readFailure(error);
    };
    try {
      const snapshot = await fetchListings();
      if (isSuperseded()) return READ_SUPERSEDED;
      if (snapshot.chain && snapshot.chain.chainId !== undefined && snapshot.chain.chainId !== webProfile.chainId) {
        return fail('Listings are from a different network.');
      }
      if (webProfile.id === 'sepolia' && (!snapshot.chain || snapshot.chain.chainId !== webProfile.chainId)) {
        return fail('Listings did not include the expected network.');
      }
      const observedDeployment = snapshot.chain ? deploymentKey(snapshot.chain) : null;
      if (requestedDeployment !== null && observedDeployment !== requestedDeployment) {
        if (observedDeployment === null) return fail('Listings did not include the current deployment.');
        void onRefreshConfig();
        return fail('The listings deployment changed. Refresh the marketplace configuration.', true);
      }
      if (snapshot.chain) syncChainClock(snapshot.chain.chainTime);
      else resetChainClock();
      setListingsState({
        deployment: observedDeployment,
        data: snapshot.listings,
        unindexed: snapshot.unindexed ?? [],
        chain: snapshot.chain,
        deploymentChanged: false,
        read: readSucceeded(snapshot.listings.length === 0),
      });
      return { ...READ_OK, snapshot };
    } catch (err) {
      console.error('Failed to load listings:', err);
      if (isSuperseded()) return READ_SUPERSEDED;
      return fail(err);
    }
  }, [onRefreshConfig]);

  // A refresh can share a bid's in-flight read, but cannot supersede it on the same deployment.
  const loadListings = useCallback((forBid = false, forceFresh = false): Promise<ListingsReadResult> => {
    const deployment = deploymentRef.current;
    const current = bidReadRef.current;
    if (!forceFresh && current?.deployment === deployment) return current.promise;
    const read = readListings();
    if (!forBid) return read;
    const promise = read.finally(() => {
      if (bidReadRef.current?.promise === promise) bidReadRef.current = null;
    });
    bidReadRef.current = { deployment, promise };
    return promise;
  }, [readListings]);

  // Refund reads are scoped to account, chain, provider and contract; foreign values are never shown.
  const refundIdentity: RefundIdentity = {
    address: walletState.address,
    chainId: walletState.chainId,
    provider,
    deployment: configDeployment,
  };
  const refundIdentityRef = useRef(refundIdentity);
  refundIdentityRef.current = refundIdentity;
  const refundReqIdRef = useRef(0);
  const refund =
    refundState && sameRefundIdentity(refundState.identity, refundIdentity) ? refundState : UNKNOWN_REFUND;
  const claimableRefundWei = refund.wei;
  const refundRead = refund.read;
  const myBidAuctionIds = refund.bidIds;

  // Load pending returns from onchain contract
  const loadPendingRefunds = useCallback(async (): Promise<ReadResult> => {
    const identity: RefundIdentity = {
      address: walletState.address,
      chainId: walletState.chainId,
      provider,
      deployment: configDeployment,
    };
    const thisReqId = ++refundReqIdRef.current;
    const isCurrent = () =>
      thisReqId === refundReqIdRef.current && sameRefundIdentity(refundIdentityRef.current, identity);
    const fail = (err: unknown): ReadResult => {
      setRefundState((prev) => {
        const known = prev && sameRefundIdentity(prev.identity, identity) ? prev : null;
        return {
          identity, wei: known?.wei ?? null, bidIds: known?.bidIds ?? null,
          read: readFailed(known?.read ?? LOADING_READ, err),
        };
      });
      return readFailure(err);
    };
    if (!identity.address || !provider) return READ_SKIPPED;
    if (!walletState.isReady) return fail('Wallet is not connected to the supported network.');
    if (!config?.contractAddress) return fail('Contract configuration is unavailable.');
    try {
      const readContract = getContractInstance(config.contractAddress, config.abi, provider);
      // Bid history only explains the refund; failing to read it must not block a withdrawal.
      const [wei, bidIds] = await Promise.all([
        fetchPendingReturns(readContract, identity.address, config.confirmation),
        fetchBidAuctionIds(readContract, identity.address, config.deploymentBlock, config.confirmation).catch((err) => {
          console.warn('Failed to load bid history:', err);
          return null;
        }),
      ]);
      if (!isCurrent()) return READ_SUPERSEDED;
      setRefundState({ identity, wei, bidIds, read: readSucceeded(wei === 0n) });
      return READ_OK;
    } catch (err) {
      console.warn('Failed to load pending returns:', err);
      if (!isCurrent()) return READ_SUPERSEDED;
      return fail(err);
    }
  }, [config, configDeployment, walletState.address, walletState.chainId, walletState.isReady, provider]);

  // Manual refresh all: reports what each source actually did.
  const handleRefreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const sources: [string, Promise<ReadResult>][] = [
        ['Configuration', onRefreshConfig()],
        ['Listings', loadListings()],
        ['Refund balance', loadPendingRefunds()],
        ['Wallet balance', refreshBalance()],
      ];
      const results = await Promise.all(sources.map(([, p]) => p));
      const named = sources.map(([label], i) => ({ label, ...results[i] }));
      const updated = named.filter((r) => r.outcome === 'ok').map((r) => r.label);
      const failed = named.filter((r) => r.outcome === 'failed');
      const failedText = failed.map((r) => `${r.label} (${r.error})`).join('; ');
      if (failed.length === 0) {
        const retried = named.some((r) => r.outcome === 'superseded');
        addToast(
          'success',
          'Refreshed',
          `Updated: ${updated.join(', ') || 'nothing to read'}.${retried ? ' Some reads were replaced by a newer request.' : ''}`
        );
      } else if (updated.length > 0) {
        addToast('error', 'Refresh partly failed', `Updated: ${updated.join(', ')}. Still unavailable: ${failedText}.`);
      } else {
        addToast('error', 'Refresh failed', `Could not read: ${failedText}.`);
      }
      return null;
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefreshConfig, loadListings, loadPendingRefunds, refreshBalance, addToast]);

  // Targeted retry for one failed source.
  const retrySource = useCallback(async (label: string, read: () => Promise<ReadResult>) => {
    setIsRefreshing(true);
    try {
      const result = await read();
      if (result.outcome === 'failed') addToast('error', `${label} still unavailable`, result.error);
      else if (result.outcome === 'ok') addToast('success', `${label} reloaded`);
      else if (result.outcome === 'superseded') addToast('info', `${label} read was replaced by a newer request`);
      else addToast('info', `${label} was not read`, 'Nothing to read for the current wallet or configuration.');
    } finally {
      setIsRefreshing(false);
    }
  }, [addToast]);

  // Initial load and periodic polling every 10 seconds (restarts when identity changes)
  useEffect(() => {
    void loadListings();
    void loadPendingRefunds();
    void refreshBalance();

    const interval = setInterval(() => {
      void onRefreshConfig();
      void loadListings();
      void loadPendingRefunds();
      void refreshBalance();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadListings, loadPendingRefunds, refreshBalance, onRefreshConfig, configDeployment]);

  // Close dialogs whose listing vanished or whose deployment / metadata identity changed,
  // so an id reused by a different listing can never reattach to an old dialog.
  useEffect(() => {
    if (bidTarget && !bidModalListing) {
      setBidTarget(null);
      addToast(
        'info',
        'Bid dialog closed',
        'This listing changed or is no longer available on the current deployment. No bid was sent.'
      );
    }
    if (detailTarget && !detailListing) setDetailTarget(null);
  }, [bidTarget, bidModalListing, detailTarget, detailListing, addToast]);

  // Re-read both sources immediately before signing; never trust a render's cached snapshot.
  const preflightWrite = async (listing?: Listing): Promise<ListingsResponse | undefined> => {
    if (webProfile.id !== 'sepolia') return undefined;
    const expectedKey = deploymentKeyOf(config);
    if (!config || !expectedKey || !signer || (listing && !chain)) {
      throw new BidPreflightError('Cannot confirm the current wallet or deployment. No transaction was sent.');
    }
    const target = listing && chain ? makeListingTarget(listing, chain) : null;
    let freshConfig: Config;
    try {
      freshConfig = await fetchConfig();
    } catch {
      throw new BidPreflightError('Could not refresh marketplace configuration. No transaction was sent.');
    }
    if (deploymentKeyOf(freshConfig) !== expectedKey || JSON.stringify(freshConfig) !== JSON.stringify(config) ||
        deploymentRef.current !== expectedKey) {
      throw new BidPreflightError('The marketplace configuration changed. No transaction was sent.');
    }
    const result = await loadListings(true, true);
    const fresh = result.snapshot;
    if (result.outcome !== 'ok' || !fresh?.chain || fresh.chain.chainId !== webProfile.chainId ||
        deploymentKey(fresh.chain) !== expectedKey || deploymentRef.current !== expectedKey ||
        JSON.stringify(configRef.current) !== JSON.stringify(config) || !isCurrentSigner(signer)) {
      throw new BidPreflightError('Cannot confirm the current wallet or deployment. No transaction was sent.');
    }
    if (target && !resolveListing(fresh.listings, fresh.chain, target)) {
      throw new BidPreflightError('This auction is no longer available. No transaction was sent.');
    }
    return fresh;
  };

  const reportUnknown = (err: TransactionOutcomeUnknown) => {
    addToast('info', 'Transaction submitted; finality not established', 'Check the transaction in the explorer before taking further action.', err.hash);
  };

  // Handle Place Bid
  const handlePlaceBid = async (listing: Listing, amountEth: string) => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi) {
      throw new Error('Contract configuration not loaded');
    }
    if (!walletState.isReady || wrongChain || !signer) {
      throw new Error(`Wallet is not connected or connected to wrong network (requires ${webProfile.networkName} ${webProfile.chainId}).`);
    }

    setIsActionBusy(true);
    try {
      // Revalidate against the current chain listing and clock before asking the wallet to sign.
      if (!bidTarget || bidTarget.id !== listing.id) {
        throw new BidPreflightError('This bid dialog is no longer active. No bid was sent.');
      }
      const fresh = webProfile.id === 'sepolia'
        ? await preflightWrite(listing)
        : (await loadListings(true)).snapshot;
      if (!isCurrentSigner(signer) || deploymentRef.current !== configDeployment) {
        throw new BidPreflightError('Your wallet or deployment changed. No bid was sent.');
      }
      if (!fresh || !fresh.chain) {
        throw new BidPreflightError(
          'Could not confirm the current auction state, so no bid was sent. Your amount was kept; try again.'
        );
      }
      if (deploymentKey(fresh.chain) !== bidTarget.deployment || fresh.chain.chainId !== webProfile.chainId) {
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
      const receipt = await placeBid(contract, listing.id, amountEth, config.confirmation);

      addToast(
        'success',
        'Escrow Bid Placed!',
        `Your bid of ${amountEth} ETH for ${listing.title} is confirmed on-chain.`,
        receipt.hash
      );

      // Auto-refresh data
      await Promise.all([loadListings(), loadPendingRefunds(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        throw new Error('Transaction submitted; finality not established. Check the explorer before bidding again.');
      }
      if (err instanceof BidPreflightError) throw err;
      const msg = parseContractError(err);
      addToast('error', 'Bid Submission Failed', msg);
      // The chain may have moved (competing bid, cutoff); refresh so the open dialog shows current state.
      void loadListings();
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
      throw new Error(`Wallet is not connected or connected to wrong network (requires ${webProfile.networkName} ${webProfile.chainId}).`);
    }
    if (webProfile.id === 'sepolia' && unconfirmedCreationRef.current) {
      throw new Error('Transaction submitted; finality not established. Check the earlier creation in the explorer before creating another auction.');
    }
    const expectedDeployment: DeploymentIdentity = {
      chainId: config.chainId,
      contractAddress: config.contractAddress,
      deploymentBlock: config.deploymentBlock,
      deploymentBlockHash: config.deploymentBlockHash,
    };
    const expectedDeploymentKey = deploymentKey(expectedDeployment);

    setIsActionBusy(true);
    try {
      await preflightWrite();
      // Save the exact metadata before signing: if registration is lost after the transaction,
      // the server can still match the new auction's hash to these details.
      await stageListingMetadata(metadata, webProfile.id === 'sepolia' ? expectedDeployment : undefined);
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const { receipt, auctionId } = await createAuctionOnChain(
        contract,
        metadata,
        minBidEth,
        bidEndSec,
        parkingStartSec,
        parkingEndSec,
        config.confirmation
      );

      // Register metadata on backend with retry retention
      try {
        if (deploymentRef.current !== expectedDeploymentKey) {
          throw new Error('The marketplace deployment changed before metadata registration.');
        }
        if (webProfile.id === 'sepolia') {
          await createListingRecord(auctionId, metadata, expectedDeployment);
        } else {
          await createListingRecord(auctionId, metadata);
        }
        setPendingRegistration(null);
      } catch (postErr) {
        setPendingRegistration({ auctionId, metadata, deployment: expectedDeployment, txHash: receipt.hash });
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

      await Promise.all([loadListings(), refreshBalance()]);
      setSelectedListingId(auctionId);
      setCurrentTab('marketplace');
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        if (webProfile.id === 'sepolia') {
          unconfirmedCreationRef.current = err.hash;
          setUnconfirmedCreation(err.hash);
        }
        reportUnknown(err);
        throw new Error('Transaction submitted; finality not established. Check the explorer before creating another auction.');
      }
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
    if (!pendingRegistration || pendingRegistration.auctionId !== auctionId ||
        deploymentRef.current !== deploymentKey(pendingRegistration.deployment)) {
      throw new Error('The marketplace deployment changed. Registration is only available on the original deployment.');
    }
    setIsActionBusy(true);
    try {
      if (webProfile.id === 'sepolia') {
        await createListingRecord(auctionId, metadata, pendingRegistration.deployment);
      } else {
        await createListingRecord(auctionId, metadata);
      }
      addToast(
        'success',
        'Registration Confirmed',
        `Auction #${auctionId} metadata registered successfully.`
      );
      setPendingRegistration(null);
      await loadListings();
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
    // Withdrawal is only offered from a successful, current refund read.
    const withdrawableWei = refundRead.status === 'success' ? claimableRefundWei : null;
    if (withdrawableWei === null || withdrawableWei <= 0n) {
      addToast('error', 'Refund balance unavailable', 'Refresh the refund balance before withdrawing.');
      return;
    }

    setIsActionBusy(true);
    try {
      await preflightWrite();
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await withdrawRefund(contract, config.confirmation);

      addToast(
        'success',
        'Refund Withdrawn!',
        webProfile.id === 'sepolia' ? 'Your refund was withdrawn to your wallet.' : `Withdrew ${formatEth(withdrawableWei)} ETH back to your wallet.`,
        receipt.hash
      );

      await Promise.all([loadPendingRefunds(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
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
      await preflightWrite(listing);
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await settleAuction(contract, listing.id, config.confirmation);

      addToast(
        'success',
        'Auction Settled!',
        `Auction #${listing.id} escrow finalized. Winner reservation locked.`,
        receipt.hash
      );

      await Promise.all([loadListings(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
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
      await preflightWrite(listing);
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await cancelAuction(contract, listing.id, config.confirmation);

      addToast(
        'success',
        'Auction Cancelled',
        `Auction #${listing.id} cancelled.`,
        receipt.hash
      );

      await loadListings();
      setDetailTarget(null);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
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
      await preflightWrite(listing);
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await claimPayout(contract, listing.id, config.confirmation);

      addToast(
        'success',
        'Payout Claimed!',
        `Host payout of ${formatEth(listing.highestBid)} ETH released to your wallet.`,
        receipt.hash
      );

      await Promise.all([loadListings(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
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

  const readSources: ReadSource[] = [
    {
      key: 'config',
      label: 'Configuration',
      read: configRead,
      impact: 'Wallet connection and contract actions are unavailable until it loads.',
      onRetry: () => void retrySource('Configuration', onRefreshConfig),
    },
    {
      key: 'listings',
      label: 'Listings',
      read: listingsView.read,
      impact: 'Auction data may not match the marketplace.',
      onRetry: () => void retrySource('Listings', loadListings),
    },
    ...(walletState.address
      ? ([
          {
            key: 'refund',
            label: 'Refund balance',
            read: refundRead,
            impact: 'Withdrawal is disabled until it can be read.',
            onRetry: () => void retrySource('Refund balance', loadPendingRefunds),
          },
          {
            key: 'balance',
            label: 'Wallet balance',
            read: balanceRead,
            impact: 'Bids are blocked until the balance can be read.',
            onRetry: () => void retrySource('Wallet balance', refreshBalance),
          },
        ] satisfies ReadSource[])
      : []),
  ];

  return (
    <div className="site-wrapper">
      {/* Top Header */}
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        onOpenCreate={() => {
          if (unconfirmedCreationRef.current) {
            addToast('info', 'Transaction submitted; finality not established', 'Check the earlier creation in the explorer before creating another auction.', unconfirmedCreationRef.current);
            return;
          }
          setIsCreateOpen(true);
        }}
        onOpenWalletModal={() => setIsWalletModalOpen(true)}
        onRefresh={handleRefreshAll}
        isRefreshing={isRefreshing}
        claimableRefundEth={claimableRefundWei === null ? undefined : formatEth(claimableRefundWei)}
        refundStatus={refundRead.status}
        activeBidsCount={activeBidsCount}
      />

      <ReadStatusBanner sources={readSources} isRetrying={isRefreshing} />
      {unconfirmedCreation && (
        <div className="pending-registration-alert" role="alert">
          <div className="pending-alert-content">
            <strong>Transaction submitted; finality not established.</strong>{' '}
            Check the transaction in the explorer before creating another auction. Creation is blocked for this session.
            {' '}Transaction hash: {unconfirmedCreation}
          </div>
          {config?.explorerUrl && (
            <a href={`${config.explorerUrl.replace(/\/$/, '')}/tx/${unconfirmedCreation}`} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </div>
      )}

      {/* Disclosures & Warnings */}
      <DisclosuresBanner />

      {/* Main Content Area */}
      <main className="site-main">
        {currentTab === 'marketplace' && (
          <div className="marketplace-container">
            {listingsView.unindexed.length > 0 && (
              <div className="pending-registration-alert unindexed-alert" role="status">
                <div className="pending-alert-content">
                  {listingsView.unindexed.length === 1 ? 'One on-chain auction has' : `${listingsView.unindexed.length} on-chain auctions have`} no
                  registered details yet (auction {listingsView.unindexed.map((a) => `#${a.id}`).join(', ')}). They exist and can
                  hold bids, but can't be shown here until their seller completes registration.
                </div>
              </div>
            )}
            <CampusScenarioBanner
              scenario={config?.seedScenario}
              listings={listings}
              listingsStatus={listingsView.read.status}
            />
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
              listingsStatus={listingsView.read.status}
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
                    status={listingsView.read.status}
                    error={listingsView.read.error}
                    onRetry={() => void retrySource('Listings', loadListings)}
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
            refundRead={refundRead}
            myBidAuctionIds={myBidAuctionIds}
            listingsRead={listingsView.read}
            onRetryRefund={() => void retrySource('Refund balance', loadPendingRefunds)}
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
        isOpen={isCreateOpen && !unconfirmedCreation}
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
      <Toast toasts={toasts} onDismiss={dismissToast} explorerUrl={config?.explorerUrl} />
    </div>
  );
};

export const App: React.FC = () => {
  const [configState, setConfigState] = useState<{ config: Config | null; read: ReadState }>({
    config: null,
    read: LOADING_READ,
  });
  const configReqRef = useRef(0);

  // Fetch the deployment configuration; a failed refresh keeps the last known configuration, labeled stale.
  const refreshConfig = useCallback(async (): Promise<ReadResult> => {
    const reqId = ++configReqRef.current;
    try {
      const next = await fetchConfig();
      if (reqId !== configReqRef.current) return READ_SUPERSEDED;
      setConfigState((prev) => ({
        // An unchanged deployment keeps its identity so dependent reads are not restarted.
        config: prev.config && JSON.stringify(prev.config) === JSON.stringify(next) ? prev.config : next,
        read: readSucceeded(),
      }));
      return READ_OK;
    } catch (err) {
      console.warn('Config fetch error (backend may still be booting):', err);
      if (reqId !== configReqRef.current) return READ_SUPERSEDED;
      setConfigState((prev) => ({ config: prev.config, read: readFailed(prev.read, err) }));
      return readFailure(err);
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  return (
    <WalletProvider config={configState.config}>
      <SessionProvider>
        <AppContent config={configState.config} configRead={configState.read} onRefreshConfig={refreshConfig} />
      </SessionProvider>
    </WalletProvider>
  );
};
