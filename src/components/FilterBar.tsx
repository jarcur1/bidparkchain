import React from 'react';
import {
  ArrowDownUp,
  LayoutGrid,
  Map as MapIcon,
  RotateCcw,
  Search,
  Warehouse,
} from 'lucide-react';
import type { ReadStatus } from '../utils/readState';
import type { FilterState, SortOption, SpotKindFilter, AuctionStatusFilter } from '../types';
import { DEFAULT_FILTERS, RADIUS_OPTIONS_KM, validateFilters, type Place } from '../utils/discovery';

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  filteredCount: number;
  listingsStatus: ReadStatus;
  viewMode: 'split' | 'cards' | 'map';
  onViewModeChange: (mode: 'split' | 'cards' | 'map') => void;
  destinationChoices?: Place[];
  /** The typed destination resolved to a known place, or null. */
  destination?: Place | null;
  amenityChoices?: string[];
  /** Optional browser location; omitted where the browser has none. */
  onUseLocation?: () => void;
  /** Result of the last location request, e.g. why it was refused. */
  locationMessage?: string | null;
  locating?: boolean;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  onFilterChange,
  filteredCount,
  listingsStatus,
  viewMode,
  onViewModeChange,
  destinationChoices = [],
  destination = null,
  amenityChoices = [],
  onUseLocation,
  locationMessage = null,
  locating = false,
}) => {
  const isFiltered = (Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]).some(
    (k) => k !== 'sortBy' && String(filters[k]) !== String(DEFAULT_FILTERS[k])
  );
  const errors = validateFilters(filters);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const set = (patch: Partial<FilterState>) => onFilterChange({ ...filters, ...patch });
  const toggleAmenity = (a: string) =>
    set({
      amenities: filters.amenities.includes(a)
        ? filters.amenities.filter((x) => x !== a)
        : [...filters.amenities, a],
    });

  const handleReset = () => onFilterChange(DEFAULT_FILTERS);

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

      {/* Trip row: destination, visit times, budget, amenities */}
      <div className="filter-row-trip">
        <div className="trip-field">
          <label htmlFor="destination-input" className="filter-label">
            Destination
          </label>
          <div className="trip-inline">
            <input
              id="destination-input"
              type="text"
              className="trip-input"
              list="destination-options"
              autoComplete="off"
              placeholder="Address, landmark or listing"
              value={filters.destination}
              aria-describedby="destination-hint"
              onChange={(e) => set({ destination: e.target.value })}
            />
            <datalist id="destination-options">
              {destinationChoices.map((o) => (
                <option key={o.label} value={o.label} />
              ))}
            </datalist>
            {onUseLocation && (
              <button type="button" className="btn-table-action" disabled={locating} onClick={onUseLocation}>
                {locating ? 'Locating...' : 'Use my location'}
              </button>
            )}
            <select
              id="radius-select"
              className="filter-select"
              aria-label="Maximum distance"
              value={filters.radiusKm}
              onChange={(e) => set({ radiusKm: e.target.value })}
            >
              <option value="">Any distance</option>
              {RADIUS_OPTIONS_KM.map((km) => (
                <option key={km} value={km}>
                  Within {km} km
                </option>
              ))}
            </select>
          </div>
          <p id="destination-hint" className="trip-hint" role="status">
            {!filters.destination.trim()
              ? locationMessage ?? 'Pick a landmark or listing address to see straight-line distances.'
              : destination
                ? `Distances are straight-line from ${destination.label}, not driving or walking routes.`
                : `No landmark or listing address matches "${filters.destination.trim()}". Pick one of the suggestions.`}
          </p>
        </div>

        <fieldset className="trip-field">
          <legend className="filter-label">Your visit</legend>
          <div className="trip-inline">
            <label className="trip-sublabel">
              Arrive
              <input
                type="datetime-local"
                className="trip-input"
                value={filters.arrive}
                aria-invalid={Boolean(errors.time)}
                aria-describedby="visit-hint"
                onChange={(e) => set({ arrive: e.target.value })}
              />
            </label>
            <label className="trip-sublabel">
              Depart
              <input
                type="datetime-local"
                className="trip-input"
                value={filters.depart}
                aria-invalid={Boolean(errors.time)}
                aria-describedby="visit-hint"
                onChange={(e) => set({ depart: e.target.value })}
              />
            </label>
          </div>
          <p id="visit-hint" className={`trip-hint ${errors.time ? 'trip-error' : ''}`} role="status">
            {errors.time
              ? `${errors.time} The visit filter is not applied.`
              : `Times are in ${timeZone}. Only spaces whose parking window covers your whole visit are shown; cards show each space's own time zone.`}
          </p>
        </fieldset>

        <fieldset className="trip-field">
          <legend className="filter-label">Budget (ETH)</legend>
          <div className="trip-inline">
            <label className="trip-sublabel">
              Min
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.001"
                className="trip-input trip-number"
                value={filters.minPrice}
                aria-invalid={Boolean(errors.price)}
                aria-describedby="budget-hint"
                onChange={(e) => set({ minPrice: e.target.value })}
              />
            </label>
            <label className="trip-sublabel">
              Max
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.001"
                className="trip-input trip-number"
                value={filters.maxPrice}
                aria-invalid={Boolean(errors.price)}
                aria-describedby="budget-hint"
                onChange={(e) => set({ maxPrice: e.target.value })}
              />
            </label>
          </div>
          <p id="budget-hint" className={`trip-hint ${errors.price ? 'trip-error' : ''}`} role="status">
            {errors.price
              ? `${errors.price} The budget filter is not applied.`
              : 'Compared with the current highest bid, or the opening bid if there is none. Not a final price: bids can still rise.'}
          </p>
        </fieldset>

        <details className="trip-field trip-amenities" open={filters.amenities.length > 0 || undefined}>
          <summary className="filter-label">
            Amenities{filters.amenities.length ? ` (${filters.amenities.length} selected)` : ''}
          </summary>
          <fieldset className="amenity-checklist">
            <legend className="filter-label">Required amenities</legend>
            {amenityChoices.length === 0 && <p className="trip-hint">No amenities in the loaded listings.</p>}
            {amenityChoices.map((a) => (
              <label key={a} className="amenity-check">
                <input type="checkbox" checked={filters.amenities.includes(a)} onChange={() => toggleAmenity(a)} />
                {a}
              </label>
            ))}
          </fieldset>
        </details>
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
                <option value="distance" disabled={!destination}>
                  Distance from destination
                </option>
              </select>
            </div>
          </div>

          {/* Results count indicator */}
          <div className="filter-count-badge" role="status" aria-live="polite">
            <span>
              {listingsStatus === 'loading'
                ? 'Loading spots…'
                : listingsStatus === 'failed'
                  ? 'Spot availability unavailable'
                  : `${filteredCount} ${filteredCount === 1 ? 'spot' : 'spots'} ${listingsStatus === 'stale' ? 'last known' : 'available'}`}
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
            aria-pressed={viewMode === 'split'}
            title="Split map and cards"
          >
            <LayoutGrid size={15} />
            <span className="view-mode-label">Split</span>
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'cards' ? 'active' : ''}`}
            onClick={() => onViewModeChange('cards')}
            aria-pressed={viewMode === 'cards'}
            title="Cards view only"
          >
            <Warehouse size={15} />
            <span className="view-mode-label">Cards</span>
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'map' ? 'active' : ''}`}
            onClick={() => onViewModeChange('map')}
            aria-pressed={viewMode === 'map'}
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
