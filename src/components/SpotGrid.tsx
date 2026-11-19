import React, { useEffect, useRef } from 'react';
import { AlertTriangle, SearchX } from 'lucide-react';
import type { Listing } from '../types';
import type { ReadStatus } from '../utils/readState';
import { SpotCard } from './SpotCard';

interface SpotGridProps {
  listings: Listing[];
  status: ReadStatus;
  error: string | null;
  onRetry: () => void;
  currentAddress: string | null;
  selectedListingId: string | null;
  onSelectListing: (listing: Listing) => void;
  onOpenBid: (listing: Listing) => void;
  onOpenDetail: (listing: Listing) => void;
  onSettle: (listing: Listing) => void;
  onResetFilters: () => void;
  /** Descriptions of the active filters, named in the no-results state. */
  activeFilters?: string[];
  /** Straight-line distance (km) from the chosen destination, by listing id. */
  distances?: Map<string, number>;
  destinationLabel?: string | null;
}

export const SpotGrid: React.FC<SpotGridProps> = ({
  listings,
  status,
  error,
  onRetry,
  currentAddress,
  selectedListingId,
  onSelectListing,
  onOpenBid,
  onOpenDetail,
  onSettle,
  onResetFilters,
  activeFilters = [],
  distances,
  destinationLabel = null,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to selected card when selection changes from map
  useEffect(() => {
    if (!selectedListingId) return;
    const cardEl = document.getElementById(`spot-card-${selectedListingId}`);
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedListingId]);

  if (status === 'loading') {
    return (
      <div className="spot-grid-loading" aria-busy="true" aria-label="Loading parking spots">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card-skeleton">
            <div className="skeleton-media" />
            <div className="skeleton-body">
              <div className="skeleton-line line-short" />
              <div className="skeleton-line line-title" />
              <div className="skeleton-line line-desc" />
              <div className="skeleton-box" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="empty-spots-state spots-unavailable-state" role="alert">
        <div className="empty-icon-wrap">
          <AlertTriangle size={36} />
        </div>
        <h3 className="empty-title">Parking auctions are unavailable</h3>
        <p className="empty-desc">
          The listings could not be loaded{error ? `: ${error}` : ''}. This is not an empty marketplace.
        </p>
        <button type="button" className="btn-empty-reset" onClick={onRetry}>
          Retry listings
        </button>
      </div>
    );
  }

  const staleNote = status === 'stale' && (
    <p className="spots-stale-note" role="status">
      Showing the last known listings. They may be out of date.
    </p>
  );

  if (listings.length === 0 && status === 'empty') {
    return (
      <div className="empty-spots-state">
        <div className="empty-icon-wrap">
          <SearchX size={36} />
        </div>
        <h3 className="empty-title">No parking auctions are listed yet</h3>
        <p className="empty-desc">The listings service responded and reported no auctions.</p>
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="empty-spots-state">
        {staleNote}
        <div className="empty-icon-wrap">
          <SearchX size={36} />
        </div>
        <h3 className="empty-title">No matching parking auctions found</h3>
        <p className="empty-desc">
          {activeFilters.length
            ? `None of the ${status === 'stale' ? 'last known' : 'loaded'} listings match: ${activeFilters.join('; ')}. Widen or remove a filter.`
            : 'Try expanding your search query, adjusting your kind filter, or clearing the status filter.'}
        </p>
        <button type="button" className="btn-empty-reset" onClick={onResetFilters}>
          Reset all filters
        </button>
      </div>
    );
  }

  return (
    <div className="spot-grid" ref={containerRef}>
      {staleNote}
      {listings.map((listing) => (
        <SpotCard
          key={listing.id}
          listing={listing}
          currentAddress={currentAddress}
          isSelected={selectedListingId === listing.id}
          onSelect={onSelectListing}
          onOpenBid={onOpenBid}
          onOpenDetail={onOpenDetail}
          onSettle={onSettle}
          distance={
            destinationLabel && distances?.has(listing.id)
              ? { km: distances.get(listing.id)!, from: destinationLabel }
              : undefined
          }
        />
      ))}
    </div>
  );
};
