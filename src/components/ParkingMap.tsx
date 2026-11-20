import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { AlertCircle, RotateCcw, Search, X } from 'lucide-react';
import type { Listing } from '../types';
import { formatEth } from '../utils/formatters';
import { getBidEligibility } from '../utils/eligibility';
import { areaFromBounds } from '../utils/discovery';

interface ParkingMapProps {
  listings: Listing[];
  currentAddress: string | null;
  selectedListingId: string | null;
  onSelectListing: (listing: Listing) => void;
  onOpenBid: (listing: Listing) => void;
  onOpenDetail: (listing: Listing) => void;
  /** The area filter in effect ('' for none); the map then does not claim to show everything. */
  area?: string;
  /** Search the current viewport as the area filter. */
  onSearchArea?: (area: string) => void;
  onClearArea?: () => void;
}

const AUSTIN_CENTER: [number, number] = [30.2672, -97.7431];
const DEFAULT_ZOOM = 13;

function createMarkerPinElement(priceEth: string, isSelected: boolean, isSettled: boolean): HTMLElement {
  const container = document.createElement('div');
  container.className = `custom-map-pin ${isSelected ? 'pin-selected' : ''} ${isSettled ? 'pin-settled' : ''}`;

  const badge = document.createElement('div');
  badge.className = 'pin-badge';

  const ethSpan = document.createElement('span');
  ethSpan.className = 'pin-eth';
  ethSpan.textContent = formatEth(priceEth);

  const unitSpan = document.createElement('span');
  unitSpan.className = 'pin-unit';
  unitSpan.textContent = 'ETH';

  badge.appendChild(ethSpan);
  badge.appendChild(unitSpan);

  const caret = document.createElement('div');
  caret.className = 'pin-caret';

  container.appendChild(badge);
  container.appendChild(caret);

  return container;
}

function createPopupCardElement(
  listing: Listing,
  onOpenDetail: (l: Listing) => void,
  onOpenBid: (l: Listing) => void,
  canBid: boolean
): HTMLElement {
  const hasBids = parseFloat(listing.highestBid) > 0;
  const displayPrice = hasBids ? listing.highestBid : listing.minBid;

  const card = document.createElement('div');
  card.className = 'map-popup-card';

  // Thumbnail container
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'popup-thumb-wrap';

  const img = document.createElement('img');
  img.className = 'popup-thumb';
  img.src = listing.image || 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=400&q=80';
  img.alt = listing.title;
  img.onerror = () => {
    img.onerror = null;
    img.src = 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=400&q=80';
  };
  thumbWrap.appendChild(img);

  const kindBadge = document.createElement('span');
  kindBadge.className = 'popup-kind-badge';
  kindBadge.textContent = listing.kind;
  thumbWrap.appendChild(kindBadge);

  card.appendChild(thumbWrap);

  // Body container
  const body = document.createElement('div');
  body.className = 'popup-body';

  const titleEl = document.createElement('h4');
  titleEl.className = 'popup-title';
  titleEl.textContent = listing.title;
  body.appendChild(titleEl);

  const addrEl = document.createElement('p');
  addrEl.className = 'popup-address';
  addrEl.textContent = listing.address;
  body.appendChild(addrEl);

  const priceRow = document.createElement('div');
  priceRow.className = 'popup-price-row';

  const priceLabel = document.createElement('span');
  priceLabel.className = 'popup-price-label';
  priceLabel.textContent = hasBids ? 'Current Bid:' : 'Starting Bid:';
  priceRow.appendChild(priceLabel);

  const priceVal = document.createElement('span');
  priceVal.className = 'popup-price-val';
  priceVal.textContent = `${formatEth(displayPrice)} ETH`;
  priceRow.appendChild(priceVal);

  body.appendChild(priceRow);

  // Buttons container
  const btnRow = document.createElement('div');
  btnRow.className = 'popup-btn-row';

  const detailsBtn = document.createElement('button');
  detailsBtn.type = 'button';
  detailsBtn.className = 'popup-action-btn popup-btn-details';
  detailsBtn.textContent = 'Details';
  detailsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpenDetail(listing);
  });
  btnRow.appendChild(detailsBtn);

  if (canBid) {
    const bidBtn = document.createElement('button');
    bidBtn.type = 'button';
    bidBtn.className = 'popup-action-btn popup-btn-bid';
    bidBtn.textContent = 'Bid';
    bidBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onOpenBid(listing);
    });
    btnRow.appendChild(bidBtn);
  }

  body.appendChild(btnRow);
  card.appendChild(body);

  return card;
}

