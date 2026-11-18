import React from 'react';
import {
  ArrowDownUp,
  LayoutGrid,
  Map as MapIcon,
  RotateCcw,
  Search,
  Warehouse,
} from 'lucide-react';
import type { FilterState, SortOption, SpotKindFilter, AuctionStatusFilter } from '../types';

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  totalSpots: number;
  filteredCount: number;
  viewMode: 'split' | 'cards' | 'map';
  onViewModeChange: (mode: 'split' | 'cards' | 'map') => void;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  onFilterChange,
  totalSpots,
  filteredCount,
  viewMode,
  onViewModeChange,
}) => {
  const isFiltered =
    Boolean(filters.search.trim()) ||
    filters.kind !== 'all' ||
    filters.status !== 'all' ||
    Boolean(filters.minPrice) ||
    Boolean(filters.maxPrice);

  const handleReset = () => {
    onFilterChange({
      search: '',
      kind: 'all',
      status: 'all',
      minPrice: '',
      maxPrice: '',
      sortBy: 'ending-soon',
    });
  };

  return (
    <div className="filter-toolbar">
      {/* Top row: search & primary kind pills */}
      <div className="filter-row-top">
        <div className="search-input-wrapper">
          <Search size={17} className="search-icon" />
          <input
            type="text"
            id="spot-search"
            aria-label="Search parking spots"
            className="search-input"
            placeholder="Search by neighborhood, street address, venue, amenities..."
            value={filters.search}
            onChange={(e) => onFilterChange({ ...filters, search: e.target.value })}
          />
          {filters.search && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => onFilterChange({ ...filters, search: '' })}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Kind selector pills */}
        <div className="kind-pill-group" role="radiogroup" aria-label="Filter by parking type">
          {(
            [
              { id: 'all', label: 'All Spaces' },
              { id: 'driveway', label: 'Driveway' },
              { id: 'garage', label: 'Garage' },
              { id: 'covered', label: 'Covered' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={filters.kind === item.id}
              className={`kind-pill-btn ${filters.kind === item.id ? 'active' : ''}`}
              onClick={() => onFilterChange({ ...filters, kind: item.id as SpotKindFilter })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom row: status, price, sort, view toggles & clear */}
      <div className="filter-row-bottom">
        <div className="filter-selects-group">
          {/* Status filter */}
          <div className="filter-item">
            <label htmlFor="status-select" className="filter-label">
              Status:
            </label>
            <select
              id="status-select"
              className="filter-select"
              value={filters.status}
              onChange={(e) =>
                onFilterChange({
                  ...filters,
                  status: e.target.value as AuctionStatusFilter,
                })
              }
            >
              <option value="all">All Auctions</option>
              <option value="active">Active Bidding</option>
              <option value="ending-soon">Ending Soon (&lt; 30m)</option>
              <option value="ended">Bidding Closed</option>
              <option value="settled">Settled Escrow</option>
            </select>
          </div>

          {/* Sort option */}
          <div className="filter-item">
            <label htmlFor="sort-select" className="filter-label">
              Sort:
            </label>
            <div className="select-with-icon">
              <ArrowDownUp size={13} className="inline-select-icon" />
              <select
                id="sort-select"
                className="filter-select"
                value={filters.sortBy}
                onChange={(e) =>
                  onFilterChange({
                    ...filters,
                    sortBy: e.target.value as SortOption,
                  })
                }
              >
                <option value="ending-soon">Ending Soonest</option>
                <option value="starts-soon">Parking Starts Soonest</option>
                <option value="price-asc">Price: Low to High</option>
                <option value="price-desc">Price: High to Low</option>
                <option value="newest">Recently Listed</option>
              </select>
            </div>
          </div>

          {/* Results count indicator */}
          <div className="filter-count-badge" role="status" aria-live="polite">
            <span>
              {filteredCount} {filteredCount === 1 ? 'spot' : 'spots'} available
            </span>
          </div>

          {isFiltered && (
            <button
              type="button"
              className="btn-reset-filters"
              onClick={handleReset}
              title="Reset all filters"
            >
              <RotateCcw size={13} />
              <span>Reset</span>
            </button>
          )}
        </div>

        {/* View mode toggle */}
        <div className="view-mode-group">
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => onViewModeChange('split')}
            title="Split map and cards"
          >
            <LayoutGrid size={15} />
            <span className="view-mode-label">Split</span>
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'cards' ? 'active' : ''}`}
            onClick={() => onViewModeChange('cards')}
            title="Cards view only"
          >
            <Warehouse size={15} />
            <span className="view-mode-label">Cards</span>
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'map' ? 'active' : ''}`}
            onClick={() => onViewModeChange('map')}
            title="Map view only"
          >
            <MapIcon size={15} />
            <span className="view-mode-label">Map</span>
          </button>
        </div>
      </div>
    </div>
  );
};
