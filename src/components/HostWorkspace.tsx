import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddress } from 'ethers';
import type { Listing, SpotMetadata } from '../types';
import type { HostSpace, SpaceAction } from '../services/blockchain';
import { deleteDraft, listDrafts, saveDraft, type DraftFields, type DraftKind, type SavedDraft } from '../services/workspace';
import { isValidImageUrl, validateSpotMetadata } from '../../shared/validation.js';
import { AUSTIN_PRESET_LOCATIONS, CURATED_PARKING_PHOTOS } from '../utils/constants';
import { formatDateTime } from '../utils/formatters';
import { getChainNowSec } from '../utils/eligibility';
import { MIN_BID_LEAD } from '../utils/booking';
import { findConflicts, isValidZone, parseSchedule, zonedToEpoch, type Span } from '../utils/schedule';
import { STATUS_TEXT, type HostVerification } from './Verification';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Windows a space still holds on-chain: not cancelled, and either bid on or still open for bids. */
export function heldWindows(listings: Listing[], spaceId: string, nowSec: number): Span[] {
  return listings
    .filter((l) => l.spaceId === spaceId && !l.cancelled && (BigInt(l.highestBidder || 0) !== 0n || l.bidEnd > nowSec))
    .map((l) => ({ start: l.parkingStart, end: l.parkingEnd }));
}

const EMPTY: DraftFields = {
  title: '', address: AUSTIN_PRESET_LOCATIONS[0].address, neighborhood: AUSTIN_PRESET_LOCATIONS[0].neighborhood,
  description: '', image: '', spotKind: 'driveway',
  latitude: AUSTIN_PRESET_LOCATIONS[0].latitude, longitude: AUSTIN_PRESET_LOCATIONS[0].longitude,
  minBidEth: '0.05', spaceId: '', cutoff: '', start: '', end: '',
};

interface Props {
  signedIn: boolean;
  spaces: HostSpace[];
  spacesError: string | null;
  listings: Listing[];
  verifications: HostVerification[];
  isActionBusy: boolean;
  onSpaceAction: (action: SpaceAction, label: string) => Promise<boolean>;
  onPublish: (metadata: SpotMetadata, minBidEth: string, bidEnd: number, start: number, end: number, spaceId?: string, protectedBooking?: boolean) => Promise<void>;
  onSignIn: () => void;
}

