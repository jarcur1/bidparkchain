import React, { useCallback, useEffect, useState } from 'react';
import type { BookingAction } from '../utils/booking';

/** Actions whose on-chain call carries the reference of a stored review record. */
export const REVIEW_ACTIONS: BookingAction[] = ['reportSellerFailure', 'upholdDispute', 'denyDispute'];
export const MIN_REVIEW_TEXT = 10;

interface ReviewRecord {
  id: number;
  kind: 'report' | 'decision';
  author: string;
  uphold: boolean | null;
  body: string;
  reference: string;
  createdAt: number;
}
interface DisputeView {
  open: boolean;
  openReference: string | null;
  records: ReviewRecord[];
  audit: { actor: string; action: string; at: number }[];
}
export interface QueueEntry {
  auctionId: string;
  title: string | null;
  reporter: string;
  parkingEnd: number;
  resolveBy: number;
  hasRecord: boolean;
  isParty: boolean;
  action: 'resolveDispute' | 'expireDispute';
}

async function call<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`), { status: res.status });
  return data as T;
}

/**
 * Stores the evidence or decision reason server-side and returns the opaque reference the on-chain
 * call carries. The text itself never goes on-chain.
 */
export async function submitReview(auctionId: string, action: BookingAction, text: string): Promise<string> {
  const route = `/api/auctions/${auctionId}/dispute/${action === 'reportSellerFailure' ? 'evidence' : 'decision'}`;
  const body = action === 'reportSellerFailure' ? { text } : { uphold: action === 'upholdDispute', reason: text };
  return (await call<{ reference: string }>(route, body)).reference;
}

const when = (ms: number) => new Date(ms).toLocaleString();

/** The review record of one booking; only its parties and resolvers can read it, anyone else sees nothing. */
export const DisputeRecord: React.FC<{ auctionId: string; refreshKey?: unknown }> = ({ auctionId, refreshKey }) => {
  const [view, setView] = useState<DisputeView | null>(null);
  useEffect(() => {
    let live = true;
    call<DisputeView>(`/api/auctions/${auctionId}/dispute`).then((v) => { if (live) setView(v); }).catch(() => { if (live) setView(null); });
    return () => { live = false; };
  }, [auctionId, refreshKey]);
  if (!view || view.records.length === 0) return null;
  return (
    <div data-testid="dispute-record" className="verification-history">
      <p className="owner-notice">Review record (visible to the winner, the host and resolvers only; the chain holds only its hash).</p>
      <ol>
        {view.records.map((r) => (
          <li key={r.id}>
            {when(r.createdAt)}: {r.kind === 'report' ? 'Report' : r.uphold ? 'Decision: upheld' : 'Decision: denied'}
            {r.reference === view.openReference && ' (open report)'} by <code>{r.author}</code>
            <blockquote className="verification-evidence">{r.body}</blockquote>
          </li>
        ))}
      </ol>
    </div>
  );
};

/** Resolver view: open seller-failure reports with their deadlines. Not shown to wallets that are not resolvers. */
export const ResolverQueue: React.FC<{
  refreshKey?: unknown;
  nowSec: number;
  busy: boolean;
  onAct: (auctionId: string, action: BookingAction, text: string) => Promise<void>;
}> = ({ refreshKey, nowSec, busy, onAct }) => {
  const [items, setItems] = useState<QueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await call<{ items: QueueEntry[] }>('/api/disputes/queue')).items);
      setError(null);
    } catch (err) {
      setItems(null);
      setError((err as { status?: number }).status === 403 ? null : err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (!items) return error ? <p className="activity-empty-text" role="alert">{error}</p> : null;

  return (
    <section className="activity-section" aria-labelledby="resolver-queue-title" data-testid="resolver-queue">
      <div className="activity-section-header">
        <h2 id="resolver-queue-title" className="activity-section-title">Resolver queue</h2>
        <button type="button" className="btn-table-action" onClick={() => void load()}>Refresh</button>
      </div>
      {items.length === 0 && <p className="activity-empty-text">No open seller-failure reports.</p>}
      <ul className="inbox-list">
        {items.map((item) => {
          const reason = reasons[item.auctionId] ?? '';
          const expired = item.action === 'expireDispute';
          const left = Math.max(0, Math.round((item.resolveBy - nowSec) / 3600));
          return (
            <li key={item.auctionId} className="inbox-item verification-item" data-auction-id={item.auctionId}>
              <span className="inbox-text">
                Auction #{item.auctionId}{item.title ? ` (${item.title})` : ''}: reported by <code>{item.reporter}</code>.{' '}
                {expired
                  ? 'The resolution window has ended: anyone can expire the report and refund the winner.'
                  : `Decide by ${when(item.resolveBy * 1000)} (about ${left} h left); otherwise the winner is refunded in full.`}
                {!item.hasRecord && ' No review record is linked to this report.'}
              </span>
              <button type="button" className="btn-table-action" onClick={() => setOpen(open === item.auctionId ? null : item.auctionId)}>
                {open === item.auctionId ? 'Hide record' : 'Read record'}
              </button>
              {open === item.auctionId && <DisputeRecord auctionId={item.auctionId} refreshKey={refreshKey} />}
              {expired ? (
                <button type="button" className="btn-table-action" disabled={busy} onClick={() => void onAct(item.auctionId, 'expireDispute', '')}>
                  Expire report and refund winner
                </button>
              ) : item.isParty ? (
                <p className="activity-empty-text">You are a party to this booking, so another resolver must decide.</p>
              ) : (
                <div className="verification-form">
                  <input
                    aria-label={`Decision reason for auction ${item.auctionId}`}
                    placeholder="Reason (stored off-chain, at least 10 characters)"
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReasons((r) => ({ ...r, [item.auctionId]: e.target.value }))}
                  />
                  {(['upholdDispute', 'denyDispute'] as const).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="btn-table-action"
                      disabled={busy || reason.trim().length < MIN_REVIEW_TEXT}
                      onClick={() => void onAct(item.auctionId, action, reason.trim())}
                    >
                      {action === 'upholdDispute' ? 'Uphold report (refund winner)' : 'Deny report'}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