export const ParkingMap: React.FC<ParkingMapProps> = ({
  listings,
  currentAddress,
  selectedListingId,
  onSelectListing,
  onOpenBid,
  onOpenDetail,
  area = '',
  onSearchArea,
  onClearArea,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const markersMapRef = useRef<Map<string, { marker: L.Marker; listing: Listing }>>(new Map());
  const [hasMapError, setHasMapError] = useState(false);
  // The viewport as an area value, kept current while the map moves.
  const [viewport, setViewport] = useState('');

  // Re-evaluate eligibility every second so a popup stops offering Bid at the chain cutoff.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const eligibilityKey = listings
    .map((l) => `${l.id}:${getBidEligibility(l, currentAddress).canBid ? 1 : 0}`)
    .join(',');

  // Stable callbacks ref so marker event listeners always call the latest functions
  const callbacksRef = useRef({ onSelectListing, onOpenBid, onOpenDetail });
  useEffect(() => {
    callbacksRef.current = { onSelectListing, onOpenBid, onOpenDetail };
  });

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    try {
      const map = L.map(mapContainerRef.current, {
        center: AUSTIN_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: false,
      });

      L.control.zoom({ position: 'topright' }).addTo(map);

      const tileLayer = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }
      );

      tileLayer.on('tileerror', () => {
        console.warn('Map tile loading error occurred');
      });

      tileLayer.addTo(map);

      const markersGroup = L.layerGroup().addTo(map);

      const readViewport = () => {
        const b = map.getBounds();
        setViewport(areaFromBounds({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }));
      };
      map.on('moveend', readViewport);
      readViewport();
      mapInstanceRef.current = map;
      markersLayerRef.current = markersGroup;

      const resizeObserver = new ResizeObserver(() => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.invalidateSize();
        }
      });
      resizeObserver.observe(mapContainerRef.current);

      const markerIndex = markersMapRef.current;
      return () => {
        resizeObserver.disconnect();
        map.remove();
        mapInstanceRef.current = null;
        markersLayerRef.current = null;
        markerIndex.clear();
      };
    } catch (err) {
      console.error('Failed to initialize Leaflet map:', err);
      setHasMapError(true);
    }
  }, []);

  // Sync Markers with Listings WITHOUT clearing all layers (preserves open popups)
  useEffect(() => {
    const map = mapInstanceRef.current;
    const markersGroup = markersLayerRef.current;
    if (!map || !markersGroup) return;

    const currentMap = markersMapRef.current;
    const nextIds = new Set(listings.map((l) => l.id));

    // Remove markers that are no longer in listings
    currentMap.forEach(({ marker }, id) => {
      if (!nextIds.has(id)) {
        markersGroup.removeLayer(marker);
        currentMap.delete(id);
      }
    });

    // Add or update markers
    listings.forEach((listing) => {
      const lat = listing.latitude;
      const lng = listing.longitude;
      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return;

      const hasBids = parseFloat(listing.highestBid) > 0;
      const displayPrice = hasBids ? listing.highestBid : listing.minBid;
      const isSelected = selectedListingId === listing.id;

      const existing = currentMap.get(listing.id);

      if (existing) {
        const pin = existing.marker.getElement()?.querySelector('.custom-map-pin');
        const price = pin?.querySelector('.pin-eth');
        if (price) price.textContent = formatEth(displayPrice);
        pin?.classList.toggle('pin-settled', listing.settled);
        pin?.classList.toggle('pin-selected', isSelected);
        existing.marker.setLatLng([lat, lng]);
        // Update popup content safely with textContent DOM
        const popup = existing.marker.getPopup();
        if (popup) {
          const newPopupContent = createPopupCardElement(
            listing,
            (l) => callbacksRef.current.onOpenDetail(l),
            (l) => callbacksRef.current.onOpenBid(l),
            getBidEligibility(listing, currentAddress).canBid
          );
          popup.setContent(newPopupContent);
        }
        existing.listing = listing;
      } else {
        // Create new marker with safe DOM element
        const pinEl = createMarkerPinElement(displayPrice, isSelected, listing.settled);
        const customIcon = L.divIcon({
          className: 'custom-leaflet-pin-wrapper',
          html: pinEl,
          iconSize: [80, 36],
          iconAnchor: [40, 36],
          popupAnchor: [0, -36],
        });

        const marker = L.marker([lat, lng], { icon: customIcon });

        const popupContent = createPopupCardElement(
          listing,
          (l) => callbacksRef.current.onOpenDetail(l),
          (l) => callbacksRef.current.onOpenBid(l),
          getBidEligibility(listing, currentAddress).canBid
        );

        marker.bindPopup(popupContent, {
          maxWidth: 240,
          className: 'custom-leaflet-popup',
        });

        marker.on('click', () => {
          callbacksRef.current.onSelectListing(listing);
        });

        markersGroup.addLayer(marker);
        currentMap.set(listing.id, { marker, listing });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection is applied by the effect below, so markers and popups are not rebuilt on each selection; callbacks are read through callbacksRef
  }, [listings, currentAddress, eligibilityKey]); // NOT selectedListingId or callbacks!

  // Update selection CSS class and map pan without clearing markers or closing popups
  useEffect(() => {
    const currentMap = markersMapRef.current;
    currentMap.forEach(({ marker }, id) => {
      const el = marker.getElement();
      if (el) {
        const pin = el.querySelector('.custom-map-pin');
        if (pin) {
          if (id === selectedListingId) {
            pin.classList.add('pin-selected');
          } else {
            pin.classList.remove('pin-selected');
          }
        }
      }
    });

    if (selectedListingId && mapInstanceRef.current) {
      const entry = currentMap.get(selectedListingId);
      if (entry && !isNaN(entry.listing.latitude) && !isNaN(entry.listing.longitude)) {
        mapInstanceRef.current.panTo([entry.listing.latitude, entry.listing.longitude], {
          animate: true,
        });
      }
    }
  }, [selectedListingId]);

  const handleResetView = () => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView(AUSTIN_CENTER, DEFAULT_ZOOM, { animate: true });
    }
  };

  if (hasMapError) {
    return (
      <div className="map-error-fallback">
        <AlertCircle size={28} />
        <p>Interactive map unavailable. Listings are fully accessible via cards.</p>
      </div>
    );
  }

  return (
    <div className="parking-map-wrapper" data-viewport={viewport}>
      <div className="parking-map-container" ref={mapContainerRef} />
      {onSearchArea && (
        <div className="map-area-controls">
          <button
            type="button"
            className="map-control-btn"
            disabled={!viewport || viewport === area}
            onClick={() => onSearchArea(viewport)}
          >
            <Search size={14} />
            <span>{area && viewport === area ? 'Searching this area' : 'Search this area'}</span>
          </button>
          {area && onClearArea && (
            <button type="button" className="map-control-btn" onClick={onClearArea}>
              <X size={14} />
              <span>Clear area</span>
            </button>
          )}
        </div>
      )}
      <div className="map-overlay-controls">
        <button
          type="button"
          className="map-control-btn"
          onClick={handleResetView}
          title="Reset map to Austin center"
          aria-label="Reset map view"
        >
          <RotateCcw size={14} />
          <span>Austin Center</span>
        </button>
      </div>
    </div>
  );
};
