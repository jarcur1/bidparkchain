import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Gavel,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { formatEther, parseEther } from 'ethers';
import { useWallet } from '../context/WalletContext';
import type { Listing } from '../types';
import { getBidEligibility, getChainNowSec, getMinimumBidWei } from '../utils/eligibility';
import { formatBalance, formatEth } from '../utils/formatters';
import { webProfile } from '../utils/networkProfile';
import { Dialog } from './Dialog';

interface BidModalProps {
  listing: Listing | null;
  onClose: () => void;
  onSubmitBid: (listing: Listing, amountEth: string) => Promise<void>;
  isSubmitting: boolean;
}

export const BidModal: React.FC<BidModalProps> = ({
  listing,
  onClose,
  onSubmitBid,
  isSubmitting,
}) => {
  const { walletState, wrongChain, balanceRead } = useWallet();
  // null = user has not edited; the amount then follows the live suggested bid.
  const [editedAmount, setEditedAmount] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const openedHighestBidRef = useRef<string | null>(listing ? listing.highestBid : null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  // Re-evaluate eligibility every second so cutoff disables the dialog without waiting for a poll.
  const [, setClockTick] = useState(0);
  const isOpen = listing !== null;
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);
  const nowSec = getChainNowSec();

  if (!listing) return null;

  const hasBids = parseEther(listing.highestBid) > 0n;
  const currentPrice = hasBids ? listing.highestBid : listing.minBid;
  const minimumWei = getMinimumBidWei(listing);
  const suggestedAmount = hasBids
    ? formatEther(parseEther(listing.highestBid) + parseEther('0.01'))
    : listing.minBid;
  const bidAmount = editedAmount ?? suggestedAmount;
  const eligibility = getBidEligibility(listing, walletState.address, nowSec);
  const priceChanged =
    openedHighestBidRef.current !== null && openedHighestBidRef.current !== listing.highestBid;

  let amountBelowMinimum: boolean;
  try {
    amountBelowMinimum = parseEther(bidAmount) < minimumWei;
  } catch {
    amountBelowMinimum = false;
  }

  const handleIncrement = (inc: string) => {
    try {
      setEditedAmount(formatEther(parseEther(bidAmount || formatEther(minimumWei)) + parseEther(inc)));
      setLocalError(null);
    } catch {
      setLocalError('Enter a decimal ETH amount with at most 18 decimal places.');
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (!eligibility.canBid) {
      setLocalError(eligibility.message);
      return;
    }

    if (wrongChain) {
      setLocalError(`Please switch to ${webProfile.networkName} (Chain ${webProfile.chainId}) to submit bids.`);
      return;
    }

    if (!walletState.address) {
      setLocalError(import.meta.env.VITE_BIDPARK_PROFILE !== 'sepolia'
        ? 'Wallet not connected. Connect a test or browser wallet.'
        : 'Wallet not connected. Connect a browser wallet.');
      return;
    }

    let numericBid: bigint;
    try {
      numericBid = parseEther(bidAmount);
    } catch {
      setLocalError('Enter a decimal ETH amount with at most 18 decimal places.');
      return;
    }
    if (numericBid <= 0n) {
      setLocalError('Please enter a positive ETH amount.');
      return;
    }

    if (numericBid < minimumWei) {
      setLocalError(
        hasBids
          ? `Bid must be strictly higher than the current winning bid of ${formatEth(listing.highestBid)} ETH.`
          : `Bid must be at least the starting minimum of ${formatEth(listing.minBid)} ETH.`
      );
      return;
    }

    // Only a balance from a successful, current read may decide bid affordability.
    if (balanceRead.status !== 'success' || walletState.balance === null) {
      setLocalError('Your wallet balance is unavailable or may be out of date. Refresh and try again.');
      return;
    }
    const balanceNum = parseEther(walletState.balance);
    if (numericBid > balanceNum) {
      setLocalError(
        `Insufficient ETH balance (${formatEth(walletState.balance)} ETH available).`
      );
      return;
    }

    try {
      await onSubmitBid(listing, bidAmount);
      onClose();
    } catch (err) {
      // The typed amount is retained; the parent has refreshed the listing so the dialog shows current state.
      setLocalError(err instanceof Error ? err.message : 'Failed to place bid');
    }
  };

  return (
    <Dialog
      className="modal-dialog modal-bid-dialog"
      labelledBy="bid-dialog-title"
      onClose={onClose}
      canClose={!isSubmitting}
      initialFocusRef={amountInputRef}
      focusFallback={() =>
        document.getElementById(`spot-card-${listing.id}`)?.querySelector<HTMLButtonElement>('.btn-card-secondary') ?? null
      }
    >
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-icon-title">
            <div className="icon-badge-forest">
              <Gavel size={18} />
            </div>
            <div>
              <h3 id="bid-dialog-title" className="modal-heading">
                Place Escrow Bid
              </h3>
              <p className="modal-subheading">Auction #{listing.id} • {listing.title}</p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body / Form */}
        <form onSubmit={handleFormSubmit} className="modal-form">
          <div className="bid-benchmarks-box">
            <div className="benchmark-col">
              <span className="benchmark-label">
                {hasBids ? 'Current Highest Bid' : 'Minimum Opening Bid'}
              </span>
              <span className="benchmark-val">{formatEth(currentPrice)} ETH</span>
            </div>
            <div className="benchmark-col">
              <span className="benchmark-label">Your Wallet Balance</span>
              <span className="benchmark-val">
                {formatBalance(walletState.balance, balanceRead)}
              </span>
            </div>
          </div>

          {/* Amount input */}
          <div className="form-field">
            <label htmlFor="bid-amount-input" className="form-label">
              Your New Bid Amount (ETH)
            </label>
            <div className="input-with-currency">
              <input
                id="bid-amount-input"
                type="text"
                inputMode="decimal"
                className="input-number-large"
                value={bidAmount}
                onChange={(e) => {
                  setEditedAmount(e.target.value);
                  setLocalError(null);
                }}
                disabled={isSubmitting || !eligibility.canBid}
                required
                ref={amountInputRef}
              />
              <span className="currency-suffix">ETH</span>
            </div>
          </div>

          {/* Quick Increment Chips */}
          <div className="chips-row">
            <span className="chips-label">Quick add:</span>
            {['0.01', '0.05', '0.1', '0.25'].map((inc) => (
              <button
                key={inc}
                type="button"
                className="chip-btn"
                onClick={() => handleIncrement(inc)}
                disabled={isSubmitting || !eligibility.canBid}
              >
                +{inc} ETH
              </button>
            ))}
          </div>

          {/* Escrow Mechanism Explainer */}
          <div className="bid-escrow-explainer">
            <ShieldCheck size={16} className="explainer-icon" />
            <div className="explainer-text">
              <strong>How escrow works:</strong> This transaction sends the <em>full bid amount</em>, not a top-up, and the contract holds it. If you are outbid, or raise your own bid, the earlier bid becomes a separate refund you withdraw from My Activity. Winning does not grant access to a real parking space.
            </div>
          </div>

          {/* Live eligibility / price notices */}
          {!eligibility.canBid && (
            <div className="form-error-alert" role="alert" data-testid="bid-blocked">
              <AlertCircle size={15} />
              <span>{eligibility.message} Your entered amount is kept but cannot be submitted.</span>
            </div>
          )}
          {eligibility.canBid && priceChanged && (
            <div className="form-error-alert" role="status" data-testid="bid-price-changed">
              <AlertCircle size={15} />
              <span>
                The price changed while this dialog was open. {hasBids ? 'Current highest bid' : 'Opening bid'}:{' '}
                {formatEth(currentPrice)} ETH.
                {amountBelowMinimum && (
                  <>
                    {' '}Your amount is now below the minimum of {formatEther(minimumWei)} ETH.{' '}
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() => {
                        setEditedAmount(formatEther(minimumWei));
                        setLocalError(null);
                        amountInputRef.current?.focus();
                      }}
                    >
                      Use minimum
                    </button>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Error notice */}
          {localError && (
            <div className="form-error-alert" role="alert">
              <AlertCircle size={15} />
              <span>{localError}</span>
            </div>
          )}

          <p className="sr-only" role="status">
            {isSubmitting ? 'Submitting bid to chain' : ''}
          </p>

          {/* Footer actions */}
          <div className="modal-actions-footer">
            <button
              type="button"
              className="btn-modal-cancel-action"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-modal-submit-bid"
              disabled={isSubmitting || !eligibility.canBid}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={16} className="is-spinning" />
                  <span>Submitting to Chain…</span>
                </>
              ) : (
                <>
                  <Gavel size={16} />
                  <span>Deposit {bidAmount ? `${bidAmount} ETH` : 'Bid'}</span>
                </>
              )}
            </button>
          </div>
        </form>
    </Dialog>
  );
};
