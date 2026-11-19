import React, { useEffect, useState } from 'react';
import {
  Calendar,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Gavel,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  Warehouse,
  X,
  Zap,
} from 'lucide-react';
import type { Listing } from '../types';
import {
  formatDateTime,
  formatEth,
  formatParkingWindow,
  getAuctionTimeRemaining,
  getListingStatus,
  shortenAddress,
} from '../utils/formatters';
import { getBidEligibility, getChainNowSec } from '../utils/eligibility';
import { BOOKING_ACTION_LABELS, bookingView, canClaimPayout, type BookingAction } from '../utils/booking';
import { downloadReservationIcs } from '../utils/calendar';
import { BidHistory } from './BidHistory';
import { Dialog } from './Dialog';
import { ReportSpace } from './ReportSpace';
import { DisputeRecord, MIN_REVIEW_TEXT, REVIEW_ACTIONS } from './Disputes';

interface DetailModalProps {
  listing: Listing | null;
  contractAddress?: string;
  chainId?: number;
  currentAddress: string | null;
  onClose: () => void;
  onOpenBid: (listing: Listing) => void;
  onSettle: (listing: Listing) => void;
  onCancel: (listing: Listing) => void;
  onClaimPayout: (listing: Listing) => void;
  onBookingAction?: (listing: Listing, action: BookingAction, text?: string) => void;
  isActionBusy: boolean;
  /** Whether the viewer has an API session; reporting needs one. */
  signedIn?: boolean;
}

