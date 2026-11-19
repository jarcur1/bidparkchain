import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TxUpdate } from '../services/blockchain';

export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export interface AuditEntry {
  action: 'submit' | 'approve' | 'reject' | 'revoke' | 'report' | 'appeal';
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
  epoch: string | null;
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
  const [appeals, setAppeals] = useState<Record<string, string>>({});
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

  async function appeal(spaceId: string) {
    setBusy(spaceId);
    setMessage(null);
    try {
      await request(`/api/spaces/${spaceId}/appeal`, { note: appeals[spaceId] ?? '' });
      setAppeals((a) => ({ ...a, [spaceId]: '' }));
      await state.reload();
      setMessage(`Appeal sent to moderators for space #${spaceId}.`);
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
        Describe how you control the space (for example a lease, deed or utility bill). Only moderators can read this proof.
        On deployments that require verified inventory, approval is an off-chain decision until a verifier signs on-chain.
      </p>
      {(message || state.error) && <p className="activity-empty-text" role="status">{message ?? state.error}</p>}
      <ul className="inbox-list">
        {spaces.map((space) => {
          const v = state.verifications.find((x) => x.spaceId === space.id);
          const status = v?.status ?? 'unverified';
          const inputId = `verification-evidence-${space.id}`;
          return (
            <li key={space.id} className="inbox-item verification-item" data-space-id={space.id}>
              <span className="inbox-text">
                Space #{space.id} ({space.title}): <strong data-testid="verification-status">{status === 'approved' ? 'Review approved' : STATUS_TEXT[status]}</strong>
              </span>
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
              {(status === 'rejected' || status === 'suspended') && v?.audit.filter((e) => e.action !== 'report').at(-1)?.action !== 'appeal' && (
                <div className="verification-form">
                  <label htmlFor={`verification-appeal-${space.id}`}>Appeal note for the moderators</label>
                  <textarea
                    id={`verification-appeal-${space.id}`}
                    rows={2}
                    maxLength={500}
                    value={appeals[space.id] ?? ''}
                    onChange={(e) => setAppeals((a) => ({ ...a, [space.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn-table-action"
                    disabled={busy !== null || (appeals[space.id] ?? '').trim().length < 10}
                    onClick={() => void appeal(space.id)}
                  >
                    Send appeal
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

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const isZero = (h: string) => /^0x0*$/i.test(h);
const validHash = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h) && !isZero(h);
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface InventorySnapshot { owner: string; epoch: string; identity: string; metadataHash: string; canVerify: boolean }
type AttestDecision = { spaceId: string; owner: string; epoch: string; identity: string; metadataHash: string };

export interface ModerationPanelProps {
  readInventoryMode: () => Promise<boolean>;
  readInventory: (spaceId: string) => Promise<InventorySnapshot>;
  onAttest: (decision: AttestDecision, observe: (update: TxUpdate) => void) => Promise<void>;
  busy: boolean;
}

function progressText(update: TxUpdate): string {
  switch (update.status) {
    case 'awaiting-wallet': return 'Waiting for your wallet to sign. Nothing has been submitted yet.';
    case 'submitted': return `Transaction submitted${update.hash ? ` (${update.hash})` : ''}. Waiting for it to be mined.`;
    case 'confirming': return `Waiting for transaction confirmation${update.hash ? ` (${update.hash})` : ''}.`;
    case 'confirmed': return 'Transaction confirmed.';
    case 'rejected': return 'Signature rejected in the wallet. Nothing was submitted.';
    case 'reverted': case 'failed': return 'Transaction failed. No on-chain change was made by it.';
    case 'replaced': case 'cancelled':
      return `Transaction ${update.status}${update.replacementHash ? ` by ${update.replacementHash}` : ''}. Check the existing transaction, then refresh the on-chain status manually before retrying.`;
    default:
      return `Transaction outcome unknown${update.hash ? ` (${update.hash})` : ''}. Check the existing transaction, then refresh the on-chain status manually before retrying.`;
  }
}

/** Per-row, wallet-signed on-chain attestation. Hashes must not contain private evidence. */
const OnChainControls: React.FC<{
  item: QueueItem;
  readInventory: ModerationPanelProps['readInventory'];
  onAttest: ModerationPanelProps['onAttest'];
  busy: boolean;
}> = ({ item, readInventory, onAttest, busy }) => {
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [identityInput, setIdentityInput] = useState('');
  const [metadataInput, setMetadataInput] = useState('');
  const mounted = useRef(true);
  const readSeq = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    setReading(true);
    setError(null);
    try {
      const next = await readInventory(item.spaceId);
      if (!mounted.current || seq !== readSeq.current) return;
      setSnapshot(next);
    } catch (err) {
      if (!mounted.current || seq !== readSeq.current) return;
      setSnapshot(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current && seq === readSeq.current) setReading(false);
    }
  }, [readInventory, item.spaceId]);

  const hostMatches = !!snapshot && !!item.host && sameHex(snapshot.owner, item.host);
  const bound = !!snapshot && !isZero(snapshot.identity);
  const active = !!snapshot && !isZero(snapshot.metadataHash);
  const identity = snapshot && bound ? snapshot.identity : identityInput.trim();
  const metadataHash = metadataInput.trim();

  async function sign(decision: AttestDecision) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigning(true);
    setError(null);
    setProgress(progressText({ status: 'awaiting-wallet' }));
    try {
      await onAttest(decision, (update) => {
        // 'confirmed' is only shown after the attestation promise resolves.
        if (mounted.current && update.status !== 'confirmed') setProgress(progressText(update));
      });
      if (mounted.current) setProgress('Transaction confirmed. Refreshing on-chain status.');
      await refresh();
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
        setSnapshot(null);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSigning(false);
    }
  }

  const disabledBase = busy || signing || reading;
  let approve: { disabled: boolean; why: string | null } | null = null;
  let suspend: { disabled: boolean; why: string | null } | null = null;
  if (snapshot) {
    if (item.status === 'approved') {
      let why: string | null = null;
      if (!hostMatches) why = 'The on-chain owner is not the reviewed host; ownership changed since review.';
      else if (snapshot.epoch !== item.epoch) why = 'This review does not cover the current ownership period; ask the host for new proof.';
      else if (!snapshot.canVerify) why = 'This wallet cannot sign verification for this space.';
      else if (!validHash(identity)) why = 'Enter a nonzero 32-byte opaque stall key (0x + 64 hex characters).';
      else if (!validHash(metadataHash)) why = 'Enter a nonzero 32-byte reviewed listing metadata hash (0x + 64 hex characters).';
      else if (active && sameHex(snapshot.identity, identity) && sameHex(snapshot.metadataHash, metadataHash)) why = 'Identical to the current on-chain approval.';
      approve = { disabled: disabledBase || why !== null, why };
    } else if (active) {
      let why: string | null = null;
      if (!hostMatches) why = 'The on-chain owner is not the reviewed host; suspension is not available.';
      else if (!snapshot.canVerify) why = 'This wallet cannot sign verification for this space.';
      suspend = { disabled: disabledBase || why !== null, why };
    }
  }

  return (
    <div className="verification-form" data-testid={`onchain-${item.spaceId}`}>
      <button type="button" className="btn-table-action" disabled={disabledBase} onClick={() => void refresh()}>
        Check on-chain verification
      </button>
      {reading && <p className="activity-empty-text" role="status">Reading on-chain status...</p>}
      {snapshot && (
        <div role="status">
          <p className="activity-empty-text">
            On-chain: <strong>{active ? 'Verified on-chain' : 'Not verified on-chain'}</strong> - owner <code>{snapshot.owner}</code>, epoch {snapshot.epoch}
            {!hostMatches && ' (owner differs from reviewed host)'}
          </p>
          {active && (
            <p className="activity-empty-text">
              Current approval: stall key <code>{snapshot.identity}</code>, listing metadata hash <code>{snapshot.metadataHash}</code>
            </p>
          )}
        </div>
      )}
      {approve && (
        <>
          <label>
            Opaque stall key{' '}
            <input
              value={identity}
              readOnly={bound}
              placeholder="0x + 64 hex"
              onChange={(e) => setIdentityInput(e.target.value)}
            />
          </label>
          <label>
            Reviewed listing metadata hash{' '}
            <input value={metadataInput} placeholder="0x + 64 hex" onChange={(e) => setMetadataInput(e.target.value)} />
          </label>
          <p className="activity-empty-text">Use opaque hashes only; do not encode private evidence in them.</p>
          <button
            type="button"
            className="btn-table-action"
            disabled={approve.disabled}
            onClick={() => snapshot && void sign({ spaceId: item.spaceId, owner: snapshot.owner, epoch: snapshot.epoch, identity, metadataHash })}
          >
            Sign on-chain approval
          </button>
          {approve.why && <p className="activity-empty-text">{approve.why}</p>}
        </>
      )}
      {suspend && (
        <>
          <button
            type="button"
            className="btn-table-action"
            disabled={suspend.disabled}
            onClick={() => snapshot && void sign({ spaceId: item.spaceId, owner: snapshot.owner, epoch: snapshot.epoch, identity: ZERO_HASH, metadataHash: ZERO_HASH })}
          >
            Sign on-chain suspension
          </button>
          {suspend.why && <p className="activity-empty-text">{suspend.why}</p>}
        </>
      )}
      {progress && <p className="activity-empty-text" role="status">{progress}</p>}
      {error && <p className="activity-empty-text" role="alert">{error}</p>}
    </div>
  );
};

/** Moderator view: the review queue with evidence, reports and full history. */
export const ModerationPanel: React.FC<ModerationPanelProps> = ({ readInventoryMode, readInventory, onAttest, busy }) => {
  const [mode, setMode] = useState<'loading' | 'gated' | 'advisory' | 'unavailable'>('loading');
  useEffect(() => {
    let live = true;
    readInventoryMode().then(
      (required) => { if (live) setMode(required ? 'gated' : 'advisory'); },
      () => { if (live) setMode('unavailable'); },
    );
    return () => { live = false; };
  }, [readInventoryMode]);
  const gated = mode === 'gated';
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string[]>>({});
  const [choice, setChoice] = useState<Record<string, { reason?: string; note?: string }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState<{ total: number; nextOffset: number | null }>({ total: 0, nextOffset: null });
  const [saving, setSaving] = useState(false);
  const queueRead = useRef(0);
  // Loads the first page, or appends the page at `offset`; a decision reloads only what was already shown.
  const load = useCallback(async (offset = 0, limit = PAGE_SIZE) => {
    const seq = ++queueRead.current;
    try {
      const data = await request<{ queue: QueueItem[]; reasons: Record<string, string[]>; total: number; nextOffset: number | null }>(
        `/api/moderation/verifications?limit=${limit}&offset=${offset}`);
      if (seq !== queueRead.current) return;
      setQueue((q) => (offset === 0 ? data.queue : [...q, ...data.queue.filter((n) => !q.some((x) => x.spaceId === n.spaceId))]));
      setReasons(data.reasons);
      setPage({ total: data.total, nextOffset: data.nextOffset });
    } catch (err) {
      if (seq === queueRead.current) setMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function decide(spaceId: string, action: ModeratorAction) {
    if (busy || saving) return;
    ++queueRead.current;
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  }

  function needsSuspension(entries: AuditEntry[]): boolean {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].action === 'revoke') return true;
      if (entries[i].action === 'approve') return false;
    }
    return false;
  }

  const actionsFor = (status: QueueItem['status']): ModeratorAction[] =>
    status === 'pending' ? ['approve', 'reject'] : status === 'approved' ? ['revoke'] : [];

  return (
    <section className="activity-section" aria-labelledby="moderation-title" data-testid="moderation">
      <div className="activity-section-header">
        <h2 id="moderation-title" className="activity-section-title">Moderation queue</h2>
        <button type="button" className="btn-table-action" disabled={saving} onClick={() => void load(0, Math.max(PAGE_SIZE, queue.length))}>Refresh</button>
      </div>
      {message && <p className="activity-empty-text" role="status">{message}</p>}
      {mode === 'unavailable' && <p role="status">On-chain verification mode is unavailable. Review decisions do not send transactions.</p>}
      {gated && <p>Recording an off-chain decision does not change bidding. Check on-chain verification and sign the matching action separately.</p>}
      {queue.length === 0 && <p className="activity-empty-text">No verification requests or reports.</p>}
      <ul className="inbox-list">
        {queue.map((item) => (
          <li key={item.spaceId} className="inbox-item verification-item" data-space-id={item.spaceId}>
            <span className="inbox-text">
              {mode !== 'advisory' && 'Off-chain review: '}Space #{item.spaceId}: <strong>{mode !== 'advisory' && item.status === 'approved' ? 'Approved' : STATUS_TEXT[item.status]}</strong>
              {item.host && <> - host <code>{item.host}</code></>}
            </span>
            {item.evidence && <blockquote className="verification-evidence">{item.evidence}</blockquote>}
            {gated && (item.status === 'approved' || needsSuspension(item.audit)) && (
              <OnChainControls
                key={`${item.spaceId}:${item.host}:${item.status}`}
                item={item}
                readInventory={readInventory}
                onAttest={onAttest}
                busy={busy || saving}
              />
            )}
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
                  <button type="button" className="btn-table-action" disabled={busy || saving} onClick={() => void decide(item.spaceId, action)}>
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
