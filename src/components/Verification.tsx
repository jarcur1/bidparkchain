import React, { useCallback, useEffect, useState } from 'react';

export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export interface AuditEntry {
  action: 'submit' | 'approve' | 'reject' | 'revoke' | 'report';
  status: string;
  actor: string;
  reason: string;
  note: string;
  at: number;
}
export interface HostVerification {
  spaceId: string;
  status: VerificationStatus;
  updatedAt: number;
  audit: AuditEntry[];
}
interface QueueItem {
  spaceId: string;
  host: string | null;
  status: VerificationStatus | 'unverified';
  evidence: string;
  audit: AuditEntry[];
}
const PAGE_SIZE = 25;
type ModeratorAction = 'approve' | 'reject' | 'revoke';

async function request<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`);
  return data as T;
}

export interface VerificationState {
  moderator: boolean;
  verifications: HostVerification[];
  error: string | null;
  reload: () => Promise<void>;
}

/** The signed-in wallet's verification requests, and whether it is a moderator. Cleared on account change. */
export function useVerifications(account: string | null): VerificationState {
  const [data, setData] = useState<{ moderator: boolean; verifications: HostVerification[] }>({ moderator: false, verifications: [] });
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await request('/api/verifications/mine'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    setData({ moderator: false, verifications: [] });
    setError(null);
    if (account) void reload();
  }, [account, reload]);
  return { ...data, error, reload };
}

export const STATUS_TEXT: Record<VerificationStatus | 'unverified', string> = {
  unverified: 'Not verified',
  pending: 'Pending review',
  approved: 'Verified',
  rejected: 'Rejected',
  suspended: 'Suspended',
};
const when = (at: number) => new Date(at).toLocaleString();
const History: React.FC<{ audit: AuditEntry[]; showActor?: boolean }> = ({ audit, showActor }) => (
  <ol className="verification-history">
    {audit.map((entry, i) => (
      <li key={i}>
        {when(entry.at)}: {entry.action} ({entry.reason}){entry.note && ` - ${entry.note}`}
        {showActor && <> by <code>{entry.actor}</code></>}
      </li>
    ))}
  </ol>
);

/**
 * Host view: request verification for each owned space and follow its status. Evidence is sent once
 * and only moderators can read it back.
 */
export const HostVerificationPanel: React.FC<{ spaces: { id: string; title: string }[]; state: VerificationState }> = ({ spaces, state }) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (spaces.length === 0) return null;

  async function submit(spaceId: string) {
    setBusy(spaceId);
    setMessage(null);
    try {
      await request(`/api/spaces/${spaceId}/verification`, { evidence: drafts[spaceId] ?? '' });
      setDrafts((d) => ({ ...d, [spaceId]: '' }));
      await state.reload();
      setMessage(`Verification requested for space #${spaceId}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="activity-section" aria-labelledby="verification-title" data-testid="host-verification">
      <div className="activity-section-header">
        <h2 id="verification-title" className="activity-section-title">Space verification</h2>
      </div>
      <p className="activity-empty-text">
        A moderator checks that you control each space before it shows as verified. Describe your proof (for example a
        lease, deed or utility bill for the address). Only moderators can read it; it never appears on a listing.
      </p>
      {(message || state.error) && <p className="activity-empty-text" role="status">{message ?? state.error}</p>}
      <ul className="inbox-list">
        {spaces.map((space) => {
          const v = state.verifications.find((x) => x.spaceId === space.id);
          const status = v?.status ?? 'unverified';
          const canRequest = status !== 'pending' && status !== 'approved';
          const inputId = `verification-evidence-${space.id}`;
          return (
            <li key={space.id} className="inbox-item verification-item" data-space-id={space.id}>
              <span className="inbox-text">
                Space #{space.id} ({space.title}): <strong data-testid="verification-status">{STATUS_TEXT[status]}</strong>
              </span>
              {canRequest && (
                <div className="verification-form">
                  <label htmlFor={inputId}>{status === 'unverified' ? 'Proof of control' : 'New proof for re-review'}</label>
                  <textarea
                    id={inputId}
                    rows={2}
                    maxLength={2000}
                    value={drafts[space.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [space.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn-table-action"
                    disabled={busy !== null || (drafts[space.id] ?? '').trim().length < 10}
                    onClick={() => void submit(space.id)}
                  >
                    Request verification
                  </button>
                </div>
              )}
              {v && v.audit.length > 0 && <History audit={v.audit} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** Moderator view: the review queue with evidence, reports and full history. */
export const ModerationPanel: React.FC = () => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string[]>>({});
  const [choice, setChoice] = useState<Record<string, { reason?: string; note?: string }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState<{ total: number; nextOffset: number | null }>({ total: 0, nextOffset: null });
  // Loads the first page, or appends the page at `offset`; a decision reloads only what was already shown.
  const load = useCallback(async (offset = 0, limit = PAGE_SIZE) => {
    try {
      const data = await request<{ queue: QueueItem[]; reasons: Record<string, string[]>; total: number; nextOffset: number | null }>(
        `/api/moderation/verifications?limit=${limit}&offset=${offset}`);
      setQueue((q) => (offset === 0 ? data.queue : [...q, ...data.queue.filter((n) => !q.some((x) => x.spaceId === n.spaceId))]));
      setReasons(data.reasons);
      setPage({ total: data.total, nextOffset: data.nextOffset });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(spaceId: string, action: ModeratorAction) {
    const picked = choice[`${spaceId}:${action}`] ?? {};
    setMessage(null);
    try {
      await request(`/api/moderation/verifications/${spaceId}`, {
        action, reason: picked.reason ?? reasons[action]?.[0], note: picked.note ?? '',
      });
      setMessage(`Space #${spaceId}: ${action} recorded.`);
      await load(0, Math.max(PAGE_SIZE, queue.length));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const actionsFor = (status: QueueItem['status']): ModeratorAction[] =>
    status === 'pending' ? ['approve', 'reject'] : status === 'approved' ? ['revoke'] : [];

  return (
    <section className="activity-section" aria-labelledby="moderation-title" data-testid="moderation">
      <div className="activity-section-header">
        <h2 id="moderation-title" className="activity-section-title">Moderation queue</h2>
        <button type="button" className="btn-table-action" onClick={() => void load(0, Math.max(PAGE_SIZE, queue.length))}>Refresh</button>
      </div>
      {message && <p className="activity-empty-text" role="status">{message}</p>}
      {queue.length === 0 && <p className="activity-empty-text">No verification requests or reports.</p>}
      <ul className="inbox-list">
        {queue.map((item) => (
          <li key={item.spaceId} className="inbox-item verification-item" data-space-id={item.spaceId}>
            <span className="inbox-text">
              Space #{item.spaceId}: <strong>{STATUS_TEXT[item.status]}</strong>
              {item.host && <> - host <code>{item.host}</code></>}
            </span>
            {item.evidence && <blockquote className="verification-evidence">{item.evidence}</blockquote>}
            {actionsFor(item.status).map((action) => {
              const key = `${item.spaceId}:${action}`;
              return (
                <div key={action} className="verification-form">
                  <label>
                    {action} reason{' '}
                    <select
                      value={choice[key]?.reason ?? reasons[action]?.[0] ?? ''}
                      onChange={(e) => setChoice((c) => ({ ...c, [key]: { ...c[key], reason: e.target.value } }))}
                    >
                      {(reasons[action] ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </label>
                  <input
                    aria-label={`${action} note for space ${item.spaceId}`}
                    placeholder="Note (optional)"
                    maxLength={280}
                    value={choice[key]?.note ?? ''}
                    onChange={(e) => setChoice((c) => ({ ...c, [key]: { ...c[key], note: e.target.value } }))}
                  />
                  <button type="button" className="btn-table-action" onClick={() => void decide(item.spaceId, action)}>
                    {action.charAt(0).toUpperCase() + action.slice(1)}
                  </button>
                </div>
              );
            })}
            <History audit={item.audit} showActor />
          </li>
        ))}
      </ul>
      {queue.length > 0 && <p className="activity-empty-text" data-testid="moderation-count">Showing {queue.length} of {page.total}.</p>}
      {page.nextOffset !== null && (
        <button type="button" className="btn-table-action" onClick={() => void load(page.nextOffset ?? 0)}>Load more</button>
      )}
    </section>
  );
};
