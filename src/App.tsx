import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityView } from './components/ActivityView';
import { BidModal } from './components/BidModal';
import { CreateListingModal, type OwnedSpace } from './components/CreateListingModal';
import { DetailModal } from './components/DetailModal';
import { CampusScenarioBanner } from './components/CampusScenarioBanner';
import { DisclosuresBanner } from './components/DisclosuresBanner';
import { FilterBar } from './components/FilterBar';
import {
  DEFAULT_FILTERS,
  MY_LOCATION_LABEL,
  type Place,
  amenityOptions,
  describeFilters,
  destinationOptions,
  discoverListings,
  filtersFromSearch,
  filtersToSearch,
  resolveDestination,
  searchQuery,
} from './utils/discovery';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ReadStatusBanner, type ReadSource } from './components/ReadStatusBanner';
import { ParkingMap } from './components/ParkingMap';
import { SpotGrid } from './components/SpotGrid';
import { Toast } from './components/Toast';
import { WalletModal } from './components/WalletModal';
import { useWallet, WalletProvider } from './context/WalletContext';
import { SessionProvider, useSession } from './context/SessionContext';
import { ApiError, createListingRecord, fetchConfig, fetchListings, searchListings, searchListingsPages, stageListingMetadata } from './services/api';
import type { TxObserver } from './services/blockchain';
import { patchTransaction, readTransactions, recordTransaction, staleTransactionsFor, transactionsFor, type TxKind, type TxRecord } from './utils/txStore';
import { TransactionCenter } from './components/TransactionCenter';
import { Inbox, useInbox } from './components/Inbox';
import { HostWorkspace, heldWindows, ZoneList } from './components/HostWorkspace';
import { ResolverQueue, REVIEW_ACTIONS, submitReview } from './components/Disputes';
import { HostVerificationPanel, ModerationPanel, useVerifications } from './components/Verification';
import {
  cancelAuction,
  claimPayout,
  createAuctionOnChain,
  fetchBidAuctionIds,
  fetchHostSpaces,
  sendSpaceAction,
  type HostSpace,
  type SpaceAction,
  fetchPendingReturns,
  getContractInstance,
  parseContractError,
  placeBid,
  sendBookingAction,
  settleAuction,
  TransactionOutcomeUnknown,
  withdrawRefund,
} from './services/blockchain';
import { Interface, parseEther } from 'ethers';
import { BOOKING_ACTION_LABELS, type BookingAction } from './utils/booking';
import type {
  AppTab,
  ChainSnapshot,
  Config,
  DeploymentIdentity,
  FilterState,
  Listing,
  ListingsResponse,
  SearchListing,
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
  const { session, signIn: signInSession } = useSession();
  // Listing details are an off-chain write, so the API requires a wallet sign-in for them.
  const ensureSignedIn = async () => {
    if (session || await signInSession()) return;
    throw new Error('Sign in with your wallet to save listing details. Signing in proves wallet control only and moves no funds.');
  };

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
  const inbox = useInbox(session?.address ?? null);
  const verification = useVerifications(session?.address ?? null);
  const chain = listingsView.deploymentChanged ? null : listingsView.chain;

  // Navigation & View
  const [currentTab, setCurrentTab] = useState<AppTab>(() => (new URLSearchParams(window.location.search).get('tab') === 'activity' ? 'activity' : 'marketplace'));
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
  // The action a user started before connecting a wallet; it resumes once the wallet is ready.
  const [intent, setIntent] = useState<{ kind: 'bid'; listingId: string; title: string } | { kind: 'create' } | null>(null);

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
  const [filters, setFilters] = useState<FilterState>(() => filtersFromSearch(window.location.search));
  // Keep the URL in step with the filters so a reload or shared link restores them.
  useEffect(() => {
    const search = filtersToSearch(filters, window.location.search);
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
    }
  }, [filters]);

  // Every wallet transaction is recorded in the persisted transaction center, scoped to this
  // account and deployment, so a reload never loses a submitted transaction or committed metadata.
  const [txVersion, setTxVersion] = useState(0);
  const sessionTxIds = useRef(new Set<string>());
  const txScope = walletState.address && config && configDeployment
    ? { account: walletState.address, chainId: config.chainId, contract: config.contractAddress, deployment: configDeployment }
    : null;
  const track = (kind: TxKind, label: string, extra: Partial<TxRecord> = {}): { id: string | null; observe?: TxObserver } => {
    if (!txScope) return { id: null };
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionTxIds.current.add(id);
    recordTransaction({ id, kind, label, status: 'awaiting-wallet', scope: txScope, ...extra });
    setTxVersion((v) => v + 1);
    return { id, observe: (update) => { patchTransaction(id, update); setTxVersion((v) => v + 1); } };
  };
  const txRecords = txScope ? transactionsFor(txScope) : [];
  const staleTxCount = txScope ? staleTransactionsFor(txScope).length : 0;
  void txVersion; // re-read the store whenever a transaction changes

  // After a reload or reconnect, re-check transactions that were still in flight and pick up listings
  // the API already recovered from staged metadata. This only reads the chain; nothing is re-sent.
  useEffect(() => {
    if (!txScope || !provider || !config) return;
    let live = true;
    const iface = new Interface(config.abi);
    (async () => {
      for (const r of transactionsFor(txScope)) {
        if (!live) return;
        if (r.status === 'awaiting-wallet' && !sessionTxIds.current.has(r.id)) {
          patchTransaction(r.id, { status: 'unknown', error: 'The page reloaded before the wallet answered. Check your wallet activity.' });
        } else if ((r.status === 'submitted' || r.status === 'confirming') && r.hash && !sessionTxIds.current.has(r.id)) {
          const receipt = await provider.getTransactionReceipt(r.hash).catch(() => null);
          if (receipt && config.confirmation === 'finalized') {
            const finalized = await provider.getBlock('finalized').catch(() => null);
            if (!finalized || receipt.blockNumber > finalized.number) continue;
          }
          if (receipt) {
            let auctionId = r.auctionId;
            for (const log of r.kind === 'create' && !auctionId ? receipt.logs : []) {
              try {
                const parsed = iface.parseLog(log);
                if (parsed?.name === 'AuctionCreated') auctionId = parsed.args[0].toString();
              } catch { /* another contract's log */ }
            }
            patchTransaction(r.id, {
              status: receipt.status === 1 ? 'confirmed' : 'reverted',
              ...(r.kind === 'create' && auctionId ? { auctionId, registered: false } : {}),
            });
          } else if (!(await provider.getTransaction(r.hash).catch(() => null))) {
            patchTransaction(r.id, { status: 'unknown', error: 'The network no longer knows this transaction; it may have been replaced or dropped.' });
          }
        }
        const current = readTransactions().find((x) => x.id === r.id);
        if (current?.kind === 'create' && current.auctionId && !current.registered && listings.some((l) => l.id === current.auctionId)) {
          patchTransaction(r.id, { registered: true });
        }
      }
      if (live) setTxVersion((v) => v + 1);
    })();
    return () => { live = false; };
  }, [txScope?.account, txScope?.deployment, provider, config, listings]);

  const markRegistered = (auctionId: string) => {
    for (const r of readTransactions()) {
      if (r.kind === 'create' && r.auctionId === auctionId && !r.registered) patchTransaction(r.id, { registered: true });
    }
    setTxVersion((v) => v + 1);
  };

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
  const walletReadyRef = useRef(walletState.isReady);
  walletReadyRef.current = walletState.isReady;
  const chainRef = useRef(chain);
  chainRef.current = chain;

  const handleOpenBidModal = useCallback((listing: Listing) => {
    if (!walletReadyRef.current) {
      setIntent({ kind: 'bid', listingId: listing.id, title: listing.title });
      setIsWalletModalOpen(true);
      return;
    }
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

  useEffect(() => {
    if (!intent || !walletState.isReady) return;
    setIntent(null);
    setIsWalletModalOpen(false);
    if (intent.kind === 'create') setIsCreateOpen(true);
    else {
      const listing = listings.find((l) => l.id === intent.listingId);
      if (listing) handleOpenBidModal(listing);
    }
  }, [intent, walletState.isReady, listings, handleOpenBidModal]);

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
      const receipt = await placeBid(contract, listing.id, amountEth, config.confirmation,
        track('bid', `Bid ${amountEth} ETH on auction #${listing.id}`, { auctionId: listing.id }).observe);

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
      const msg = parseContractError(err, config?.abi);
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
    parkingEndSec: number,
    spaceId?: string,
    protectedBooking = false
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
      await ensureSignedIn();
      // Save the exact metadata before signing: if registration is lost after the transaction,
      // the server can still match the new auction's hash to these details.
      await stageListingMetadata(metadata, webProfile.id === 'sepolia' ? expectedDeployment : undefined);
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const created = track('create', `List "${metadata.title}"`, { metadata });
      const { receipt, auctionId } = await createAuctionOnChain(
        contract,
        metadata,
        minBidEth,
        bidEndSec,
        parkingStartSec,
        parkingEndSec,
        config.confirmation,
        created.observe,
        spaceId,
        protectedBooking,
      );
      if (created.id) patchTransaction(created.id, { auctionId, registered: false });

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
        markRegistered(auctionId);
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
      const msg = parseContractError(err, config?.abi);
      addToast('error', 'Listing Notice', msg);
      throw new Error(msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  // Registers a confirmed listing from the transaction center using its stored, immutable metadata.
  // No second createAuction is ever sent; only the off-chain details are registered.
  const handleResumeRegistration = async (record: TxRecord) => {
    if (isActionBusy || !config || !record.auctionId || !record.metadata || record.scope.deployment !== configDeployment) return;
    setIsActionBusy(true);
    try {
      await ensureSignedIn();
      await createListingRecord(record.auctionId, record.metadata, webProfile.id === 'sepolia' ? {
        chainId: config.chainId, contractAddress: config.contractAddress,
        deploymentBlock: config.deploymentBlock, deploymentBlockHash: config.deploymentBlockHash,
      } : undefined);
      markRegistered(record.auctionId);
      addToast('success', 'Registration Confirmed', `Auction #${record.auctionId} metadata registered successfully.`);
      await loadListings();
    } catch (err) {
      addToast('error', 'Registration failed', err instanceof Error ? err.message : String(err));
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
      await ensureSignedIn();
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
      markRegistered(auctionId);
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
      const receipt = await withdrawRefund(contract, config.confirmation, track('withdraw', 'Withdraw refund').observe);

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
      const msg = parseContractError(err, config?.abi);
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
      const receipt = await settleAuction(contract, listing.id, config.confirmation,
        track('settle', `Settle auction #${listing.id}`, { auctionId: listing.id }).observe);

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
      const msg = parseContractError(err, config?.abi);
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
      const receipt = await cancelAuction(contract, listing.id, config.confirmation,
        track('cancel', `Cancel auction #${listing.id}`, { auctionId: listing.id }).observe);

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
      const msg = parseContractError(err, config?.abi);
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
      const receipt = await claimPayout(contract, listing.id, config.confirmation,
        track('claim', `Claim payout for auction #${listing.id}`, { auctionId: listing.id }).observe);

      addToast(
        'success',
        'Payout Claimed!',
        listing.booking?.protected
          ? `Host payout of ${formatEth(listing.highestBid)} ETH credited to your refund balance. Withdraw it from My Activity.`
          : `Host payout of ${formatEth(listing.highestBid)} ETH released to your wallet.`,
        receipt.hash
      );

      await Promise.all([loadListings(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
      const msg = parseContractError(err, config?.abi);
      addToast('error', 'Payout Claim Failed', msg);
    } finally {
      setIsActionBusy(false);
    }
  };

  const ZERO_REFERENCE = '0x' + '0'.repeat(64);
  // Protected-booking actions (docs/booking-policy.md). Refunds and payouts are credits to withdraw.
  const handleBookingAction = async (listing: Listing, action: BookingAction, text = '') => {
    if (isActionBusy) return;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return;
    }
    const label = BOOKING_ACTION_LABELS[action];
    setIsActionBusy(true);
    try {
      await preflightWrite(listing);
      // Reports and decisions carry only an opaque reference on-chain: the evidence or reason is stored
      // server-side, readable by the parties and resolvers only.
      const reference = REVIEW_ACTIONS.includes(action) ? await submitReview(listing.id, action, text) : ZERO_REFERENCE;
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await sendBookingAction(contract, listing.id, action, reference, config.confirmation,
        track('booking', `${label} for auction #${listing.id}`, { auctionId: listing.id }).observe);
      addToast('success', label, `Confirmed on-chain for auction #${listing.id}.`, receipt.hash);
      await Promise.all([loadListings(), refreshBalance()]);
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return;
      }
      addToast('error', `${label} failed`, parseContractError(err, config?.abi));
    } finally {
      setIsActionBusy(false);
    }
  };

  // Filter & Sort Logic
  // Optional browser location: asked only when the driver presses the button, rounded, kept in memory
  // and used only as the `near` value of the search query.
  const [myLocation, setMyLocation] = useState<Place | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationMessage('This browser cannot share a location. Type a destination instead.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocationMessage(null);
        setMyLocation({ label: MY_LOCATION_LABEL, latitude: Math.round(pos.coords.latitude * 1000) / 1000, longitude: Math.round(pos.coords.longitude * 1000) / 1000 });
        setFilters((f) => ({ ...f, destination: MY_LOCATION_LABEL }));
      },
      () => {
        setLocating(false);
        setLocationMessage('Location not shared. Type a destination or pick a landmark instead.');
      },
      { maximumAge: 60_000, timeout: 15_000 },
    );
  }, []);
  const destinationChoices = useMemo(
    () => (myLocation ? [myLocation, ...destinationOptions(listings)] : destinationOptions(listings)),
    [listings, myLocation],
  );
  const destination = resolveDestination(filters.destination, destinationChoices);
  const { listings: filteredListings, distances } = useMemo(
    () => discoverListings(listings, filters, getChainNowSec(), destination),
    [listings, filters, destination]
  );

  // The server answers the same filters with bounded, block-pinned pages. Until its answer for the
  // current query and deployment arrives (or if it fails), the loaded snapshot is filtered locally.
  const searchKey = searchQuery(filters, destination);
  const [serverSearch, setServerSearch] = useState<{
    key: string; deployment: string | null; listings: SearchListing[]; total: number; nextCursor: string | null; loadingMore: boolean;
    /** Pages loaded, so a listings refresh can reload as many. */
    pages: number;
  } | null>(null);
  const serverSearchRef = useRef(serverSearch);
  serverSearchRef.current = serverSearch;
  const [searchNonce, setSearchNonce] = useState(0);
  const snapshotBlock = listingsView.chain?.blockNumber;
  const listingsDeployment = listingsView.deployment;
  useEffect(() => {
    if (snapshotBlock === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      // A refresh of the same search reloads the pages already shown, from the new head.
      const prev = serverSearchRef.current;
      const keep = prev && prev.key === searchKey && prev.deployment === listingsDeployment ? prev.pages : 1;
      searchListingsPages(searchKey, keep)
        .then((r) => {
          if (!live) return;
          const deployment = r.chain ? deploymentKey(r.chain) : null;
          setServerSearch(deployment === listingsDeployment
            ? { key: searchKey, deployment, listings: r.listings, total: r.total, nextCursor: r.nextCursor, loadingMore: false, pages: keep }
            : null);
        })
        .catch(() => { if (live) setServerSearch(null); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [searchKey, snapshotBlock, listingsDeployment, searchNonce]);
  const serverResult = serverSearch?.key === searchKey && serverSearch.deployment === listingsDeployment ? serverSearch : null;
  const shownListings: Listing[] = serverResult ? serverResult.listings : filteredListings;
  const shownDistances = useMemo(
    () => serverResult
      ? new Map(serverResult.listings.flatMap((l) => (l.distanceKm === undefined ? [] : [[l.id, l.distanceKm] as const])))
      : distances,
    [serverResult, distances]
  );
  const loadMoreResults = useCallback(async () => {
    const current = serverSearch;
    if (!current?.nextCursor || current.loadingMore) return;
    setServerSearch({ ...current, loadingMore: true });
    try {
      const page = await searchListings(current.key, current.nextCursor);
      setServerSearch((s) => s?.key === current.key && s.nextCursor === current.nextCursor
        ? { ...s, listings: [...s.listings, ...page.listings], nextCursor: page.nextCursor, loadingMore: false, pages: s.pages + 1 }
        : s);
    } catch (err) {
      // A cursor whose block was replaced starts the search again from the first page.
      if (err instanceof ApiError && err.status === 409) setSearchNonce((n) => n + 1);
      setServerSearch((s) => (s === null ? s : { ...s, loadingMore: false }));
    }
  }, [serverSearch]);

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

  // Spaces this wallet owns or may list on, read from the chain, reloaded after each space action.
  const [spacesNonce, setSpacesNonce] = useState(0);
  const [hostSpacesState, setHostSpacesState] = useState<{ key: string; spaces: HostSpace[]; error: string | null }>({ key: '', spaces: [], error: null });
  const hostSpacesKey = walletState.address && configDeployment && walletState.isReady ? `${walletState.address}|${configDeployment}` : '';
  useEffect(() => {
    if (!hostSpacesKey || !provider || !config?.contractAddress) return;
    let live = true;
    const contract = getContractInstance(config.contractAddress, config.abi, provider);
    fetchHostSpaces(contract, walletState.address as string, config.deploymentBlock, config.confirmation).then(
      (spaces) => { if (live) setHostSpacesState({ key: hostSpacesKey, spaces, error: null }); },
      (err) => { if (live) setHostSpacesState({ key: hostSpacesKey, spaces: [], error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [hostSpacesKey, spacesNonce, provider, config]);
  const hostSpaces = hostSpacesState.key === hostSpacesKey ? hostSpacesState.spaces : [];

  // The wallet's spaces and the windows each still holds, mirroring the contract's holdsWindow rule.
  const ownedSpaces = useMemo<OwnedSpace[]>(() => {
    if (!walletState.address) return [];
    const now = getChainNowSec();
    const addr = walletState.address.toLowerCase();
    const spaces = new Map<string, OwnedSpace>();
    for (const l of listings) {
      if (l.owner.toLowerCase() === addr && !spaces.has(l.spaceId)) spaces.set(l.spaceId, { id: l.spaceId, title: l.title, held: [] });
    }
    for (const h of hostSpaces) {
      if (!spaces.has(h.id)) {
        const latest = listings.find((l) => l.spaceId === h.id);
        spaces.set(h.id, { id: h.id, title: latest?.title ?? 'No listings yet', held: [], lister: h.isLister });
      }
    }
    for (const space of spaces.values()) {
      space.title = listings.find((l) => l.spaceId === space.id)?.title ?? space.title;
      space.held = heldWindows(listings, space.id, now);
    }
    return [...spaces.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }, [listings, hostSpaces, walletState.address]);

  // Space-control transactions (listers, transfer, time zone, blocked dates): sign, then re-read the chain.
  const handleSpaceAction = async (action: SpaceAction, label: string): Promise<boolean> => {
    if (isActionBusy) return false;
    if (!config?.contractAddress || !config.abi || !walletState.isReady || wrongChain || !signer) {
      addToast('error', 'Wallet Error', 'Wallet is not connected or connected to wrong network.');
      return false;
    }
    setIsActionBusy(true);
    try {
      await preflightWrite();
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      const receipt = await sendSpaceAction(contract, action, config.confirmation, track('space', label).observe);
      addToast('success', 'Space updated', label, receipt.hash);
      setSpacesNonce((n) => n + 1);
      await loadListings();
      return true;
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        reportUnknown(err);
        return false;
      }
      addToast('error', 'Space action failed', parseContractError(err, config?.abi));
      return false;
    } finally {
      setIsActionBusy(false);
    }
  };

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
          if (!walletState.isReady) {
            setIntent({ kind: 'create' });
            setIsWalletModalOpen(true);
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
        inboxUnread={session ? (inbox.data && !inbox.error ? inbox.data.unread : null) : undefined}
        onOpenInbox={() => {
          setCurrentTab('activity');
          requestAnimationFrame(() => document.getElementById('inbox-title')?.scrollIntoView({ block: 'start' }));
        }}
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
              destinationChoices={destinationChoices}
              destination={destination}
              onUseLocation={useMyLocation}
              locationMessage={locationMessage}
              locating={locating}
              amenityChoices={amenityOptions(listings, filters.amenities)}
              totalSpots={listings.length}
              filteredCount={serverResult ? serverResult.total : filteredListings.length}
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
                    listings={shownListings}
                    status={listingsView.read.status}
                    error={listingsView.read.error}
                    onRetry={() => void retrySource('Listings', loadListings)}
                    currentAddress={walletState.address}
                    selectedListingId={selectedListingId}
                    onSelectListing={handleSelectListing}
                    onOpenBid={handleOpenBidModal}
                    onOpenDetail={handleOpenDetailModal}
                    onSettle={handleSettleListing}
                    onResetFilters={() => setFilters(DEFAULT_FILTERS)}
                    activeFilters={describeFilters(filters, destination)}
                    distances={shownDistances}
                    destinationLabel={destination?.label ?? null}
                    more={serverResult && {
                      remaining: serverResult.total - serverResult.listings.length,
                      loading: serverResult.loadingMore,
                      onLoad: () => void loadMoreResults(),
                    }}
                  />
                </div>
              )}

              {/* Map Column */}
              {(viewMode === 'split' || viewMode === 'map') && (
                <div className="layout-map-column">
                  <ParkingMap
                    listings={shownListings}
                    area={filters.area}
                    onSearchArea={(area) => setFilters((f) => ({ ...f, area }))}
                    onClearArea={() => setFilters((f) => ({ ...f, area: '' }))}
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
            onConnectWallet={() => setIsWalletModalOpen(true)}
            isActionBusy={isActionBusy}
            deployment={config ? { chainId: config.chainId, contractAddress: config.contractAddress } : null}
          />
        )}
        {currentTab === 'activity' && session && (
          <Inbox
            inbox={inbox}
            onOpenListing={(auctionId) => {
              const listing = listings.find((l) => l.id === auctionId);
              if (listing) handleOpenDetailModal(listing);
              else addToast('info', 'Listing not available', `Auction #${auctionId} is not in the current listings.`);
            }}
            deployment={config ? { chainId: config.chainId, contractAddress: config.contractAddress } : null}
            timeZoneOf={(auctionId) => listings.find((l) => l.id === auctionId)?.timeZone}
          />
        )}
        {currentTab === 'activity' && hostSpacesKey && (
          <>
            <ZoneList />
            <HostWorkspace
              key={`${hostSpacesKey}|${Boolean(session)}`}
              signedIn={Boolean(session)}
              spaces={hostSpaces}
              spacesError={hostSpacesState.key === hostSpacesKey ? hostSpacesState.error : null}
              listings={listings}
              verifications={verification.verifications}
              isActionBusy={isActionBusy}
              onSpaceAction={handleSpaceAction}
              onPublish={handleCreateListing}
              onSignIn={() => void signInSession()}
            />
          </>
        )}
        {currentTab === 'activity' && session && (
          <HostVerificationPanel spaces={ownedSpaces.filter((space) => !space.lister)} state={verification} />
        )}
        {currentTab === 'activity' && session && verification.moderator && <ModerationPanel />}
        {currentTab === 'activity' && session && (
          <ResolverQueue
            refreshKey={listingsView.chain?.blockNumber}
            nowSec={getChainNowSec()}
            busy={isActionBusy}
            onAct={async (auctionId, action, text) => {
              const listing = listings.find((l) => l.id === auctionId);
              if (listing) await handleBookingAction(listing, action, text);
              else addToast('info', 'Listing not available', `Auction #${auctionId} is not in the current listings.`);
            }}
          />
        )}
        {currentTab === 'activity' && txScope && (
          <TransactionCenter
            records={txRecords}
            staleCount={staleTxCount}
            explorerUrl={config?.explorerUrl}
            onCompleteRegistration={(record) => void handleResumeRegistration(record)}
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
        chainId={config?.chainId}
        currentAddress={walletState.address}
        signedIn={Boolean(session)}
        onClose={() => setDetailTarget(null)}
        onOpenBid={handleOpenBidModal}
        onSettle={handleSettleListing}
        onCancel={handleCancelListing}
        onClaimPayout={handleClaimPayout}
        onBookingAction={handleBookingAction}
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
        spaces={ownedSpaces}
      />

      {/* Wallet Management Modal */}
      <WalletModal
        isOpen={isWalletModalOpen}
        onClose={() => { setIsWalletModalOpen(false); setIntent(null); }}
        continueLabel={intent ? (intent.kind === 'create' ? 'list a spot' : `bid on ${intent.title}`) : undefined}
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
