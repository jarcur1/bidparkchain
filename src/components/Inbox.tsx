import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime } from '../utils/formatters';
import { historyLink } from '../utils/history';

export type InboxKind = 'outbid' | 'won' | 'refund' | 'payout' | 'payout-ready' | 'booking-refund' | 'booking' | 'upcoming' | 'arrival' | 'checked-in';
export type InboxCategory = 'bids' | 'reservations' | 'bookings' | 'funds';
export type BookingChange =
  | 'refunded' | 'late-cancelled' | 'no-show' | 'dispute-opened' | 'dispute-upheld' | 'dispute-denied' | 'dispute-expired';
export interface InboxItem {
  id: string;
  kind: InboxKind;
  category?: InboxCategory;
  auctionId: string | null;
  title: string | null;
  amount?: string | null;
  /** Unix seconds the entry sorts by; null when a block time could not be read. */
  at?: number | null;
  /** On-chain entries only. */
  blockNumber?: number;
  txHash?: string;
  /** Booking entries: what changed, this wallet's side, and whether this wallet sent it. */
  change?: BookingChange;
  role?: 'host' | 'winner';
  byMe?: boolean;
  /** Reservation entries. */
  parkingStart?: number;
  parkingEnd?: number;
  hasInstructions?: boolean;
  checkedInAt?: number;
  read: boolean;
}
export interface InboxIndex {
  indexedBlock: number | null;
  headBlock: number | null;
  lagBlocks: number | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  /** Why upcoming-reservation and arrival entries could not be checked, if they could not. */
  reservationsError?: string | null;
}
export interface InboxResponse {
  items: InboxItem[];
  unread: number;
  preferences?: { hidden: InboxCategory[] };
  index: InboxIndex;
}
export interface InboxState {
  data: InboxResponse | null;
  /** Why the latest read failed; `data` then holds the last successful read, if any. */
  error: string | null;
  markRead: (ids: string[]) => Promise<void>;
  dismiss: (ids: string[]) => Promise<void>;
  setHidden: (hidden: InboxCategory[]) => Promise<void>;
  reload: () => Promise<void>;
}

export const INBOX_CATEGORY_LABELS: Record<InboxCategory, string> = {
  bids: 'Outbids and wins',
  reservations: 'Upcoming reservations and check-ins',
  bookings: 'Booking changes and reports',
  funds: 'Refunds and payouts',
};
const CATEGORIES = Object.keys(INBOX_CATEGORY_LABELS) as InboxCategory[];

