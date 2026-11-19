import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, History, Link as LinkIcon, Loader2 } from 'lucide-react';
import type { Listing, UnindexedAuction } from '../types';
import { canExportIcs, downloadReservationIcs } from '../utils/calendar';
import { fetchAccountHistory, type AccountHistory } from '../services/api';
import { formatDateTime, formatEth, formatParkingWindow, shortenAddress } from '../utils/formatters';
import { buildHistoryRows, filterHistory, historyLink, pageOf, readHistoryLink, unregisteredListing } from '../utils/history';
import { LIFECYCLE_STATES, reservationLifecycle, zoneNote, type LifecycleState } from '../utils/lifecycle';
import { LOADING_READ, readFailed, readSucceeded, type ReadState } from '../utils/readState';

const POLL_MS = 10_000;
const EVENT_LABELS: Record<string, string> = {
  AuctionCreated: 'Listed', BidPlaced: 'Bid', AuctionSettled: 'Settled', PayoutClaimed: 'Payout claimed',
  AuctionCancelled: 'Cancelled', BookingRefunded: 'Winner refunded', LateCancellationRecorded: 'Late cancellation recorded',
  NoShowRecorded: 'No-show recorded', DisputeOpened: 'Seller-failure report opened', DisputeResolved: 'Report decided',
};

interface Props {
  currentAddress: string;
  listings: Listing[];
  /** On-chain auctions without registered details; they still get a state and a detail view. */
  unindexed?: UnindexedAuction[];
  myBidAuctionIds: Set<string> | null;
  nowSec: number;
  deployment: { chainId: number; contractAddress: string; snapshotBlock?: number | null; snapshotTime?: number } | null;
  onOpenListingDetail: (listing: Listing) => void;
}

