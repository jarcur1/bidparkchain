import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Compass,
  Loader2,
  PlusCircle,
  RotateCcw,
  Warehouse,
  X,
} from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import type { SpotMetadata } from '../types';
import { isValidImageUrl, validateSpotMetadata } from '../../shared/validation.js';
import { useSession } from '../context/SessionContext';
import { deleteDraft, listDrafts, saveDraft } from '../services/workspace';
import { getChainNowSec } from '../utils/eligibility';
import { epochToZoned, findConflicts, isValidZone, parseSchedule } from '../utils/schedule';
import {
  AUSTIN_PRESET_LOCATIONS,
  COMMON_AMENITIES,
  CURATED_PARKING_PHOTOS,
} from '../utils/constants';
import { webProfile } from '../utils/networkProfile';
import { formatDateTime } from '../utils/formatters';
import { Dialog } from './Dialog';

export const PUBLIC_WARNING =
  'Public: this description is shown to everyone, including in the public API. Do not enter private or access-related information; private instructions are not supported.';

/** A parking space the connected wallet owns, with the windows it still holds on-chain. */
export interface OwnedSpace {
  id: string;
  title: string;
  held: { start: number; end: number }[];
  /** True when the wallet may list on the space only as an approved lister. */
  lister?: boolean;
  /** IANA zone set on-chain; empty or missing until the owner sets one. */
  timeZone?: string;
  /** Upcoming blocked windows. */
  blocked?: { start: number; end: number }[];
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The one autosaved draft per wallet, kept under this name. */
export const AUTOSAVE_NAME = 'Autosaved listing';
const AUTOSAVE_DELAY_MS = 1500;

/** Default schedule: bidding closes in an hour, parking runs three hours starting 30 minutes later. */
function defaultSchedule(zone: string) {
  const now = getChainNowSec();
  return {
    cutoff: epochToZoned(now + 3600, zone),
    start: epochToZoned(now + 3600 + 1800, zone),
    end: epochToZoned(now + 3600 + 1800 + 3 * 3600, zone),
  };
}

type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

interface CreateListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitCreate: (
    metadata: SpotMetadata,
    minBidEth: string,
    bidEndSec: number,
    parkingStartSec: number,
    parkingEndSec: number,
    spaceId?: string,
    protectedBooking?: boolean
  ) => Promise<void>;
  /** The connected wallet's spaces; listing on one adds a window to its calendar. */
  spaces?: OwnedSpace[];
  onRetryRegistration?: (auctionId: string, metadata: SpotMetadata) => Promise<void>;
  pendingRegistration: { auctionId: string; metadata: SpotMetadata } | null;
  isSubmitting: boolean;
}

