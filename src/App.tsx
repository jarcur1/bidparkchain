import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityView } from './components/ActivityView';
import { BidModal } from './components/BidModal';
import { CreateListingModal } from './components/CreateListingModal';
import { DetailModal } from './components/DetailModal';
import { CampusScenarioBanner } from './components/CampusScenarioBanner';
import { DisclosuresBanner } from './components/DisclosuresBanner';
import { FilterBar } from './components/FilterBar';
import { PresenterSkip } from './components/PresenterSkip';
import {
  DEFAULT_FILTERS,
  amenityOptions,
  describeFilters,
} from './utils/discovery';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { ReadStatusBanner, type ReadSource } from './components/ReadStatusBanner';
import { SearchFailureNotice } from './components/SearchFailureNotice';
import { ParkingMap } from './components/ParkingMap';
import { SpotGrid } from './components/SpotGrid';
import { Toast } from './components/Toast';
import { WalletModal } from './components/WalletModal';
import { useWallet, WalletProvider } from './context/WalletContext';
import { SessionProvider, useSession } from './context/SessionContext';
import { useToasts } from './hooks/useToasts';
import { useListingSearch } from './hooks/useListingSearch';
import { useListings } from './hooks/useListings';
import { useRefunds } from './hooks/useRefunds';
import { useTransactions } from './hooks/useTransactions';
import { useHostSpaces } from './hooks/useHostSpaces';
import { BidPreflightError, useBidFlow } from './hooks/useBidFlow';
import { createListingRecord, fetchConfig, stageListingMetadata } from './services/api';
import type { TxObserver } from './services/blockchain';
import { patchTransaction, type TxRecord } from './utils/txStore';
import { TransactionCenter } from './components/TransactionCenter';
import { Inbox, InboxAnnouncer, useInbox } from './components/Inbox';
import { HostWorkspace, ZoneList } from './components/HostWorkspace';
import { ResolverQueue, REVIEW_ACTIONS, submitReview } from './components/Disputes';
import { HostVerificationPanel, ModerationPanel, useVerifications } from './components/Verification';
import {
  cancelAuction,
  claimPayout,
  createAuctionOnChain,
  fetchSpaceAttestation,
  sendSpaceAttestation,
  type SpaceAttestation,
  sendSpaceAction,
  type SpaceAction,
  getContractInstance,
  parseContractError,
  sendBookingAction,
  settleAuction,
  TransactionOutcomeUnknown,
  withdrawRefund,
} from './services/blockchain';
import { BOOKING_ACTION_LABELS, type BookingAction } from './utils/booking';
import type {
  AppTab,
  Config,
  DeploymentIdentity,
  Listing,
  ListingsResponse,
  SpotMetadata,
} from './types';
import {
  deploymentKey,
  getBidEligibility,
  getChainNowSec,
  makeListingTarget,
  resolveListing,
  targetKey,
  type ListingTarget,
} from './utils/eligibility';
import { formatEth } from './utils/formatters';
import { resolveSnapshotListing, unregisteredListing } from './utils/history';
import { webProfile } from './utils/networkProfile';
import {
  LOADING_READ,
  READ_OK,
  READ_SUPERSEDED,
  readFailed,
  readFailure,
  readSucceeded,
  type ReadResult,
  type ReadState,
} from './utils/readState';

