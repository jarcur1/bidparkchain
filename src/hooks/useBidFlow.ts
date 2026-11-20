import type { RefObject } from 'react';
import { parseEther } from 'ethers';
import type { WalletContextValue } from '../context/WalletContext';
import { getContractInstance, parseContractError, placeBid, TransactionOutcomeUnknown } from '../services/blockchain';
import type { Config, Listing, ListingsResponse, WalletState } from '../types';
import {
  deploymentKey,
  getBidEligibility,
  getChainNowSec,
  getMinimumBidWei,
  type ListingTarget,
} from '../utils/eligibility';
import { resolveSnapshotListing } from '../utils/history';
import { webProfile } from '../utils/networkProfile';
import type { LoadListings } from './useListings';
import type { LoadPendingRefunds } from './useRefunds';
import type { AddToast } from './useToasts';
import type { TrackFn } from './useTransactions';

/** A bid rejected by revalidation against current chain state; no transaction was sent. */
export class BidPreflightError extends Error {}

interface UseBidFlowOptions {
  walletState: WalletState;
  signer: WalletContextValue['signer'];
  isCurrentSigner: WalletContextValue['isCurrentSigner'];
  wrongChain: boolean;
  refreshBalance: WalletContextValue['refreshBalance'];
  config: Config | null;
  configDeployment: string | null;
  deploymentRef: RefObject<string | null>;
  isActionBusy: boolean;
  setIsActionBusy: (busy: boolean) => void;
  bidTarget: ListingTarget | null;
  preflightWrite: (listing?: Listing) => Promise<ListingsResponse | undefined>;
  reportUnknown: (err: TransactionOutcomeUnknown) => void;
  loadListings: LoadListings;
  loadPendingRefunds: LoadPendingRefunds;
  track: TrackFn;
  addToast: AddToast;
}

export function useBidFlow({
  walletState,
  signer,
  isCurrentSigner,
  wrongChain,
  refreshBalance,
  config,
  configDeployment,
  deploymentRef,
  isActionBusy,
  setIsActionBusy,
  bidTarget,
  preflightWrite,
  reportUnknown,
  loadListings,
  loadPendingRefunds,
  track,
  addToast,
}: UseBidFlowOptions) {
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
      const current = resolveSnapshotListing(fresh, bidTarget);
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
        throw new Error('Transaction submitted; finality not established. Check the explorer before bidding again.', { cause: err });
      }
      if (err instanceof BidPreflightError) throw err;
      const msg = parseContractError(err, config?.abi);
      addToast('error', 'Bid Submission Failed', msg);
      // The chain may have moved (competing bid, cutoff); refresh so the open dialog shows current state.
      void loadListings();
      throw new Error(msg, { cause: err });
    } finally {
      setIsActionBusy(false);
    }
  };

  return { handlePlaceBid };
}
