import type { RefObject } from 'react';
import type { WalletContextValue } from '../context/WalletContext';
import { createAuctionOnChain, getContractInstance, parseContractError, TransactionOutcomeUnknown } from '../services/blockchain';
import { createListingRecord, stageListingMetadata } from '../services/api';
import type { AppTab, Config, DeploymentIdentity, Listing, ListingsResponse, SpotMetadata, WalletState } from '../types';
import { deploymentKey } from '../utils/eligibility';
import { webProfile } from '../utils/networkProfile';
import { patchTransaction, type TxRecord } from '../utils/txStore';
import type { LoadListings } from './useListings';
import type { AddToast } from './useToasts';
import type { LinkReplacementRecord, MarkRegistered, TrackFn } from './useTransactions';

/** A confirmed auction whose off-chain metadata registration did not complete; retry without re-creating it. */
export interface PendingRegistration {
  auctionId: string;
  metadata: SpotMetadata;
  deployment: DeploymentIdentity;
  txHash?: string;
}

interface UseListingCreationOptions {
  walletState: WalletState;
  signer: WalletContextValue['signer'];
  wrongChain: boolean;
  refreshBalance: WalletContextValue['refreshBalance'];
  config: Config | null;
  configDeployment: string | null;
  deploymentRef: RefObject<string | null>;
  isActionBusy: boolean;
  setIsActionBusy: (busy: boolean) => void;
  ensureSignedIn: () => Promise<void>;
  preflightWrite: (listing?: Listing) => Promise<ListingsResponse | undefined>;
  reportUnknown: (err: TransactionOutcomeUnknown) => void;
  unconfirmedCreationRef: RefObject<string | null>;
  setUnconfirmedCreation: (hash: string | null) => void;
  pendingRegistration: PendingRegistration | null;
  setPendingRegistration: (registration: PendingRegistration | null) => void;
  markRegistered: MarkRegistered;
  linkReplacementRecord: LinkReplacementRecord;
  track: TrackFn;
  addToast: AddToast;
  loadListings: LoadListings;
  setSelectedListingId: (id: string | null) => void;
  setCurrentTab: (tab: AppTab) => void;
}

export function useListingCreation({
  walletState,
  signer,
  wrongChain,
  refreshBalance,
  config,
  configDeployment,
  deploymentRef,
  isActionBusy,
  setIsActionBusy,
  ensureSignedIn,
  preflightWrite,
  reportUnknown,
  unconfirmedCreationRef,
  setUnconfirmedCreation,
  pendingRegistration,
  setPendingRegistration,
  markRegistered,
  linkReplacementRecord,
  track,
  addToast,
  loadListings,
  setSelectedListingId,
  setCurrentTab,
}: UseListingCreationOptions) {
  const warnDuplicates = (listing: { duplicateSpaces: { spaceId: string }[] }) => {
    if (listing.duplicateSpaces.length === 0) return;
    const ids = listing.duplicateSpaces.map((d) => `#${d.spaceId}`).join(', ');
    addToast('info', 'Possible duplicate space', `Another host's space (${ids}) has the same address or location. Moderators have been notified; make sure you are not listing someone else's space.`);
  };

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

  return { handleCreateListing, handleResumeRegistration, handleLinkReplacement, handleRetryRegistration };
}
