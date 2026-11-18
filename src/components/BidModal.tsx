import React, { useEffect, useState } from 'react';
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
import { formatBalance, formatEth } from '../utils/formatters';

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
  const [bidAmount, setBidAmount] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Determine minimum next bid
  useEffect(() => {
    if (!listing) return;
    const hasBids = parseEther(listing.highestBid) > 0n;
    if (hasBids) {
      setBidAmount(formatEther(parseEther(listing.highestBid) + parseEther('0.01')));
    } else {
      setBidAmount(listing.minBid);
    }
    setLocalError(null);
  }, [listing]);

  // Handle escape key
  useEffect(() => {
    if (!listing) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [listing, onClose, isSubmitting]);

  if (!listing) return null;

  const hasBids = parseEther(listing.highestBid) > 0n;
  const currentPrice = hasBids ? listing.highestBid : listing.minBid;
  const minRequired = hasBids
    ? formatEther(parseEther(listing.highestBid) + 1n)
    : listing.minBid;

  const isOwner =
    Boolean(walletState.address) &&
    listing.owner.toLowerCase() === walletState.address?.toLowerCase();

  const handleIncrement = (inc: string) => {
    try {
      setBidAmount(formatEther(parseEther(bidAmount || minRequired) + parseEther(inc)));
      setLocalError(null);
    } catch {
      setLocalError('Enter a decimal ETH amount with at most 18 decimal places.');
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (wrongChain) {
      setLocalError('Please switch to Hardhat Local (Chain 31337) to submit bids.');
      return;
    }

    if (!walletState.address) {
      setLocalError('Wallet not connected. Connect a test or browser wallet.');
      return;
    }

    if (isOwner) {
      setLocalError('Spot owners cannot place bids on their own listing.');
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

    if (hasBids && numericBid <= parseEther(listing.highestBid)) {
      setLocalError(
        `Bid must be strictly higher than the current winning bid of ${formatEth(listing.highestBid)} ETH.`
      );
      return;
    }

    if (!hasBids && numericBid < parseEther(listing.minBid)) {
      setLocalError(
        `Bid must be at least the starting minimum of ${formatEth(listing.minBid)} ETH.`
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
      // Error handled by parent or captured here
      setLocalError(err instanceof Error ? err.message : 'Failed to place bid');
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!isSubmitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bid-dialog-title"
    >
      <div className="modal-dialog modal-bid-dialog" onClick={(e) => e.stopPropagation()}>
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
                  setBidAmount(e.target.value);
                  setLocalError(null);
                }}
                disabled={isSubmitting}
                required
                autoFocus
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
                disabled={isSubmitting}
              >
                +{inc} ETH
              </button>
            ))}
          </div>

          {/* Escrow Mechanism Explainer */}
          <div className="bid-escrow-explainer">
            <ShieldCheck size={16} className="explainer-icon" />
            <div className="explainer-text">
              <strong>Solidity Escrow Guarantee:</strong> Your full bid will be held in the smart contract. If outbid by another driver, your ETH is <em>instantly returned to your claimable balance</em> to withdraw anytime.
            </div>
          </div>

          {/* Error notice */}
          {localError && (
            <div className="form-error-alert" role="alert">
              <AlertCircle size={15} />
              <span>{localError}</span>
            </div>
          )}

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
              disabled={isSubmitting || isOwner}
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
      </div>
    </div>
  );
};
