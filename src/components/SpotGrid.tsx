import React, { useEffect, useRef } from 'react';
import { SearchX } from 'lucide-react';
import type { Listing } from '../types';
import { SpotCard } from './SpotCard';

interface SpotGridProps {
  listings: Listing[];
  isLoading: boolean;
  currentAddress: string | null;
  selectedListingId: string | null;
  onSelectListing: (listing: Listing) => void;
  onOpenBid: (listing: Listing) => void;
  onOpenDetail: (listing: Listing) => void;
  onSettle: (listing: Listing) => void;
  onResetFilters: () => void;
}

export const SpotGrid: React.FC<SpotGridProps> = ({
  listings,
  isLoading,
  currentAddress,
  selectedListingId,
  onSelectListing,
  onOpenBid,
  onOpenDetail,
  onSettle,
  onResetFilters,
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

  if (isLoading) {
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

  if (listings.length === 0) {
    return (
      <div className="empty-spots-state">
        <div className="empty-icon-wrap">
          <SearchX size={36} />
        </div>
        <h3 className="empty-title">No matching parking auctions found</h3>
        <p className="empty-desc">
          Try expanding your search query, adjusting your kind filter, or clearing the status filter.
        </p>
        <button type="button" className="btn-empty-reset" onClick={onResetFilters}>
          Reset all filters
        </button>
      </div>
    );
  }

  return (
    <div className="spot-grid" ref={containerRef}>
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
        />
      ))}
    </div>
  );
};