async function inboxRequest(route: string, init?: RequestInit): Promise<InboxResponse> {
  const res = await fetch(route, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Inbox request failed (${res.status})`);
  return body as InboxResponse;
}

/** The signed-in wallet's inbox, polled while `account` is signed in; cleared when it changes. */
export function useInbox(account: string | null, pollMs = 10_000): InboxState {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (request: () => Promise<InboxResponse>) => {
    try {
      setData(await request());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const reload = useCallback(() => run(() => inboxRequest('/api/inbox')), [run]);
  const post = useCallback((route: string, body: unknown) => run(() => inboxRequest(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })), [run]);
  const markRead = useCallback((ids: string[]) => post('/api/inbox/read', { ids }), [post]);
  const dismiss = useCallback((ids: string[]) => post('/api/inbox/dismiss', { ids }), [post]);
  const setHidden = useCallback((hidden: InboxCategory[]) => post('/api/inbox/preferences', { hidden }), [post]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!account) return;
    void reload();
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [account, pollMs, reload]);

  return { data, error, markRead, dismiss, setHidden, reload };
}

function describeBooking(item: InboxItem, spot: string): string {
  const other = item.role === 'host' ? 'The winner' : 'The host';
  const who = item.byMe ? 'You' : other;
  switch (item.change) {
    case 'refunded': return `The booking for ${spot} ended and the winning bid was credited back to the winner, so there is no payout.`;
    case 'late-cancelled': return `${who} cancelled the booking for ${spot} less than 24 hours ahead. This is recorded only; the bid is not refunded.`;
    case 'no-show': return `${who} recorded a no-show for ${spot}. This is an attestation only and changes no funds or report rights.`;
    case 'dispute-opened': return `${who} reported a seller failure for ${spot}. The winning bid is held until a resolver decides or the report expires.`;
    case 'dispute-upheld': return `A resolver upheld the seller-failure report for ${spot}. The winning bid was credited back to the winner.`;
    case 'dispute-denied': return `A resolver denied the seller-failure report for ${spot}. The hold is released; the host payout still waits for the report window to close.`;
    case 'dispute-expired': return `The seller-failure report for ${spot} was not decided in time, so the winning bid was credited back to the winner.`;
    default: return `The booking for ${spot} changed.`;
  }
}

export function describe(item: InboxItem, timeZone?: string): string {
  const spot = item.title ? `"${item.title}"` : `auction #${item.auctionId}`;
  switch (item.kind) {
    case 'outbid': return `You were outbid on ${spot}. Your ${item.amount} ETH bid was credited to your refund balance.`;
    case 'won': return `You won ${spot} with a ${item.amount} ETH bid.`;
    case 'refund': return `You withdrew ${item.amount} ETH of refunds to your wallet.`;
    case 'payout': return `You claimed the ${item.amount} ETH payout for ${spot}.`;
    case 'payout-ready': return `The ${item.amount} ETH payout for ${spot} is ready to claim. Open the listing to claim it.`;
    case 'booking-refund': return `Your ${item.amount} ETH winning bid for ${spot} was credited to your refund balance.`;
    case 'booking': return describeBooking(item, spot);
    case 'upcoming': return `Your reservation at ${spot} starts ${formatDateTime(item.parkingStart ?? 0, timeZone)}.`;
    case 'arrival': return item.hasInstructions
      ? `Arrival instructions for ${spot} are available. Check-in opens 15 minutes before the start.`
      : `Arrival details for ${spot} are open; the host has not added instructions. Check-in opens 15 minutes before the start.`;
    case 'checked-in': return `The winner checked in for ${spot} at ${formatDateTime(Math.floor((item.checkedInAt ?? 0) / 1000), timeZone)}.`;
  }
}

/** Why the inbox may be incomplete, or null when it is current. */
export function inboxNotice(state: Pick<InboxState, 'data' | 'error'>): string | null {
  const { data, error } = state;
  if (error && !data) return `Inbox unavailable: ${error}`;
  if (error) return `Inbox could not be refreshed (${error}). Showing the last entries loaded.`;
  if (!data) return 'Loading inbox…';
  if (data.index.indexedBlock === null) return 'Auction events have not been indexed yet, so entries may be missing.';
  if (data.index.lastSyncError) return 'The latest event index update failed, so recent entries may be missing.';
  if (data.index.lagBlocks) return `The event index is ${data.index.lagBlocks} block${data.index.lagBlocks === 1 ? '' : 's'} behind the chain, so recent entries may be missing.`;
  if (data.index.reservationsError) return `${data.index.reservationsError}, so upcoming reservation entries may be missing.`;
  return null;
}

/**
 * A polite live region that announces entries that arrive after the inbox first loaded: one entry in
 * full, several as a count. The first load, a change of account and entries seen before (for example
 * after a preference is toggled back) are never announced.
 */
export const InboxAnnouncer: React.FC<{ inbox: Pick<InboxState, 'data'>; timeZoneOf?: (auctionId: string) => string | undefined }> = ({ inbox, timeZoneOf }) => {
  const seen = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState('');
  const data = inbox.data;
  useEffect(() => {
    if (!data) {
      seen.current = null;
      setMessage('');
      return;
    }
    if (!seen.current) {
      seen.current = new Set(data.items.map((item) => item.id));
      return;
    }
    const arrived = data.items.filter((item) => !seen.current!.has(item.id));
    arrived.forEach((item) => seen.current!.add(item.id));
    const fresh = arrived.filter((item) => !item.read);
    if (fresh.length === 1) setMessage(`New notification: ${describe(fresh[0], fresh[0].auctionId ? timeZoneOf?.(fresh[0].auctionId) : undefined)}`);
    else if (fresh.length > 1) setMessage(`${fresh.length} new notifications in your inbox`);
  }, [data, timeZoneOf]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="inbox-announcer">{message}</div>;
};

interface Props {
  inbox: InboxState;
  onOpenListing: (auctionId: string) => void;
  /** The deployment served, for links to an auction's reservation history. */
  deployment?: { chainId: number; contractAddress: string } | null;
  timeZoneOf?: (auctionId: string) => string | undefined;
}

/**
 * Bid, reservation, booking and funds entries for the signed-in wallet: confirmed on-chain events
 * merged with off-chain reservation entries, with per-wallet read, dismiss and category preferences.
 */
export const Inbox: React.FC<Props> = ({ inbox, onOpenListing, deployment, timeZoneOf }) => {
  const items = inbox.data?.items ?? [];
  const hidden = inbox.data?.preferences?.hidden ?? [];
  const unreadIds = items.filter((item) => !item.read).map((item) => item.id);
  const notice = inboxNotice(inbox);
  return (
    <section className="activity-section" aria-labelledby="inbox-title" data-testid="inbox">
      <div className="activity-section-header">
        <h2 id="inbox-title" className="activity-section-title">
          Inbox{inbox.data ? ` (${inbox.data.unread} unread)` : ''}
        </h2>
        {unreadIds.length > 0 && (
          <button type="button" className="btn-table-action" onClick={() => void inbox.markRead(unreadIds)}>
            Mark all read
          </button>
        )}
      </div>
      {notice && (
        <p className="activity-empty-text" role="status">
          {notice}
          {inbox.error && <> <button type="button" className="btn-table-action" onClick={() => void inbox.reload()}>Retry</button></>}
        </p>
      )}
      {inbox.data && items.length === 0 && (
        <div className="activity-empty-box">
          <div>
            <p className="activity-empty-heading">No notifications yet</p>
            <p className="activity-empty-text">
              Outbids, wins, reservations, booking changes, refunds and payouts for this wallet appear here.
              {hidden.length > 0 && ` ${hidden.length} ${hidden.length === 1 ? 'category is' : 'categories are'} hidden in your preferences.`}
            </p>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id} className={`inbox-item${item.read ? '' : ' is-unread'}`} data-inbox-kind={item.kind}>
              <span className="inbox-text">
                {!item.read && <span className="sr-only">Unread: </span>}
                {describe(item, item.auctionId ? timeZoneOf?.(item.auctionId) : undefined)}
              </span>
              <span className="inbox-actions">
                {item.auctionId && (
                  <button type="button" className="btn-table-action" onClick={() => onOpenListing(item.auctionId!)}>
                    {item.category === 'reservations' ? 'Arrival details' : 'View listing'}
                  </button>
                )}
                {item.auctionId && deployment && (item.category === 'bookings' || item.category === 'reservations') && (
                  <a className="btn-table-action" href={historyLink(deployment, item.auctionId)}>History</a>
                )}
                {!item.read && (
                  <button type="button" className="btn-table-action" onClick={() => void inbox.markRead([item.id])}>Mark read</button>
                )}
                <button type="button" className="btn-table-action" onClick={() => void inbox.dismiss([item.id])}>Dismiss</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {inbox.data && (
        <details className="inbox-preferences">
          <summary>Notification preferences</summary>
          <fieldset>
            <legend>Show in the inbox</legend>
            {CATEGORIES.map((category) => (
              <label key={category}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(category)}
                  onChange={(e) => void inbox.setHidden(e.target.checked ? hidden.filter((c) => c !== category) : [...hidden, category])}
                />
                {' '}{INBOX_CATEGORY_LABELS[category]}
              </label>
            ))}
          </fieldset>
          <p className="activity-empty-text">Shown in this app only. There are no email, SMS or push notifications.</p>
        </details>
      )}
    </section>
  );
};
