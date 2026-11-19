import React, { useCallback, useEffect, useState } from 'react';

export type InboxKind = 'outbid' | 'won' | 'refund' | 'payout' | 'booking-refund';
export interface InboxItem {
  id: string;
  kind: InboxKind;
  auctionId: string | null;
  title: string | null;
  amount: string | null;
  blockNumber: number;
  txHash: string;
  read: boolean;
}
export interface InboxIndex {
  indexedBlock: number | null;
  headBlock: number | null;
  lagBlocks: number | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
}
export interface InboxResponse {
  items: InboxItem[];
  unread: number;
  index: InboxIndex;
}
export interface InboxState {
  data: InboxResponse | null;
  /** Why the latest read failed; `data` then holds the last successful read, if any. */
  error: string | null;
  markRead: (ids: string[]) => Promise<void>;
  reload: () => Promise<void>;
}

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
  const markRead = useCallback((ids: string[]) => run(() => inboxRequest('/api/inbox/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  })), [run]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!account) return;
    void reload();
    const timer = setInterval(() => void reload(), pollMs);
    return () => clearInterval(timer);
  }, [account, pollMs, reload]);

  return { data, error, markRead, reload };
}

function describe(item: InboxItem): string {
  const spot = item.title ? `"${item.title}"` : `auction #${item.auctionId}`;
  switch (item.kind) {
    case 'outbid': return `You were outbid on ${spot}. Your ${item.amount} ETH bid was credited to your refund balance.`;
    case 'won': return `You won ${spot} with a ${item.amount} ETH bid.`;
    case 'refund': return `You withdrew ${item.amount} ETH of refunds to your wallet.`;
    case 'payout': return `You claimed the ${item.amount} ETH payout for ${spot}.`;
    case 'booking-refund': return `Your ${item.amount} ETH winning bid for ${spot} was credited to your refund balance.`;
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
  return null;
}

interface Props {
  inbox: InboxState;
  onOpenListing: (auctionId: string) => void;
}

/** Outbids, wins, refunds and payouts for the signed-in wallet, from confirmed on-chain events. */
export const Inbox: React.FC<Props> = ({ inbox, onOpenListing }) => {
  const items = inbox.data?.items ?? [];
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
            <p className="activity-empty-text">Outbids, wins, refunds and payouts for this wallet appear here once they are on-chain.</p>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="inbox-list">
          {items.map((item) => (
            <li key={item.id} className={`inbox-item${item.read ? '' : ' is-unread'}`} data-inbox-kind={item.kind}>
              <span className="inbox-text">
                {!item.read && <span className="sr-only">Unread: </span>}
                {describe(item)}
              </span>
              <span className="inbox-actions">
                {item.auctionId && (
                  <button type="button" className="btn-table-action" onClick={() => onOpenListing(item.auctionId!)}>View listing</button>
                )}
                {!item.read && (
                  <button type="button" className="btn-table-action" onClick={() => void inbox.markRead([item.id])}>Mark read</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