export const deploymentKeyOf = (config: Config | null) =>
  config
    ? `${config.chainId}:${config.contractAddress.toLowerCase()}:${config.deploymentBlock}:${config.deploymentBlockHash}`
    : null;

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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isActionBusy, setIsActionBusy] = useState(false);

  // Never show listings read from a different deployment alongside the current config.
  const configDeployment = deploymentKeyOf(config);
  const deploymentRef = useRef(configDeployment);
  const configRef = useRef(config);
  configRef.current = config;
  deploymentRef.current = configDeployment;
  const { listingsView, listings, chain, calendarSnapshot, loadListings } = useListings({ deploymentRef, configDeployment, onRefreshConfig });
  const inbox = useInbox(session?.address ?? null);
  const verification = useVerifications(session?.address ?? null);

  // Navigation & View
  const [currentTab, setCurrentTab] = useState<AppTab>(() => (new URLSearchParams(window.location.search).get('tab') === 'activity' ? 'activity' : 'marketplace'));
  const [viewMode, setViewMode] = useState<'split' | 'cards' | 'map'>('split');
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);

  // Modals
  // Dialogs hold a stable identity (deployment + auction id + metadata hash), never a listing snapshot.
  const [detailTarget, setDetailTarget] = useState<ListingTarget | null>(null);
  const [changeTarget, setChangeTarget] = useState<Listing | null>(null);
  const [bidTarget, setBidTarget] = useState<ListingTarget | null>(null);
  // Auctions without registered details can still be opened from the history, with contract data only.
  const openable = useMemo(
    () => [...listings, ...listingsView.unindexed.map(unregisteredListing)],
    [listings, listingsView.unindexed]
  );
  const detailListing = useMemo(
    () => resolveListing(openable, chain, detailTarget),
    [openable, chain, detailTarget]
  );
  const bidModalListing = useMemo(
    () => resolveListing(openable, chain, bidTarget),
    [openable, chain, bidTarget]
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

  // Notifications
  const { toasts, addToast, dismissToast } = useToasts();

  // Search & Filter State
  const {
    filters, setFilters, useMyLocation, locating, locationMessage, destinationChoices, destination,
    filteredListings, shownListings, shownDistances, serverResult, searchNotice, setSearchNonce, loadMoreResults,
  } = useListingSearch({ listings, snapshotBlock: listingsView.chain?.blockNumber, listingsDeployment: listingsView.deployment });

  // Every wallet transaction is recorded in the persisted transaction center, scoped to this
  // account and deployment, so a reload never loses a submitted transaction or committed metadata.
  const { txScope, track, txRecords, staleTxCount, markRegistered, linkReplacementRecord } = useTransactions({
    account: walletState.address, config, configDeployment, provider, listings, addToast,
  });

  const warnDuplicates = (listing: { duplicateSpaces: { spaceId: string }[] }) => {
    if (listing.duplicateSpaces.length === 0) return;
    const ids = listing.duplicateSpaces.map((d) => `#${d.spaceId}`).join(', ');
    addToast('info', 'Possible duplicate space', `Another host's space (${ids}) has the same address or location. Moderators have been notified; make sure you are not listing someone else's space.`);
  };

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

  const { refundRead, claimableRefundWei, myBidAuctionIds, loadPendingRefunds } = useRefunds({ walletState, provider, config, configDeployment });

  // Manual refresh all: reports what each source actually did.
  const refreshAll = useCallback(async (forceFresh: boolean) => {
    setIsRefreshing(true);
    try {
      const sources: [string, Promise<ReadResult>][] = [
        ['Configuration', onRefreshConfig()],
        ['Listings', loadListings(false, forceFresh)],
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
  const handleRefreshAll = useCallback(() => refreshAll(false), [refreshAll]);
  // After a chain-time skip the listings read must start after the skip, never share a pre-skip in-flight read.
  const handleRefreshAfterSkip = useCallback(() => refreshAll(true), [refreshAll]);

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
    if (target && !resolveSnapshotListing(fresh, target)) {
      throw new BidPreflightError('This auction is no longer available. No transaction was sent.');
    }
    return fresh;
  };

  const reportUnknown = (err: TransactionOutcomeUnknown) => {
    addToast('info', 'Transaction submitted; finality not established', 'Check the transaction in the explorer before taking further action.', err.hash);
  };

  const { handlePlaceBid } = useBidFlow({
    walletState, signer, isCurrentSigner, wrongChain, refreshBalance, config, configDeployment, deploymentRef,
    isActionBusy, setIsActionBusy, bidTarget, preflightWrite, reportUnknown, loadListings, loadPendingRefunds, track, addToast,
  });

  // Handle Create Listing
  const handleCreateListing = async (
    metadata: SpotMetadata,
    minBidEth: string,
    bidEndSec: number,
    parkingStartSec: number,
    parkingEndSec: number,
    spaceId?: string,
    protectedBooking = false,
    replaces?: string,
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
      const created = track('create', replaces ? `List "${metadata.title}" (replaces #${replaces})` : `List "${metadata.title}"`, { metadata, replaces });
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
        warnDuplicates(webProfile.id === 'sepolia'
          ? await createListingRecord(auctionId, metadata, expectedDeployment)
          : await createListingRecord(auctionId, metadata));
        markRegistered(auctionId);
        setPendingRegistration(null);
      } catch (postErr) {
        setPendingRegistration({ auctionId, metadata, deployment: expectedDeployment, txHash: receipt.hash });
        const errDetail = postErr instanceof Error ? postErr.message : String(postErr);
        throw new Error(
          `Auction #${auctionId} is confirmed on-chain, but metadata registration failed: ${errDetail}. You can retry registration below without re-creating the auction.`, { cause: postErr }
        );
      }

      if (replaces) await linkReplacementRecord(created.id, replaces, auctionId, expectedDeployment);

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
        throw new Error('Transaction submitted; finality not established. Check the explorer before creating another auction.', { cause: err });
      }
      const msg = parseContractError(err, config?.abi);
      addToast('error', 'Listing Notice', msg);
      throw new Error(msg, { cause: err });
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

  // Retries a replacement link that did not reach the API, from My Activity → Transactions. Repeating it is safe.
  const handleLinkReplacement = async (record: TxRecord) => {
    if (isActionBusy || !config || !record.auctionId || !record.replaces || record.linked || record.scope.deployment !== configDeployment) return;
    setIsActionBusy(true);
    try {
      await ensureSignedIn();
      await linkReplacementRecord(record.id, record.replaces, record.auctionId, {
        chainId: config.chainId,
        contractAddress: config.contractAddress,
        deploymentBlock: config.deploymentBlock,
        deploymentBlockHash: config.deploymentBlockHash,
      });
    } catch (err) {
      addToast('error', 'Replacement not linked', err instanceof Error ? err.message : String(err));
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
      warnDuplicates(webProfile.id === 'sepolia'
        ? await createListingRecord(auctionId, metadata, pendingRegistration.deployment)
        : await createListingRecord(auctionId, metadata));
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
      throw new Error(msg, { cause: err });
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

  const { hostSpacesKey, hostSpacesState, hostSpaces, ownedSpaces, setSpacesNonce } = useHostSpaces({ walletState, provider, config, configDeployment, listings });

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

  const moderationContract = useMemo(
    () => provider && config && hostSpacesKey ? getContractInstance(config.contractAddress, config.abi, provider) : null,
    [provider, config, hostSpacesKey],
  );
  const readInventoryMode = useCallback(async (): Promise<boolean> => {
    if (!moderationContract || !config) throw new Error('The marketplace deployment is unavailable.');
    return moderationContract.verifiedInventoryRequired({ blockTag: config.confirmation === 'finalized' ? 'finalized' : 'latest' });
  }, [moderationContract, config]);
  const readModerationInventory = useCallback(async (spaceId: string) => {
    if (!moderationContract || !config || !session) throw new Error('Sign in to check on-chain verification.');
    return fetchSpaceAttestation(moderationContract, spaceId, session.address, config.confirmation);
  }, [moderationContract, config, session]);

  async function handleAttestation(decision: SpaceAttestation, observe: TxObserver) {
    if (!signer || !walletState.isReady || wrongChain || !session || !verification.moderator || !config || !configDeployment || isActionBusy) {
      throw new Error('Connect an authorized reviewer wallet before signing.');
    }
    setIsActionBusy(true);
    try {
      await preflightWrite();
      if (!await readInventoryMode()) throw new Error('This deployment does not enforce verified inventory.');
      const current = await readModerationInventory(decision.spaceId);
      const block = await provider?.getBlock(config.deploymentBlock);
      if (!block?.hash || block.hash.toLowerCase() !== config.deploymentBlockHash.toLowerCase()) {
        throw new Error('The wallet RPC is not serving the reviewed deployment. No transaction was sent.');
      }
      const response = await fetch(`/api/moderation/verifications/${encodeURIComponent(decision.spaceId)}/attestation`);
      if (!response.ok) throw new Error('Could not confirm the current moderation decision. No transaction was sent.');
      const review = await response.json() as { contractAddress: string; reviewer: string; host: string; epoch: string | null; action: string | null };
      const action = /^0x0{64}$/i.test(decision.metadataHash) ? 'revoke' : 'approve';
      if (review.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase() || review.action !== action ||
          review.reviewer.toLowerCase() !== session.address.toLowerCase() ||
          review.host.toLowerCase() !== current.owner.toLowerCase() ||
          (action === 'approve' && review.epoch !== current.epoch)) {
        throw new Error('The review does not match this action or ownership period. Refresh the queue or request new proof.');
      }
      if (!isCurrentSigner(signer) || deploymentRef.current !== configDeployment) {
        throw new Error('The active wallet or deployment changed. No transaction was sent.');
      }
      if (!current.canVerify || current.owner.toLowerCase() !== decision.owner.toLowerCase() || current.epoch !== decision.epoch) {
        throw new Error('The verifier role or space ownership changed. Check on-chain verification before signing.');
      }
      const label = `Attest verification for space #${decision.spaceId}`;
      const tracked = track('space', label).observe;
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      await sendSpaceAttestation(contract, decision, config.confirmation, (update) => {
        tracked?.(update);
        observe(update);
      });
      void loadListings();
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) throw err;
      throw new Error(parseContractError(err, config.abi), { cause: err });
    } finally {
      setIsActionBusy(false);
    }
  }

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
            {import.meta.env.VITE_BIDPARK_PROFILE === 'local' && <PresenterSkip onRefresh={handleRefreshAfterSkip} />}
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

            <SearchFailureNotice error={searchNotice?.error ?? null} onRetry={() => setSearchNonce((n) => n + 1)} />

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
                      error: serverResult.pageError,
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
            unindexed={listingsView.unindexed}
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
            onChangeListing={setChangeTarget}
            onConnectWallet={() => setIsWalletModalOpen(true)}
            isActionBusy={isActionBusy}
            deployment={config ? { chainId: config.chainId, contractAddress: config.contractAddress, snapshotBlock: calendarSnapshot?.blockNumber, snapshotTime: calendarSnapshot?.blockTimestamp } : null}
          />
        )}
        {session && <InboxAnnouncer inbox={inbox} timeZoneOf={(auctionId) => listings.find((l) => l.id === auctionId)?.timeZone} />}
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
              account={session?.address ?? null}
              changeTarget={changeTarget}
              onChangeDone={() => setChangeTarget(null)}
              onBookingAction={handleBookingAction}
              onCancelListing={handleCancelListing}
              onSignIn={() => void signInSession()}
            />
          </>
        )}
        {currentTab === 'activity' && session && (
          <HostVerificationPanel spaces={ownedSpaces.filter((space) => !space.lister)} state={verification} />
        )}
        {currentTab === 'activity' && session && verification.moderator && hostSpacesKey && (
          <ModerationPanel
            key={hostSpacesKey}
            readInventoryMode={readInventoryMode}
            readInventory={readModerationInventory}
            onAttest={handleAttestation}
            busy={isActionBusy}
          />
        )}
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
            onLinkReplacement={(record) => void handleLinkReplacement(record)}
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
        snapshotBlock={calendarSnapshot?.blockNumber}
        snapshotTime={calendarSnapshot?.blockTimestamp}
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
