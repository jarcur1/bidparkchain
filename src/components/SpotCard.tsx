import React, { useEffect, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Eye,
  Gavel,
  MapPin,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type { Listing } from '../types';
import {
  formatDateTime,
  formatEth,
  formatParkingWindow,
  getAuctionTimeRemaining,
  getListingStatus,
} from '../utils/formatters';
import { getBidEligibility, isOwnerOf } from '../utils/eligibility';
import { formatDistance } from '../utils/discovery';

interface SpotCardProps {
  listing: Listing;
  currentAddress: string | null;
  isSelected?: boolean;
  onSelect: (listing: Listing) => void;
  onOpenBid: (listing: Listing) => void;
  onOpenDetail: (listing: Listing) => void;
  onSettle?: (listing: Listing) => void;
  /** Straight-line distance from the driver's destination. */
  distance?: { km: number; from: string };
}

export const SpotCard: React.FC<SpotCardProps> = ({
  listing,
  currentAddress,
  isSelected,
  onSelect,
  onOpenBid,
  onOpenDetail,
  onSettle,
  distance,
}) => {
  const [timeRemaining, setTimeRemaining] = useState(() =>
    getAuctionTimeRemaining(listing.bidEnd)
  );
  const [imgError, setImgError] = useState(false);

  // Live timer tick every second for active auctions
  useEffect(() => {
    if (listing.settled || listing.cancelled) return;

    const timer = setInterval(() => {
      const remaining = getAuctionTimeRemaining(listing.bidEnd);
      setTimeRemaining(remaining);
    }, 1000);

    return () => clearInterval(timer);
  }, [listing.bidEnd, listing.settled, listing.cancelled]);

  const parkingWindow = formatParkingWindow(listing.parkingStart, listing.parkingEnd, listing.timeZone);
  const status = getListingStatus(listing);

  const isLeading =
    Boolean(currentAddress) &&
    Boolean(listing.highestBidder) &&
    listing.highestBidder.toLowerCase() === currentAddress?.toLowerCase();

  const isOwner = isOwnerOf(listing, currentAddress);
  const canBid = getBidEligibility(listing, currentAddress).canBid;

  const hasBids = parseFloat(listing.highestBid) > 0;
  const currentPriceEth = hasBids ? listing.highestBid : listing.minBid;

  const fallbackImg =
    'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=800&q=80';

  return (
    <article
      className={`spot-card ${isSelected ? 'is-selected' : ''}`}
      onClick={() => onSelect(listing)}
      id={`spot-card-${listing.id}`}
      aria-label={`Listing: ${listing.title}`}
    >
      {/* Card media container */}
      <div className="card-media">
        <img
          src={imgError ? fallbackImg : listing.image || fallbackImg}
          alt={listing.title}
          className="card-image"
          onError={() => setImgError(true)}
          loading="lazy"
        />

        {/* Demo and Kind badges */}
        <div className="card-top-left-badges">
          <span className="badge-demo-sample">Demo Listing</span>
          {listing.verification === 'verified' && <span className="badge-verified">Verified space</span>}
          <span className={`badge-kind badge-kind-${listing.kind}`}>
            {listing.kind.charAt(0).toUpperCase() + listing.kind.slice(1)}
          </span>
        </div>
        {/* Status badge */}
        <span className={`badge-status ${status.colorClass}`}>
          {status.label}
        </span>

        {/* Leading bidder pill */}
        {isLeading && (
          <span className="badge-leading">
            <CheckCircle2 size={12} />
            <span>You're Leading</span>
          </span>
        )}

        {isOwner && (
          <span className="badge-owner">
            <span>Your Listing</span>
          </span>
        )}
      </div>

      {/* Card content */}
      <div className="card-body">
        {/* Neighborhood & title */}
        <div className="card-header-row">
          <div className="card-neighborhood">
            <MapPin size={13} className="pin-icon" />
            <span>{listing.neighborhood}</span>
          </div>
          <span className="card-id-pill">#{listing.id}</span>
        </div>

        <h3 className="card-title">
          <button
            type="button"
            className="card-select-btn"
            aria-pressed={Boolean(isSelected)}
            aria-label={`Select ${listing.title} on map`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(listing);
            }}
          >
            {listing.title}
          </button>
        </h3>
        <p className="card-address">{listing.address}</p>
        {distance && (
          <p className="card-distance">
            {formatDistance(distance.km)} straight-line from {distance.from}
          </p>
        )}

        {/* Parking reservation window info */}
        <div className="card-parking-window">
          <Calendar size={14} className="cal-icon" />
          <div className="parking-window-text">
            <span className="window-date">{parkingWindow.dateStr}</span>
            <span className="window-times">
              {parkingWindow.timeRange} ({parkingWindow.durationHours})
            </span>
          </div>
        </div>

        {/* Amenities preview tags */}
        {listing.amenities && listing.amenities.length > 0 && (
          <div className="card-amenities-row">
            {listing.amenities.slice(0, 3).map((amenity, idx) => (
              <span key={idx} className="amenity-tag">
                {amenity}
              </span>
            ))}
            {listing.amenities.length > 3 && (
              <span className="amenity-tag more-tag">
                +{listing.amenities.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* Auction bidding bar */}
        <div className="card-bid-bar">
          <div className="bid-price-block">
            <span className="bid-label">
              {hasBids ? 'Highest Bid' : 'Starting Bid'}
            </span>
            <div className="bid-value-row">
              <span className="bid-amount">{formatEth(currentPriceEth)}</span>
              <span className="bid-currency">ETH</span>
            </div>
          </div>

          <div className="bid-countdown-block">
            <span className="countdown-label">
              <Clock size={12} />
              <span>Cutoff</span>
            </span>
            <span
              className={`countdown-value ${
                timeRemaining.totalSeconds < 1800 && !timeRemaining.isEnded
                  ? 'urgent-countdown'
                  : ''
              }`}
            >
              {timeRemaining.text}
            </span>
            <span className="countdown-at">{formatDateTime(listing.bidEnd)}</span>
          </div>
        </div>

        {/* Card actions footer */}
        <div className="card-actions-row">
          <button
            type="button"
            className="btn-card-secondary"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetail(listing);
            }}
          >
            <Eye size={14} />
            <span>Details</span>
          </button>

          {canBid && (
            <button
              type="button"
              className="btn-card-primary"
              onClick={(e) => {
                e.stopPropagation();
                onOpenBid(listing);
              }}
            >
              <Gavel size={14} />
              <span>Bid Now</span>
            </button>
          )}

          {status.canSettle && onSettle && (
            <button
              type="button"
              className="btn-card-settle"
              onClick={(e) => {
                e.stopPropagation();
                onSettle(listing);
              }}
              title="Permissionless escrow settlement"
            >
              <Zap size={14} />
              <span>Settle</span>
            </button>
          )}

          {listing.settled && (
            <div className="settled-indicator">
              <ShieldCheck size={14} />
              <span>Escrow Finalized</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
};