export const DetailModal: React.FC<DetailModalProps> = ({
  listing,
  contractAddress,
  chainId,
  currentAddress,
  onClose,
  onOpenBid,
  onSettle,
  onCancel,
  onClaimPayout,
  onBookingAction,
  isActionBusy,
  signedIn = false,
}) => {
  const [copiedHash, setCopiedHash] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [timeRemaining, setTimeRemaining] = useState(() =>
    listing ? getAuctionTimeRemaining(listing.bidEnd) : { isEnded: true, text: '', totalSeconds: 0 }
  );

  useEffect(() => {
    if (!listing || listing.settled || listing.cancelled) return;
    const interval = setInterval(() => {
      setTimeRemaining(getAuctionTimeRemaining(listing.bidEnd));
    }, 1000);
    return () => clearInterval(interval);
  }, [listing]);

  if (!listing) return null;

  const status = getListingStatus(listing);
  const parkingWindow = formatParkingWindow(listing.parkingStart, listing.parkingEnd, listing.timeZone);
  const now = getChainNowSec();
  const canBid = getBidEligibility(listing, currentAddress, now).canBid;

  const isOwner =
    Boolean(currentAddress) &&
    listing.owner.toLowerCase() === currentAddress?.toLowerCase();

  const isLeading =
    Boolean(currentAddress) &&
    Boolean(listing.highestBidder) &&
    listing.highestBidder.toLowerCase() === currentAddress?.toLowerCase();

  const hasBids = parseFloat(listing.highestBid) > 0;
  const currentPriceEth = hasBids ? listing.highestBid : listing.minBid;

  const canOwnerCancel = isOwner && !hasBids && !listing.settled && !listing.cancelled;
  const canOwnerClaimPayout = isOwner && canClaimPayout(listing, now);
  const booking = bookingView(listing, currentAddress, now);
  const needsText = booking?.actions.some((a) => REVIEW_ACTIONS.includes(a)) ?? false;
  const textOk = reviewText.trim().length >= MIN_REVIEW_TEXT && signedIn;
  const handleCopyHash = () => {
    if (listing.metadataHash) {
      navigator.clipboard.writeText(listing.metadataHash);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 2000);
    }
  };

  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    listing.address
  )}`;

  return (
    <Dialog
      className="modal-dialog modal-detail-dialog"
      labelledBy="modal-listing-title"
      onClose={onClose}
    >
        {/* Modal Header */}
        <div className="modal-detail-header">
          <div className="modal-header-left">
            <span className="badge-demo-sample">Demo Listing</span>
            {listing.verification === 'verified' && <span className="badge-verified">Verified space</span>}
            <span className={`badge-kind badge-kind-${listing.kind}`}>
              {listing.kind}
            </span>
            <span className={`badge-status ${status.colorClass}`}>
              {status.label}
            </span>
          </div>

          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="modal-detail-body">
          {/* Hero Media */}
          <div className="modal-detail-media">
            <img
              src={listing.image}
              alt={listing.title}
              className="modal-detail-image"
              onError={(e) => {
                const target = e.currentTarget;
                if (target.dataset.fallback === 'true') return;
                target.dataset.fallback = 'true';
                target.src =
                  'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=1200&q=80';
              }}
            />
            {isLeading && (
              <div className="modal-leading-overlay">
                <CheckCircle2 size={16} />
                <span>You currently hold the winning bid</span>
              </div>
            )}
          </div>

          <div className="modal-detail-content">
            {/* Title & Location */}
            <div className="modal-section-title">
              <h2 id="modal-listing-title" className="modal-listing-title">
                {listing.title}
              </h2>
              <div className="modal-location-row">
                <MapPin size={16} className="text-forest-green" />
                <span className="modal-address">{listing.address}</span>
                <a
                  href={googleMapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="modal-maps-link"
                >
                  <ExternalLink size={13} />
                  <span>Google Maps</span>
                </a>
              </div>
            </div>

            {/* Parking Reservation Window */}
            <div className="detail-info-card parking-info-card">
              <div className="info-card-header">
                <Calendar size={18} className="text-orange" />
                <span className="info-card-heading">Reserved Parking Window</span>
              </div>
              <div className="parking-info-grid">
                <div>
                  <span className="info-sublabel">Date:</span>
                  <p className="info-main-val">{parkingWindow.dateStr}</p>
                </div>
                <div>
                  <span className="info-sublabel">Time Window:</span>
                  <p className="info-main-val">{parkingWindow.timeRange}</p>
                </div>
                <div>
                  <span className="info-sublabel">Total Duration:</span>
                  <p className="info-main-val">{parkingWindow.durationHours}</p>
                </div>
              </div>
            </div>

            {isLeading && listing.settled && !listing.cancelled && contractAddress && chainId !== undefined && (
              <button
                type="button"
                className="btn-pass-details"
                onClick={() => downloadReservationIcs(listing, { chainId, contractAddress })}
              >
                <CalendarPlus size={14} />
                <span>Add to calendar (.ics)</span>
              </button>
            )}

            {/* Description */}
            <div className="modal-section">
              <h4 className="section-label">Public Space Description</h4>
              <p className="modal-description-text">{listing.description}</p>
            </div>

            <div className="modal-section" data-testid="verification-meaning">
              <h4 className="section-label">Host Verification</h4>
              <p className="modal-description-text">
                {listing.verification === 'verified'
                  ? 'Verified: a BidPark moderator reviewed proof that this host controls space #' + listing.spaceId + '. It is not a guarantee about the space itself.'
                  : 'Not verified: BidPark has not confirmed that this host controls space #' + listing.spaceId + '.'}
              </p>
            </div>

            {/* Amenities */}
            {listing.amenities && listing.amenities.length > 0 && (
              <div className="modal-section">
                <h4 className="section-label">Features & Amenities</h4>
                <div className="modal-amenities-tags">
                  {listing.amenities.map((item, idx) => (
                    <span key={idx} className="amenity-tag amenity-tag-lg">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <BidHistory listing={listing} currentAddress={currentAddress} />

            {/* Onchain Escrow Telemetry */}
            <div className="detail-info-card telemetry-card">
              <div className="info-card-header">
                <Warehouse size={17} className="text-forest-green" />
                <span className="info-card-heading">Smart Contract Escrow Telemetry</span>
              </div>
              <div className="telemetry-grid">
                <div className="telemetry-item">
                  <span className="telemetry-label">Auction ID:</span>
                  <span className="telemetry-val">#{listing.id}</span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">Host / Owner:</span>
                  <span className="telemetry-val mono-val" title={listing.owner}>
                    {shortenAddress(listing.owner, 6)}
                    {isOwner && ' (You)'}
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">Highest Bidder:</span>
                  <span className="telemetry-val mono-val" title={listing.highestBidder}>
                    {hasBids
                      ? `${shortenAddress(listing.highestBidder, 6)}${isLeading ? ' (You)' : ''}`
                      : 'None (Awaiting first bid)'}
                  </span>
                </div>
                {contractAddress && (
                  <div className="telemetry-item">
                    <span className="telemetry-label">Escrow Contract:</span>
                    <span className="telemetry-val mono-val" title={contractAddress}>
                      {shortenAddress(contractAddress, 6)}
                    </span>
                  </div>
                )}
                <div className="telemetry-item full-width-item">
                  <span className="telemetry-label">Metadata Hash (keccak256):</span>
                  <div className="hash-copy-row">
                    <code className="telemetry-hash">{listing.metadataHash}</code>
                    <button
                      type="button"
                      className="btn-copy-hash"
                      onClick={handleCopyHash}
                      title="Copy metadata hash"
                    >
                      <Copy size={13} />
                      <span>{copiedHash ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Action Bidding Box */}
            <div className="modal-bid-action-box">
              <div className="bid-action-left">
                <span className="bid-box-label">
                  {hasBids ? 'Current Winning Bid' : 'Minimum Opening Bid'}
                </span>
                <div className="bid-box-price">
                  <span className="bid-box-amount">{formatEth(currentPriceEth)}</span>
                  <span className="bid-box-unit">ETH</span>
                </div>
                <div className="bid-box-cutoff">
                  <Clock size={13} />
                  <span>
                    Cutoff: {formatDateTime(listing.bidEnd)} ({timeRemaining.text})
                  </span>
                </div>
              </div>

              <div className="bid-action-right">
                {canBid && (
                  <button
                    type="button"
                    className="btn-modal-bid"
                    disabled={isActionBusy}
                    onClick={() => {
                      onClose();
                      onOpenBid(listing);
                    }}
                  >
                    <Gavel size={16} />
                    <span>Place Higher Bid</span>
                  </button>
                )}

                {status.canSettle && (
                  <button
                    type="button"
                    className="btn-modal-settle"
                    disabled={isActionBusy}
                    onClick={() => onSettle(listing)}
                  >
                    <Zap size={16} />
                    <span>Settle Escrow Now</span>
                  </button>
                )}

                {canOwnerCancel && (
                  <button
                    type="button"
                    className="btn-modal-cancel"
                    disabled={isActionBusy}
                    onClick={() => onCancel(listing)}
                  >
                    <ShieldAlert size={16} />
                    <span>Cancel Auction (No Bids)</span>
                  </button>
                )}

                {canOwnerClaimPayout && (
                  <button
                    type="button"
                    className="btn-modal-claim"
                    disabled={isActionBusy}
                    onClick={() => onClaimPayout(listing)}
                  >
                    <ShieldCheck size={16} />
                    <span>Claim Host Payout</span>
                  </button>
                )}

                {isOwner && listing.payoutClaimed && (
                  <div className="payout-claimed-pill">
                    <ShieldCheck size={14} />
                    <span>Host Payout Claimed</span>
                  </div>
                )}

                {!isOwner && <ReportSpace spaceId={listing.spaceId} signedIn={signedIn} />}
                {booking && (
                  <div className="booking-protection" data-testid="booking-protection">
                    <p className="owner-notice">{booking.status}</p>
                    {needsText && (
                      <label className="owner-notice">
                        {booking.actions.includes('reportSellerFailure') ? 'Evidence (text or links)' : 'Decision reason'}
                        <textarea
                          aria-label="Review text"
                          maxLength={2000}
                          rows={3}
                          placeholder={signedIn ? 'Stored off-chain, readable only by the winner, host and resolvers. At least 10 characters.' : 'Sign in to submit a review record.'}
                          value={reviewText}
                          onChange={(e) => setReviewText(e.target.value)}
                        />
                      </label>
                    )}
                    {booking.actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="btn-modal-settle"
                        disabled={isActionBusy || !onBookingAction || (REVIEW_ACTIONS.includes(action) && !textOk)}
                        onClick={() => onBookingAction?.(listing, action, REVIEW_ACTIONS.includes(action) ? reviewText.trim() : undefined)}
                      >
                        <span>{BOOKING_ACTION_LABELS[action]}</span>
                      </button>
                    ))}
                    {signedIn && booking && listing.booking?.disputeReporter && <DisputeRecord auctionId={listing.id} refreshKey={listing.booking.disputeReporter} />}
                  </div>
                )}

                {isOwner && status.isBiddable && (
                  <p className="owner-notice">
                    You are the owner of this auction. Bidding is open to drivers.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
    </Dialog>
  );
};