export const CreateListingModal: React.FC<CreateListingModalProps> = ({
  isOpen,
  onClose,
  onSubmitCreate,
  onRetryRegistration,
  pendingRegistration,
  isSubmitting,
  spaces = [],
}) => {
  const { walletState, wrongChain } = useWallet();

  // Form states (pre-populated from pendingRegistration if present)
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'driveway' | 'garage' | 'covered'>('driveway');
  const [address, setAddress] = useState('');
  const [neighborhood, setNeighborhood] = useState('Downtown Austin');
  const [latitude, setLatitude] = useState<number>(30.2676);
  const [longitude, setLongitude] = useState<number>(-97.7397);
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState<string>(CURATED_PARKING_PHOTOS[0].url);
  const [selectedAmenities, setSelectedAmenities] = useState<string[]>([
    'EV Charging Level 2',
    'Gated Entry',
  ]);

  // Auction parameters
  const [minBidEth, setMinBidEth] = useState('0.05');
  const [cutoff, setCutoff] = useState('');
  const [parkStart, setParkStart] = useState('');
  const [parkEnd, setParkEnd] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [protectedBooking, setProtectedBooking] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; metadata: SpotMetadata } | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  // Sync state if pendingRegistration is passed or changes
  useEffect(() => {
    if (pendingRegistration) {
      const meta = pendingRegistration.metadata;
      setTitle(meta.title);
      setKind(meta.kind);
      setAddress(meta.address);
      setNeighborhood(meta.neighborhood);
      setLatitude(meta.latitude);
      setLongitude(meta.longitude);
      setDescription(meta.description);
      setImageUrl(meta.image);
      setSelectedAmenities(meta.amenities);
      setFormError(null);
    }
  }, [pendingRegistration]);

  // The space's own zone once it exists on-chain; the browser's zone for a new space.
  const space = spaces.find((sp) => sp.id === spaceId) ?? null;
  const zoneIsSet = Boolean(space?.timeZone && isValidZone(space.timeZone));
  const zone = zoneIsSet ? (space?.timeZone as string) : browserZone();

  // Fill the schedule with defaults when the form opens (and again after a listing is made).
  useEffect(() => {
    if (isOpen && !pendingRegistration && !cutoff && !parkStart && !parkEnd) {
      const d = defaultSchedule(zone);
      setCutoff(d.cutoff);
      setParkStart(d.start);
      setParkEnd(d.end);
    }
  }, [isOpen, pendingRegistration, cutoff, parkStart, parkEnd, zone]);

  const [nowSec, setNowSec] = useState(() => getChainNowSec());
  useEffect(() => {
    if (!isOpen) return;
    setNowSec(getChainNowSec());
    const timer = setInterval(() => setNowSec(getChainNowSec()), 30_000);
    return () => clearInterval(timer);
  }, [isOpen]);

  const parsed = parseSchedule({ cutoff, start: parkStart, end: parkEnd }, zone, nowSec);
  const conflicts = parsed.schedule && space
    ? findConflicts({ start: parsed.schedule.start, end: parsed.schedule.end }, space.held, space.blocked ?? [])
    : [];
  const canProtect = Boolean(parsed.schedule && parsed.schedule.start - parsed.schedule.bidEnd >= 30 * 60);

  // Autosave: one private draft per signed-in wallet, saved shortly after the last change.
  const { session } = useSession();
  const sessionAddress = session?.address ?? null;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const autosaveId = useRef<number | null>(null);
  const lastSaved = useRef('');
  const restoredFor = useRef<string | null>(null);
  const fieldsJson = JSON.stringify({
    title, address, neighborhood, description, spotKind: kind, latitude, longitude, minBidEth, spaceId,
    cutoff, start: parkStart, end: parkEnd, amenities: selectedAmenities,
    ...(isValidImageUrl(imageUrl.trim()) ? { image: imageUrl.trim() } : {}),
  });
  const hasContent = Boolean(title.trim() || address.trim() || description.trim());

  // After sign-in, bring back the saved draft unless the form already has text.
  useEffect(() => {
    if (!isOpen || pendingRegistration || !sessionAddress || restoredFor.current === sessionAddress) return;
    restoredFor.current = sessionAddress;
    autosaveId.current = null;
    let live = true;
    listDrafts().then((drafts) => {
      const d = drafts.find((x) => x.name === AUTOSAVE_NAME && x.kind === 'draft');
      if (!live || !d) return;
      autosaveId.current = d.id;
      if (title.trim() || address.trim() || description.trim()) return;
      if (d.title !== undefined) setTitle(d.title);
      if (d.address !== undefined) setAddress(d.address);
      if (d.neighborhood !== undefined) setNeighborhood(d.neighborhood);
      if (d.description !== undefined) setDescription(d.description);
      if (d.spotKind) setKind(d.spotKind);
      if (d.latitude !== undefined) setLatitude(d.latitude);
      if (d.longitude !== undefined) setLongitude(d.longitude);
      if (d.image) setImageUrl(d.image);
      if (d.minBidEth) setMinBidEth(d.minBidEth);
      if (d.amenities) setSelectedAmenities(d.amenities);
      if (d.spaceId !== undefined) setSpaceId(spaces.some((sp) => sp.id === d.spaceId) ? d.spaceId : '');
      // Saved dates that have passed are replaced by fresh defaults.
      const saved = parseSchedule({ cutoff: d.cutoff ?? '', start: d.start ?? '', end: d.end ?? '' }, zone, getChainNowSec());
      if (saved.schedule) { setCutoff(d.cutoff as string); setParkStart(d.start as string); setParkEnd(d.end as string); }
      setSaveState('saved');
    }, () => {});
    return () => { live = false; };
  }, [isOpen, pendingRegistration, sessionAddress]);

  useEffect(() => {
    if (!sessionAddress) restoredFor.current = null;
  }, [sessionAddress]);

  useEffect(() => {
    if (!sessionAddress || pendingRegistration || !hasContent || fieldsJson === lastSaved.current) return;
    setSaveState('unsaved');
    const timer = setTimeout(() => {
      setSaveState('saving');
      saveDraft(autosaveId.current, 'draft', AUTOSAVE_NAME, JSON.parse(fieldsJson)).then((id) => {
        autosaveId.current = id;
        lastSaved.current = fieldsJson;
        setSaveState('saved');
      }, () => setSaveState('error'));
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fieldsJson, sessionAddress, pendingRegistration, hasContent]);

  useLayoutEffect(() => {
    if (isOpen && preview) previewHeadingRef.current?.focus();
  }, [isOpen, preview]);

  if (!isOpen) return null;

  const handleClose = () => {
    setPreview(null);
    setFormError(null);
    onClose();
  };

  const handlePresetSelect = (presetIndex: number) => {
    const loc = AUSTIN_PRESET_LOCATIONS[presetIndex];
    if (loc) {
      setAddress(loc.address);
      setNeighborhood(loc.neighborhood);
      setLatitude(loc.latitude);
      setLongitude(loc.longitude);
      if (!title) {
        setTitle(`Private ${kind.charAt(0).toUpperCase() + kind.slice(1)} Spot near ${loc.name}`);
      }
    }
  };

  const toggleAmenity = (amenity: string) => {
    setSelectedAmenities((prev) =>
      prev.includes(amenity) ? prev.filter((a) => a !== amenity) : [...prev, amenity]
    );
  };

  const buildMetadata = (): SpotMetadata => ({
    title: title.trim(),
    address: address.trim(),
    neighborhood: neighborhood.trim(),
    latitude,
    longitude,
    description: description.trim(),
    image: imageUrl.trim() || CURATED_PARKING_PHOTOS[0].url,
    kind,
    amenities: selectedAmenities,
  });

  // Pending registration metadata is immutable: it is the only metadata that may be registered.
  const previewKey = (): string =>
    JSON.stringify(
      pendingRegistration
        ? ['pending', pendingRegistration.auctionId, pendingRegistration.metadata]
        : [buildMetadata(), minBidEth, cutoff, parkStart, parkEnd, zone, spaceId, protectedBooking]
    );

  // A preview is only valid while the inputs it was built from are unchanged.
  const activePreview = preview && preview.key === previewKey() ? preview : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setPreview(null);

    if (wrongChain) {
      setFormError(`Please switch to ${webProfile.networkName} (Chain ${webProfile.chainId}) before proceeding.`);
      return;
    }

    if (!walletState.address) {
      setFormError(import.meta.env.VITE_BIDPARK_PROFILE !== 'sepolia'
        ? 'Wallet not connected. Connect a local test account first.'
        : 'Wallet not connected. Connect a browser wallet first.');
      return;
    }

    const metadata = pendingRegistration ? pendingRegistration.metadata : buildMetadata();

    if (!metadata.title.trim() || !metadata.address.trim() || !metadata.description.trim()) {
      setFormError('Please fill in title, address, and description.');
      return;
    }

    // Validate metadata against conservative bounds using shared pure validator
    const validation = validateSpotMetadata(metadata);
    if (!validation.valid || !validation.normalized) {
      setFormError(validation.error || 'Spot metadata failed validation checks.');
      return;
    }

    if (!pendingRegistration) {
      const minBidNum = parseFloat(minBidEth);
      if (isNaN(minBidNum) || minBidNum <= 0) {
        setFormError('Please provide a valid minimum bid in ETH.');
        return;
      }
      if (!parsed.schedule) {
        setFormError(parsed.error);
        return;
      }
      if (conflicts.length > 0) {
        setFormError('The window overlaps a held or blocked window on this space. Choose other times or another space.');
        return;
      }
    }

    setPreview({ key: previewKey(), metadata: validation.normalized });
  };

  const handleConfirm = async () => {
    if (!activePreview || isSubmitting) return;
    setFormError(null);

    // IF PENDING REGISTRATION: Do not create another on-chain auction; retry the metadata registration!
    if (pendingRegistration) {
      if (onRetryRegistration) {
        try {
          await onRetryRegistration(pendingRegistration.auctionId, pendingRegistration.metadata);
          handleClose();
        } catch (err) {
          setFormError(err instanceof Error ? err.message : 'Failed to register metadata');
        }
      }
      return;
    }

    if (!parsed.schedule || conflicts.length > 0) return;
    const { bidEnd: bidEndSec, start: parkingStartSec, end: parkingEndSec } = parsed.schedule;

    try {
      await onSubmitCreate(
        activePreview.metadata,
        minBidEth,
        bidEndSec,
        parkingStartSec,
        parkingEndSec,
        spaceId || undefined,
        protectedBooking && canProtect
      );
      // The listing is made: drop the autosaved draft and start the next one from fresh defaults.
      if (autosaveId.current !== null) void deleteDraft(autosaveId.current).catch(() => {});
      autosaveId.current = null;
      lastSaved.current = '';
      setSaveState('idle');
      setCutoff(''); setParkStart(''); setParkEnd('');
      handleClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create auction');
    }
  };

  return (
    <Dialog
      className="modal-dialog modal-create-dialog"
      labelledBy="create-listing-title"
      onClose={handleClose}
      canClose={!isSubmitting}
      initialFocusRef={titleInputRef}
    >
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-icon-title">
            <div className="icon-badge-forest">
              {pendingRegistration ? <RotateCcw size={20} /> : <PlusCircle size={20} />}
            </div>
            <div>
              <h3 id="create-listing-title" className="modal-heading">
                {pendingRegistration
                  ? `Retry Registration: Auction #${pendingRegistration.auctionId}`
                  : 'List Private Parking Spot'}
              </h3>
              <p className="modal-subheading">
                {pendingRegistration
                  ? 'Onchain contract confirmed. Complete metadata registration with API.'
                  : `Deploy a timed auction with smart contract escrow on ${webProfile.networkName}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={handleClose}
            disabled={isSubmitting}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Form */}
        <form onSubmit={handleSubmit} className="modal-form-scrollable">
          {/* Pending registration notice if applicable */}
          {pendingRegistration && (
            <div className="form-section-banner pending-banner">
              <RotateCcw size={16} className="text-orange" />
              <div>
                <strong>Pending On-Chain Auction Confirmed:</strong> Auction #{pendingRegistration.auctionId} exists on-chain. Resubmitting this form registers its metadata without creating another duplicate auction.
              </div>
            </div>
          )}

          <fieldset disabled={isSubmitting || Boolean(pendingRegistration)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {/* Preset location quick picker (hide in pending retry mode) */}
          {!pendingRegistration && (
            <div className="form-section-banner">
              <Compass size={15} />
              <span className="banner-label">Austin Location Presets:</span>
              <div className="preset-buttons-row">
                {AUSTIN_PRESET_LOCATIONS.map((loc, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="preset-chip-btn"
                    onClick={() => handlePresetSelect(idx)}
                  >
                    {loc.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Basic Details */}
          <div className="form-grid-2col">
            <div className="form-field full-width">
              <label htmlFor="spot-title" className="form-label">
                Listing Title
              </label>
              <input
                id="spot-title"
                ref={titleInputRef}
                type="text"
                className="form-input"
                placeholder="e.g. Covered Carport 2 blocks from Moody Center"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="form-field">
              <label htmlFor="spot-kind" className="form-label">
                Parking Space Kind
              </label>
              <select
                id="spot-kind"
                className="form-select"
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as 'driveway' | 'garage' | 'covered')
                }
                disabled={isSubmitting}
              >
                <option value="driveway">Private Driveway</option>
                <option value="garage">Attached / Enclosed Garage</option>
                <option value="covered">Covered Carport</option>
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="spot-neighborhood" className="form-label">
                Neighborhood
              </label>
              <input
                id="spot-neighborhood"
                type="text"
                className="form-input"
                placeholder="e.g. Rainey Historic District"
                value={neighborhood}
                onChange={(e) => setNeighborhood(e.target.value)}
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="form-field full-width">
              <label htmlFor="spot-address" className="form-label">
                Street Address
              </label>
              <input
                id="spot-address"
                type="text"
                className="form-input"
                placeholder="e.g. 70 Rainey St, Austin, TX 78701"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="form-field">
              <label htmlFor="spot-lat" className="form-label">
                Latitude
              </label>
              <input
                id="spot-lat"
                type="number"
                step="0.0001"
                className="form-input"
                value={latitude}
                onChange={(e) => setLatitude(parseFloat(e.target.value) || 0)}
                required
                disabled={isSubmitting}
              />
            </div>

            <div className="form-field">
              <label htmlFor="spot-lng" className="form-label">
                Longitude
              </label>
              <input
                id="spot-lng"
                type="number"
                step="0.0001"
                className="form-input"
                value={longitude}
                onChange={(e) => setLongitude(parseFloat(e.target.value) || 0)}
                required
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Description */}
          <div className="form-field">
            <label htmlFor="spot-desc" className="form-label">
              Public space description
            </label>
            <textarea
              id="spot-desc"
              rows={3}
              className="form-textarea"
              placeholder="Describe the space: size, surface, lighting, clearance height, or nearby landmarks..."
              aria-describedby="spot-desc-warning"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              disabled={isSubmitting}
            />
            <p id="spot-desc-warning" className="public-warning-text" role="note">
              {PUBLIC_WARNING}
            </p>
          </div>

          {/* Photo Picker */}
          <div className="form-field">
            <span className="form-label" id="photo-picker-label">Space Photograph</span>
            <div className="photo-picker-grid" role="group" aria-labelledby="photo-picker-label">
              {CURATED_PARKING_PHOTOS.map((photo, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`photo-thumb-option ${imageUrl === photo.url ? 'is-active-photo' : ''}`}
                  onClick={() => setImageUrl(photo.url)}
                  aria-pressed={imageUrl === photo.url}
                  aria-label={`Use photo: ${photo.title}`}
                  disabled={isSubmitting}
                >
                  <img src={photo.url} alt="" />
                  {imageUrl === photo.url && (
                    <div className="photo-check-badge">
                      <Check size={12} />
                    </div>
                  )}
                </button>
              ))}
            </div>
            <div className="custom-photo-row">
              <label htmlFor="spot-image-url" className="photo-custom-label">
                Or custom image URL:
              </label>
              <input
                id="spot-image-url"
                type="url"
                className="form-input"
                placeholder="https://..."
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          </div>

          {/* Amenities Multi-Select */}
          <div className="form-field">
            <span className="form-label" id="amenities-label">Select Amenities & Spot Features</span>
            <div className="amenities-checkbox-grid" role="group" aria-labelledby="amenities-label">
              {COMMON_AMENITIES.map((amenity) => {
                const isChecked = selectedAmenities.includes(amenity);
                return (
                  <button
                    key={amenity}
                    type="button"
                    className={`amenity-chip-toggle ${isChecked ? 'is-checked' : ''}`}
                    onClick={() => toggleAmenity(amenity)}
                    aria-pressed={isChecked}
                    disabled={isSubmitting}
                  >
                    <span className="checkbox-box">{isChecked ? '✓' : ''}</span>
                    <span>{amenity}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Auction Financials & Timings (hidden or locked when pendingRegistration) */}
          {!pendingRegistration && (
            <div className="form-auction-box">
              <h4 className="auction-box-heading">Auction Timing & Escrow Parameters</h4>
              {spaces.length > 0 && (
                <div className="form-field">
                  <label htmlFor="parking-space" className="form-label">
                    Parking space
                  </label>
                  <select
                    id="parking-space"
                    className="form-select"
                    value={spaceId}
                    onChange={(e) => setSpaceId(e.target.value)}
                    disabled={isSubmitting}
                    aria-describedby="parking-space-calendar"
                  >
                    <option value="">New space</option>
                    {spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        Space #{space.id}: {space.title}{space.lister ? ' (approved lister)' : ''}
                      </option>
                    ))}
                  </select>
                  <p id="parking-space-calendar" className="auction-disclosure-subtext">
                    {(() => {
                      const held = spaces.find((space) => space.id === spaceId)?.held ?? [];
                      if (!spaceId) return 'A new space gets its own calendar.';
                      if (held.length === 0) return 'No reserved windows on this space.';
                      return `Reserved: ${held.map((w) => `${formatDateTime(w.start)} to ${formatDateTime(w.end)}`).join('; ')}. The contract rejects an overlapping window.`;
                    })()}
                  </p>
                </div>
              )}
              <div className="form-grid-3col">
                <div className="form-field">
                  <label htmlFor="min-bid" className="form-label">
                    Opening Min Bid (ETH)
                  </label>
                  <div className="input-with-currency">
                    <input
                      id="min-bid"
                      type="number"
                      step="0.005"
                      className="form-input"
                      value={minBidEth}
                      onChange={(e) => setMinBidEth(e.target.value)}
                      required
                      disabled={isSubmitting}
                    />
                    <span className="currency-suffix">ETH</span>
                  </div>
                </div>
              </div>

              <p className="auction-disclosure-subtext" data-testid="schedule-zone">
                Times are in {zone}{zoneIsSet ? ' (this space’s time zone)' : space ? ' (no time zone set on this space yet; showing your browser’s zone)' : ' (your browser’s zone; set one on the space after it exists)'}.
              </p>
              <div className="form-grid-3col">
                <div className="form-field">
                  <label htmlFor="bid-cutoff" className="form-label">Bidding Cutoff</label>
                  <input id="bid-cutoff" type="datetime-local" className="form-input" value={cutoff}
                    onChange={(e) => setCutoff(e.target.value)} disabled={isSubmitting} />
                </div>
                <div className="form-field">
                  <label htmlFor="parking-start" className="form-label">Parking Starts</label>
                  <input id="parking-start" type="datetime-local" className="form-input" value={parkStart}
                    onChange={(e) => setParkStart(e.target.value)} disabled={isSubmitting} />
                </div>
                <div className="form-field">
                  <label htmlFor="parking-end" className="form-label">Parking Ends</label>
                  <input id="parking-end" type="datetime-local" className="form-input" value={parkEnd}
                    onChange={(e) => setParkEnd(e.target.value)} disabled={isSubmitting} />
                </div>
              </div>
              {conflicts.length > 0 && (
                <p role="alert" className="workspace-conflicts" data-testid="schedule-conflicts">
                  Overlaps a held or blocked window on this space: {conflicts.map((c) => `${c.kind} ${formatDateTime(c.start)} to ${formatDateTime(c.end)}`).join('; ')}.
                </p>
              )}
              {parsed.error && (cutoff || parkStart || parkEnd) && <p role="alert" className="workspace-conflicts" data-testid="schedule-error">{parsed.error}</p>}
              {parsed.schedule && space && conflicts.length === 0 && (
                <p role="status" data-testid="schedule-clear">No conflicts with held or blocked windows. The contract checks again when you sign.</p>
              )}

              <label className="form-checkbox-row">
                <input
                  type="checkbox"
                  checked={protectedBooking && canProtect}
                  onChange={(e) => setProtectedBooking(e.target.checked)}
                  disabled={isSubmitting || !canProtect}
                />
                <span>
                  Protected booking: you can withdraw it before parking starts (the winner is refunded in full),
                  the winner or you can report a seller failure for a resolver to decide, and your payout opens
                  24 hours after parking ends. Needs at least 30 minutes between the cutoff and parking start.
                </span>
              </label>

              <p className="auction-disclosure-subtext">
                * Note: Smart contract locks all bids. Seller payout will become claimable only after the parking window ends.
              </p>
            </div>
          )}
          </fieldset>

          {formError && (
            <div className="form-error-alert" role="alert">
              <AlertCircle size={15} />
              <span>{formError}</span>
            </div>
          )}

          {activePreview && (
            <section
              className="form-section-banner submission-preview"
              aria-labelledby="submission-preview-heading"
              data-testid="submission-preview"
              style={{ display: 'block' }}
            >
              <h4 id="submission-preview-heading" className="auction-box-heading" ref={previewHeadingRef} tabIndex={-1}>
                Review public listing before signing
              </h4>
              <p id="preview-public-warning" className="public-warning-text" role="note">
                <strong>{PUBLIC_WARNING}</strong> This exact content is what will be published.
                {pendingRegistration
                  ? ' Confirming registers only this metadata; no new auction is created.'
                  : ' Nothing is signed or sent until you confirm.'}
              </p>
              <dl data-testid="preview-metadata">
                <dt>Title</dt>
                <dd data-field="title">{activePreview.metadata.title}</dd>
                <dt>Kind</dt>
                <dd data-field="kind">{activePreview.metadata.kind}</dd>
                <dt>Street address</dt>
                <dd data-field="address">{activePreview.metadata.address}</dd>
                <dt>Neighborhood</dt>
                <dd data-field="neighborhood">{activePreview.metadata.neighborhood}</dd>
                <dt>Coordinates</dt>
                <dd data-field="coordinates">
                  {activePreview.metadata.latitude}, {activePreview.metadata.longitude}
                </dd>
                <dt>Public space description</dt>
                <dd data-field="description" style={{ whiteSpace: 'pre-wrap' }}>
                  {activePreview.metadata.description}
                </dd>
                <dt>Image URL</dt>
                <dd data-field="image">{activePreview.metadata.image}</dd>
                <dt>Amenities</dt>
                <dd data-field="amenities">
                  {activePreview.metadata.amenities.length > 0
                    ? activePreview.metadata.amenities.join(', ')
                    : 'None'}
                </dd>
                {!pendingRegistration && (
                  <>
                    <dt>Opening min bid</dt>
                    <dd data-field="minBid">{minBidEth} ETH</dd>
                  </>
                )}
              </dl>
            </section>
          )}
          <p className="sr-only" role="status">
            {isSubmitting
              ? pendingRegistration
                ? 'Registering listing metadata'
                : 'Deploying auction to escrow'
              : ''}
          </p>

          {!pendingRegistration && (
            <p className="auction-disclosure-subtext" role="status" data-testid="autosave-status">
              {!sessionAddress ? 'Sign in to save this listing as a draft automatically.'
                : saveState === 'saving' ? 'Saving draft…'
                  : saveState === 'saved' ? 'Draft saved.'
                    : saveState === 'error' ? 'Not saved: the draft could not be saved. Your changes are still in this form.'
                      : saveState === 'unsaved' ? 'Unsaved changes' : 'Drafts save automatically.'}
            </p>
          )}

          {/* Submit footer */}
          <div className="modal-actions-footer">
            <button
              type="button"
              className="btn-modal-cancel-action"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            {activePreview ? (
              <>
                {!pendingRegistration && (
                  <button
                    type="button"
                    className="btn-modal-cancel-action"
                    onClick={() => {
                      setPreview(null);
                      titleInputRef.current?.focus();
                    }}
                    disabled={isSubmitting}
                  >
                    Edit listing
                  </button>
                )}
                <button
                  type="button"
                  className="btn-modal-submit-create"
                  onClick={handleConfirm}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={16} className="is-spinning" />
                      <span>
                        {pendingRegistration
                          ? 'Registering Metadata…'
                          : 'Deploying Auction to Escrow…'}
                      </span>
                    </>
                  ) : (
                    <>
                      {pendingRegistration ? <RotateCcw size={16} /> : <Warehouse size={16} />}
                      <span>
                        {pendingRegistration
                          ? `Confirm and Complete Registration (#${pendingRegistration.auctionId})`
                          : 'Confirm and Deploy Auction'}
                      </span>
                    </>
                  )}
                </button>
              </>
            ) : (
              <button type="submit" className="btn-modal-submit-create" disabled={isSubmitting}>
                <Check size={16} />
                <span>Review public listing</span>
              </button>
            )}
          </div>
        </form>
    </Dialog>
  );
};