/** Searchable, paginated bid and reservation history across auctions, including lost ones. */
export const ReservationHistory: React.FC<Props> = ({ currentAddress, listings, unindexed = [], myBidAuctionIds, nowSec, deployment, onOpenListingDetail }) => {
  const link = useMemo(() => readHistoryLink(window.location.search, deployment), [deployment]);
  const [history, setHistory] = useState<AccountHistory | null>(null);
  const [read, setRead] = useState<ReadState>(LOADING_READ);
  const [query, setQuery] = useState(typeof link === 'object' && link ? `#${link.auctionId}` : '');
  const [state, setState] = useState<LifecycleState | 'all'>('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    let active = true;
    setHistory(null);
    setRead(LOADING_READ);
    const load = () => fetchAccountHistory(currentAddress).then(
      (data) => {
        if (!active) return;
        setHistory(data);
        setRead(readSucceeded(data.events.length === 0));
      },
      (err) => active && setRead((prev) => readFailed(prev, err)),
    );
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [currentAddress]);

  // Events of another deployment are never mixed into this one's history.
  const sameDeployment = !history || !deployment ||
    (history.chainId === deployment.chainId && history.contractAddress.toLowerCase() === deployment.contractAddress.toLowerCase());
  const allListings = useMemo(() => [...listings, ...unindexed.map(unregisteredListing)], [listings, unindexed]);
  const rows = useMemo(
    () => buildHistoryRows(sameDeployment ? history?.events ?? [] : [], allListings, currentAddress, nowSec, myBidAuctionIds),
    [history, allListings, currentAddress, nowSec, myBidAuctionIds, sameDeployment],
  );
  const matches = filterHistory(rows, query, state);
  const shown = pageOf(matches, page);
  const behind = read.status === 'stale' || read.status === 'failed' || Boolean(history?.syncError) || history?.indexedBlock === null;
  const me = currentAddress.toLowerCase();

  return (
    <section className="activity-section" data-testid="reservation-history">
      <div className="activity-section-header">
        <div className="section-title-wrap">
          <History size={20} className="text-forest-green" />
          <h2 className="activity-section-title">Reservation &amp; Bid History{read.status === 'success' ? ` (${rows.length})` : ''}</h2>
        </div>
      </div>

      {link === 'mismatch' && (
        <div className="activity-empty-box" role="alert">
          <AlertTriangle size={22} />
          <div>
            <p className="activity-empty-heading">This link is for a different network or contract</p>
            <p className="activity-empty-text">It names another chain or escrow contract than the one this app is connected to, so it was not opened.</p>
          </div>
        </div>
      )}
      {read.status === 'loading' && (
        <div className="activity-empty-box" aria-busy="true">
          <Loader2 size={22} className="is-spinning" />
          <div><p className="activity-empty-heading">Loading history…</p></div>
        </div>
      )}
      {behind && read.status !== 'loading' && (
        <p className="bid-history-note" role="status">
          {history?.indexedBlock === null && read.status !== 'failed' && read.status !== 'stale'
            ? 'History has not been indexed yet.'
            : 'History may be out of date: the index could not be refreshed. Lifecycle states below come from the contract.'}
        </p>
      )}
      {!sameDeployment && <p className="bid-history-note" role="status">History belongs to a different deployment and is hidden.</p>}

      <div className="history-controls">
        <label>
          <span className="meta-sub">Search</span>
          <input
            type="search" value={query} placeholder="Title, address, #id or state"
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          />
        </label>
        <label>
          <span className="meta-sub">State</span>
          <select value={state} onChange={(e) => { setState(e.target.value as LifecycleState | 'all'); setPage(1); }}>
            <option value="all">All states</option>
            {LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{s.replace(/-/g, ' ')}</option>)}
          </select>
        </label>
      </div>

      {read.status !== 'loading' && rows.length === 0 ? (
        <div className="activity-empty-box">
          <History size={22} className="text-muted" />
          <div>
            <p className="activity-empty-heading">{behind ? 'No history to show yet' : 'No bids or reservations yet'}</p>
            <p className="activity-empty-text">Auctions you bid on, win or lose will be listed here.</p>
          </div>
        </div>
      ) : matches.length === 0 ? (
        <p className="bid-history-note">No history matches this search.</p>
      ) : (
        <ol className="history-list" aria-label="Bid and reservation history">
          {shown.items.map((row) => {
            const l = row.listing;
            const calendarLifecycle = l && deployment?.snapshotTime !== undefined
              ? reservationLifecycle(l, currentAddress, deployment.snapshotTime) : null;
            const win = l ? formatParkingWindow(l.parkingStart, l.parkingEnd, l.timeZone) : null;
            return (
              <li key={row.auctionId} className="history-row" id={`history-${row.auctionId}`}>
                <div className="history-row-head">
                  <strong>{l?.title ?? `Auction #${row.auctionId}`}</strong>
                  <span className="badge-status" data-state={row.lifecycle?.state}>{row.lifecycle?.label ?? 'State unavailable'}</span>
                </div>
                <p className="history-row-meta">
                  Auction #{row.auctionId}{l ? ` · ${l.address}` : ''}
                  {row.lastBid ? ` · your last bid ${formatEth(row.lastBid)} ETH` : ''}
                </p>
                {row.lifecycle && <p className="history-row-meta">{row.lifecycle.detail}</p>}
                {win && (
                  <p className="history-row-meta">
                    Window: {win.full}. {zoneNote(l?.timeZone)}
                  </p>
                )}
                <div className="history-row-actions">
                  {l && <button type="button" className="btn-table-action" onClick={() => onOpenListingDetail(l)}>View Details</button>}
                  {l && deployment && canExportIcs(calendarLifecycle, deployment.snapshotBlock) && (
                    <button type="button" className="btn-table-action" onClick={() => downloadReservationIcs(l, deployment, calendarLifecycle)}>
                      Add to calendar
                    </button>
                  )}
                  {deployment && (
                    <a className="btn-table-action" href={historyLink(deployment, row.auctionId)}>
                      <LinkIcon size={12} /> Link
                    </a>
                  )}
                </div>
                {row.events.length > 0 && (
                  <details>
                    <summary>{row.events.length} event{row.events.length === 1 ? '' : 's'}</summary>
                    <ol className="bid-history-list">
                      {row.events.map((e) => (
                        <li key={`${e.blockNumber}-${e.logIndex}`} className="bid-history-row">
                          <span className="bid-history-event">{EVENT_LABELS[e.event] ?? e.event}</span>
                          <span className="mono-val" title={e.account ?? undefined}>
                            {e.account ? shortenAddress(e.account, 4) : ''}{e.account?.toLowerCase() === me ? ' (you)' : ''}
                          </span>
                          <span>{e.amount !== null && e.event !== 'AuctionCreated' ? `${formatEth(e.amount)} ETH` : ''}</span>
                          <span className="bid-history-block">
                            {e.blockTime ? formatDateTime(e.blockTime, l?.timeZone) : `block ${e.blockNumber}`}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {shown.pages > 1 && (
        <nav className="history-pager" aria-label="History pages">
          <button type="button" className="btn-table-action" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}>Previous</button>
          <span>Page {shown.page} of {shown.pages}</span>
          <button type="button" className="btn-table-action" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
};