export const HostWorkspace: React.FC<Props> = ({
  signedIn, spaces, spacesError, listings, verifications, isActionBusy, onSpaceAction, onPublish, onSignIn,
}) => {
  const [form, setForm] = useState<DraftFields>(EMPTY);
  const [editing, setEditing] = useState<{ id: number | null; name: string; kind: DraftKind }>({ id: null, name: '', kind: 'draft' });
  const [drafts, setDrafts] = useState<SavedDraft[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [protectedBooking, setProtectedBooking] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [nowSec, setNowSec] = useState(() => getChainNowSec());
  const set = <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => setForm((f) => ({ ...f, [key]: value }));

  const reloadDrafts = useCallback(async () => {
    try {
      setDrafts(await listDrafts());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    if (signedIn) void reloadDrafts();
  }, [signedIn, reloadDrafts]);
  useEffect(() => { setPhotoFailed(false); }, [form.image]);
  useEffect(() => {
    const timer = setInterval(() => setNowSec(getChainNowSec()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const space = spaces.find((s) => s.id === form.spaceId) ?? null;
  const zone = space?.timeZone && isValidZone(space.timeZone) ? space.timeZone : browserZone();
  const zoneIsSet = Boolean(space?.timeZone && isValidZone(space.timeZone));
  const parsed = useMemo(() => parseSchedule(form, zone, nowSec), [form, zone, nowSec]);
  const conflicts = useMemo(() => {
    if (!parsed.schedule || !space) return [];
    return findConflicts({ start: parsed.schedule.start, end: parsed.schedule.end },
      heldWindows(listings, space.id, nowSec), space.blocked);
  }, [parsed, space, listings, nowSec]);

  const metadata = useMemo<SpotMetadata>(() => ({
    title: form.title.trim(), address: form.address.trim(), neighborhood: form.neighborhood.trim(),
    latitude: form.latitude, longitude: form.longitude, description: form.description.trim(),
    image: form.image.trim() || CURATED_PARKING_PHOTOS[0].url, kind: form.spotKind, amenities: [],
  }), [form]);
  const validation = useMemo(() => validateSpotMetadata(metadata), [metadata]);
  const photoOk = !form.image.trim() || isValidImageUrl(form.image.trim());
  const minBidOk = /^\d{1,6}(\.\d{1,18})?$/.test(form.minBidEth) && Number(form.minBidEth) > 0;
  const problem = !validation.valid ? validation.error ?? 'Listing details are incomplete.'
    : !photoOk ? 'Photo must be an https URL or a local path starting with /'
      : !minBidOk ? 'Enter a minimum bid greater than 0.'
        : parsed.error ?? (conflicts.length > 0 ? 'The window overlaps a held or blocked window on this space.'
          : protectedBooking && parsed.schedule && parsed.schedule.start - parsed.schedule.bidEnd < MIN_BID_LEAD
            ? 'A protected booking needs at least 30 minutes between the bidding cutoff and parking start. Move the cutoff earlier or the start later, or clear Protected booking.'
            : null);

  function fill(source: Partial<DraftFields>, keepDates: boolean) {
    setForm({ ...EMPTY, ...source, ...(keepDates ? {} : { cutoff: '', start: '', end: '' }) });
    setProtectedBooking(false);
  }
  function relist(spaceId: string) {
    const latest = [...listings].filter((l) => l.spaceId === spaceId).sort((a, b) => b.parkingEnd - a.parkingEnd)[0];
    setEditing({ id: null, name: '', kind: 'draft' });
    fill(latest ? {
      title: latest.title, address: latest.address, neighborhood: latest.neighborhood, description: latest.description,
      image: latest.image, spotKind: latest.kind, latitude: latest.latitude, longitude: latest.longitude, spaceId,
    } : { spaceId }, false);
    setMessage(`Relisting space #${spaceId}: choose new dates and a minimum bid. Past bids and results are not copied.`);
  }
  function load(draft: SavedDraft, asNew: boolean) {
    const { id: _id, kind, name, updatedAt: _u, ...fields } = draft;
    fill(fields, !asNew);
    setEditing(asNew ? { id: null, name: `${name} copy`, kind: 'draft' } : { id: draft.id, name, kind });
    setMessage(asNew ? 'Loaded as a new draft with dates cleared.' : `Loaded "${name}".`);
  }
  async function save(kind: DraftKind) {
    const name = editing.name.trim() || form.title.trim();
    if (!name) return void setMessage('Give the draft a name or a title before saving.');
    try {
      // A template is reusable, so it never keeps dates; a draft keeps everything entered so far.
      const fields = kind === 'template' ? { ...form, cutoff: '', start: '', end: '' } : form;
      const id = await saveDraft(editing.kind === kind ? editing.id : null, kind, name, fields);
      setEditing({ id, name, kind });
      setMessage(`Saved ${kind} "${name}".`);
      await reloadDrafts();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }
  async function remove(draft: SavedDraft) {
    try {
      await deleteDraft(draft.id);
      if (editing.id === draft.id) setEditing({ id: null, name: '', kind: 'draft' });
      await reloadDrafts();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }
  async function publish() {
    if (problem || !parsed.schedule || !validation.normalized) return;
    try {
      await onPublish(validation.normalized, form.minBidEth, parsed.schedule.bidEnd, parsed.schedule.start, parsed.schedule.end, form.spaceId || undefined, protectedBooking);
      setProtectedBooking(false);
      setMessage('Auction created.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const when = (sec: number) => formatDateTime(sec, zone);
  const verificationOf = (id: string) => STATUS_TEXT[verifications.find((v) => v.spaceId === id)?.status ?? 'unverified'];

  return (
    <section className="activity-section" aria-labelledby="workspace-title" data-testid="host-workspace">
      <div className="activity-section-header">
        <h2 id="workspace-title" className="activity-section-title">Host workspace</h2>
      </div>
      {spacesError && <p className="activity-empty-text" role="alert">Could not read your spaces: {spacesError}</p>}
      {message && <p className="activity-empty-text" role="status">{message}</p>}

      <h3 className="workspace-heading">Your spaces</h3>
      {spaces.length === 0 && <p className="activity-empty-text">No spaces yet. Listing a spot creates your first space, or ask a space owner to approve this wallet as a lister.</p>}
      <ul className="inbox-list">
        {spaces.map((s) => (
          <SpaceCard
            key={s.id} space={s} held={heldWindows(listings, s.id, nowSec)} verification={verificationOf(s.id)}
            busy={isActionBusy} onAction={onSpaceAction} onRelist={() => relist(s.id)}
          />
        ))}
      </ul>

      <h3 className="workspace-heading">Schedule a listing</h3>
      {!signedIn && (
        <p className="activity-empty-text">
          Drafts are private to your wallet and need a session. <button type="button" className="btn-table-action" onClick={onSignIn}>Sign in to save drafts</button>
        </p>
      )}
      <form className="workspace-form" onSubmit={(e) => { e.preventDefault(); void publish(); }}>
        <label>Draft name
          <input className="form-input" value={editing.name} maxLength={80} onChange={(e) => setEditing((x) => ({ ...x, name: e.target.value }))} />
        </label>
        <label>Parking space
          <select className="form-select" value={form.spaceId} onChange={(e) => set('spaceId', e.target.value)}>
            <option value="">New space</option>
            {spaces.map((s) => <option key={s.id} value={s.id}>Space #{s.id}{s.isLister ? ' (approved lister)' : ''}</option>)}
          </select>
        </label>
        <label>Title
          <input className="form-input" value={form.title} maxLength={120} onChange={(e) => set('title', e.target.value)} />
        </label>
        <label>Location preset
          <select className="form-select" defaultValue="" onChange={(e) => {
            const preset = AUSTIN_PRESET_LOCATIONS[Number(e.target.value)];
            if (preset) setForm((f) => ({ ...f, address: preset.address, neighborhood: preset.neighborhood, latitude: preset.latitude, longitude: preset.longitude }));
          }}>
            <option value="">Keep current location</option>
            {AUSTIN_PRESET_LOCATIONS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          </select>
        </label>
        <label>Street address
          <input className="form-input" value={form.address} maxLength={200} onChange={(e) => set('address', e.target.value)} />
        </label>
        <label>Public description
          <textarea className="form-textarea" rows={2} value={form.description} maxLength={2000} onChange={(e) => set('description', e.target.value)} />
        </label>
        <p className="auction-disclosure-subtext">Public: shown to everyone. Do not enter gate codes or other access details.</p>
        <label>Space kind
          <select className="form-select" value={form.spotKind} onChange={(e) => set('spotKind', e.target.value as DraftFields['spotKind'])}>
            <option value="driveway">Driveway</option><option value="garage">Garage</option><option value="covered">Covered</option>
          </select>
        </label>
        <label>Photo URL (https) or local path
          <input className="form-input" value={form.image} maxLength={1000} placeholder="https://… or /images/…" onChange={(e) => set('image', e.target.value)} />
        </label>
        <div className="workspace-photo" data-testid="photo-preview">
          {!photoOk ? (
            <p role="alert">This photo reference is not allowed: use an https URL or a path starting with /. Uploads are not supported.</p>
          ) : photoFailed ? (
            <p>The photo could not be loaded; the listing will still show it, so check the link or clear it to use the default photo.</p>
          ) : (
            <img src={form.image.trim() || CURATED_PARKING_PHOTOS[0].url} alt="Photo preview" width={160} height={100} onError={() => setPhotoFailed(true)} />
          )}
          {!form.image.trim() && <p className="auction-disclosure-subtext">No photo set: the default illustrative photo is used.</p>}
        </div>
        <label>Minimum bid (ETH)
          <input className="form-input" inputMode="decimal" value={form.minBidEth} onChange={(e) => set('minBidEth', e.target.value)} />
        </label>
        <p className="auction-disclosure-subtext" data-testid="schedule-zone">
          Times are in {zone}{zoneIsSet ? ' (this space’s time zone)' : space ? ' (no time zone set on this space yet; showing your browser’s zone)' : ' (your browser’s zone; set one on the space after it exists)'}.
        </p>
        <label>Bidding cutoff
          <input className="form-input" type="datetime-local" value={form.cutoff} onChange={(e) => set('cutoff', e.target.value)} />
        </label>
        <label>Parking starts
          <input className="form-input" type="datetime-local" value={form.start} onChange={(e) => set('start', e.target.value)} />
        </label>
        <label>Parking ends
          <input className="form-input" type="datetime-local" value={form.end} onChange={(e) => set('end', e.target.value)} />
        </label>

        <label className="form-checkbox-row">
          <input
            type="checkbox"
            checked={protectedBooking}
            onChange={(e) => setProtectedBooking(e.target.checked)}
            aria-labelledby="workspace-protected-booking"
            aria-describedby="workspace-protected-booking-help"
          />
          <span>
            <strong id="workspace-protected-booking">Protected booking</strong>{' '}
            <span id="workspace-protected-booking-help">
              You can withdraw it after bidding closes and before parking starts (the winner is refunded in full).
              The winner or you can report a seller failure, and your payout opens 24 hours after parking ends if no report is open.
              Parking must start at least 30 minutes after bidding closes.
            </span>
          </span>
        </label>

        {conflicts.length > 0 && (
          <div role="alert" className="workspace-conflicts" data-testid="schedule-conflicts">
            Conflicts on space #{space?.id}:
            <ul>{conflicts.map((c, i) => <li key={i}>{c.kind === 'held' ? 'Held by an auction' : 'Blocked'}: {when(c.start)} to {when(c.end)}</li>)}</ul>
          </div>
        )}
        {parsed.error && (form.cutoff || form.start || form.end) && <p role="alert" className="workspace-conflicts" data-testid="schedule-error">{parsed.error}</p>}
        {space && !conflicts.length && parsed.schedule && <p role="status" data-testid="schedule-clear">No conflicts with held or blocked windows. The contract checks again when you sign.</p>}

        {parsed.schedule && (
          <dl className="workspace-preview" data-testid="snapshot-preview" aria-label="Public listing snapshot">
            <dt>Public snapshot</dt><dd>{metadata.title || '(no title)'} at {metadata.address}</dd>
            <dt>Bidding closes</dt><dd>{when(parsed.schedule.bidEnd)} ({new Date(parsed.schedule.bidEnd * 1000).toISOString()})</dd>
            <dt>Parking</dt><dd>{when(parsed.schedule.start)} to {when(parsed.schedule.end)} ({Math.round((parsed.schedule.end - parsed.schedule.start) / 360) / 10} h)</dd>
            <dt>Minimum bid</dt><dd>{form.minBidEth} ETH</dd>
            <dt>Booking</dt><dd>{protectedBooking ? 'Protected booking' : 'Standard booking'}</dd>
          </dl>
        )}
        {problem && <p className="auction-disclosure-subtext" data-testid="schedule-problem">{problem}</p>}

        <div className="verification-form">
          <button type="button" className="btn-table-action" disabled={!signedIn} onClick={() => void save('draft')}>Save draft</button>
          <button type="button" className="btn-table-action" disabled={!signedIn} onClick={() => void save('template')}>Save as template</button>
          <button type="submit" className="btn-table-action" disabled={isActionBusy || problem !== null}>Sign and create auction</button>
        </div>
      </form>

      <h3 className="workspace-heading">Saved drafts and templates</h3>
      {signedIn && drafts.length === 0 && <p className="activity-empty-text">Nothing saved yet.</p>}
      <ul className="inbox-list" data-testid="draft-list">
        {drafts.map((d) => (
          <li key={d.id} className="inbox-item verification-item" data-draft-id={d.id}>
            <span className="inbox-text"><strong>{d.name}</strong> ({d.kind}{d.spaceId ? `, space #${d.spaceId}` : ''}) saved {new Date(d.updatedAt).toLocaleString()}</span>
            <div className="verification-form">
              <button type="button" className="btn-table-action" onClick={() => load(d, d.kind === 'template')}>{d.kind === 'template' ? 'Use template' : 'Open'}</button>
              {d.kind === 'draft' && <button type="button" className="btn-table-action" onClick={() => load(d, true)}>Relist as new</button>}
              <button type="button" className="btn-table-action" onClick={() => void remove(d)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

interface CardProps {
  space: HostSpace;
  held: Span[];
  verification: string;
  busy: boolean;
  onAction: Props['onSpaceAction'];
  onRelist: () => void;
}

const SpaceCard: React.FC<CardProps> = ({ space, held, verification, busy, onAction, onRelist }) => {
  const [lister, setLister] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [zoneInput, setZoneInput] = useState(space.timeZone);
  const [block, setBlock] = useState({ start: '', end: '' });
  const [note, setNote] = useState<string | null>(null);
  const zone = isValidZone(space.timeZone) ? space.timeZone : browserZone();
  const fmt = (sec: number) => formatDateTime(sec, zone);

  async function run(action: SpaceAction, label: string) {
    setNote(null);
    await onAction(action, label);
  }
  const blockSchedule = (() => {
    if (!block.start || !block.end) return null;
    const start = zonedToEpoch(block.start, zone);
    const end = zonedToEpoch(block.end, zone);
    return start !== null && end !== null ? { start, end } : null;
  })();
  const blockConflicts = blockSchedule ? findConflicts({ start: blockSchedule.start, end: blockSchedule.end }, held, space.blocked) : [];

  return (
    <li className="inbox-item verification-item" data-space-id={space.id}>
      <span className="inbox-text">
        <strong>Space #{space.id}</strong> - {space.isOwner ? 'you own it' : 'approved lister'} - {verification} - time zone: {space.timeZone || 'not set'}
      </span>
      <ul className="workspace-calendar" aria-label={`Calendar for space ${space.id}`}>
        {held.length === 0 && space.blocked.length === 0 && <li>No held or blocked windows.</li>}
        {held.map((w, i) => <li key={`h${i}`}>Held: {fmt(w.start)} to {fmt(w.end)}</li>)}
        {space.blocked.map((w) => (
          <li key={w.id}>
            Blocked: {fmt(w.start)} to {fmt(w.end)}
            {space.isOwner && <> <button type="button" className="btn-table-action" disabled={busy} onClick={() => void run({ kind: 'unblock', blockId: w.id }, `Unblock window on space #${space.id}`)}>Unblock</button></>}
          </li>
        ))}
      </ul>
      <div className="verification-form">
        <button type="button" className="btn-table-action" onClick={onRelist}>Relist this space</button>
      </div>
      {space.isOwner && (
        <details>
          <summary>Manage space #{space.id}</summary>
          {note && <p role="status">{note}</p>}
          <fieldset className="verification-form">
            <legend>Time zone</legend>
            <input aria-label={`Time zone for space ${space.id}`} list="workspace-zones" value={zoneInput} maxLength={64} onChange={(e) => setZoneInput(e.target.value)} />
            <button type="button" className="btn-table-action" disabled={busy || zoneInput === space.timeZone || (zoneInput !== '' && !isValidZone(zoneInput))}
              onClick={() => void run({ kind: 'timeZone', spaceId: space.id, timeZone: zoneInput }, `Set time zone of space #${space.id}`)}>Set time zone</button>
            {zoneInput !== '' && !isValidZone(zoneInput) && <span role="alert">Not a known IANA time zone (for example America/Chicago).</span>}
          </fieldset>
          <fieldset className="verification-form">
            <legend>Approved listers</legend>
            <input aria-label={`Lister address for space ${space.id}`} placeholder="0x…" value={lister} onChange={(e) => setLister(e.target.value.trim())} />
            <button type="button" className="btn-table-action" disabled={busy || !isAddress(lister)}
              onClick={() => void run({ kind: 'lister', spaceId: space.id, lister, allowed: true }, `Approve lister on space #${space.id}`)}>Approve lister</button>
            <button type="button" className="btn-table-action" disabled={busy || !isAddress(lister)}
              onClick={() => void run({ kind: 'lister', spaceId: space.id, lister, allowed: false }, `Revoke lister on space #${space.id}`)}>Revoke lister</button>
            <span className="auction-disclosure-subtext">Revoking stops new listings only; auctions that already have bids stand.</span>
          </fieldset>
          <fieldset className="verification-form">
            <legend>Block dates (in {zone})</legend>
            <input type="datetime-local" aria-label={`Block start for space ${space.id}`} value={block.start} onChange={(e) => setBlock((b) => ({ ...b, start: e.target.value }))} />
            <input type="datetime-local" aria-label={`Block end for space ${space.id}`} value={block.end} onChange={(e) => setBlock((b) => ({ ...b, end: e.target.value }))} />
            <button type="button" className="btn-table-action" disabled={busy || !blockSchedule || blockSchedule.end <= blockSchedule.start || blockConflicts.length > 0}
              onClick={() => blockSchedule && void run({ kind: 'block', spaceId: space.id, start: blockSchedule.start, end: blockSchedule.end }, `Block window on space #${space.id}`)}>Block window</button>
            {blockConflicts.length > 0 && <span role="alert">Overlaps a held or blocked window.</span>}
          </fieldset>
          <fieldset className="verification-form">
            <legend>Transfer ownership</legend>
            <input aria-label={`New owner for space ${space.id}`} placeholder="0x…" value={newOwner} onChange={(e) => setNewOwner(e.target.value.trim())} />
            <label><input type="checkbox" checked={confirmTransfer} onChange={(e) => setConfirmTransfer(e.target.checked)} /> I understand this removes my control and all approved listers</label>
            <button type="button" className="btn-table-action" disabled={busy || !isAddress(newOwner) || !confirmTransfer}
              onClick={() => void run({ kind: 'transfer', spaceId: space.id, newOwner }, `Transfer space #${space.id}`)}>Transfer space</button>
          </fieldset>
        </details>
      )}
    </li>
  );
};

/** Time zone names for the zone inputs (the browser's list, when it has one). */
export const ZoneList: React.FC = () => {
  const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return <datalist id="workspace-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>;
};
