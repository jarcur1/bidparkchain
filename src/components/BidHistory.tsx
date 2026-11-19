import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import type { Listing } from '../types';
import { fetchAuctionHistory, type AuctionHistory } from '../services/api';
import { formatEth, shortenAddress } from '../utils/formatters';
import { LOADING_READ, readFailed, readSucceeded, type ReadState } from '../utils/readState';

const POLL_MS = 5000;

const LABELS: Record<string, string> = {
  AuctionCreated: 'Listed',
  BidPlaced: 'Bid',
  AuctionSettled: 'Settled',
  PayoutClaimed: 'Payout claimed',
  AuctionCancelled: 'Cancelled',
  BookingRefunded: 'Winner refunded',
  LateCancellationRecorded: 'Late cancellation recorded',
  NoShowRecorded: 'No-show recorded by host',
  DisputeOpened: 'Seller-failure report opened',
  DisputeResolved: 'Report decided',
};

/** Canonical indexed event history for one auction; says when it is unavailable, stale or behind. */
export const BidHistory: React.FC<{ listing: Listing; currentAddress: string | null }> = ({ listing, currentAddress }) => {
  const [history, setHistory] = useState<AuctionHistory | null>(null);
  const [read, setRead] = useState<ReadState>(LOADING_READ);

  useEffect(() => {
    let active = true;
    setHistory(null);
    setRead(LOADING_READ);
    const load = () =>
      fetchAuctionHistory(listing.id).then(
        (data) => {
          if (!active) return;
          setHistory(data);
          setRead(readSucceeded(data.events.length === 0));
        },
        (err) => active && setRead((prev) => readFailed(prev, err)),
      );
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [listing.id]);

  const me = currentAddress?.toLowerCase();
  const bids = history?.events.filter((e) => e.event === 'BidPlaced') ?? [];
  const hasBids = parseFloat(listing.highestBid) > 0;
  const lastBid = bids[bids.length - 1];
  let notice: string | null = null;
  if (read.status === 'stale' || history?.syncError) {
    notice = 'History may be out of date: the latest refresh failed.';
  } else if (history && history.indexedBlock === null) {
    notice = 'History has not been indexed yet.';
  } else if (history && (hasBids !== Boolean(lastBid) || (lastBid && parseFloat(lastBid.amount ?? '0') !== parseFloat(listing.highestBid)))) {
    notice = 'History is catching up with the latest on-chain state.';
  }

  return (
    <div className="modal-section bid-history" data-testid="bid-history" aria-busy={read.status === 'loading'}>
      <h4 className="section-label">
        <History size={14} /> Bid History
      </h4>
      {read.status === 'loading' && <p className="bid-history-note">Loading history…</p>}
      {read.status === 'failed' && (
        <p className="bid-history-note" role="status">Bid history is unavailable right now.</p>
      )}
      {notice && <p className="bid-history-note" role="status">{notice}</p>}
      {history && history.indexedBlock !== null && bids.length === 0 && !notice && (
        <p className="bid-history-note">No bids yet.</p>
      )}
      {history && history.events.length > 0 && (
        <ol className="bid-history-list">
          {history.events.map((e) => (
            <li key={`${e.blockNumber}-${e.logIndex}`} className="bid-history-row">
              <span className="bid-history-event">{LABELS[e.event] ?? e.event}</span>
              <span className="mono-val" title={e.account ?? undefined}>
                {e.account ? shortenAddress(e.account, 4) : ''}
                {e.account && e.account.toLowerCase() === me ? ' (you)' : ''}
              </span>
              <span>{e.amount !== null && e.event !== 'AuctionCreated' ? `${formatEth(e.amount)} ETH` : ''}</span>
              <span className="bid-history-block">block {e.blockNumber}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
