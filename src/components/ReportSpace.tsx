import React, { useState } from 'react';
import { reportSpace } from '../services/workspace';

// Mirrors the reasons the API accepts for a report.
const REASONS = ['duplicate-listing', 'fraudulent-listing', 'not-space-controller'];

/** Lets a signed-in wallet flag a listing's space for moderators. */
export const ReportSpace: React.FC<{ spaceId: string; signedIn: boolean }> = ({ spaceId, signedIn }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  if (!signedIn) return <p className="auction-disclosure-subtext">Sign in to report this listing.</p>;
  async function submit() {
    try {
      await reportSpace(spaceId, reason, note.trim());
      setStatus('Report sent to moderators. Thank you.');
      setOpen(false);
      setNote('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <div className="report-space" data-testid="report-space">
      {!open && <button type="button" className="btn-table-action" onClick={() => { setStatus(null); setOpen(true); }}>Report listing</button>}
      {open && (
        <div className="verification-form">
          <label>Reason{' '}
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => <option key={r} value={r}>{r.replace(/-/g, ' ')}</option>)}
            </select>
          </label>
          <input aria-label="Report note" placeholder="Note (optional)" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn-table-action" onClick={() => void submit()}>Send report</button>
          <button type="button" className="btn-table-action" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
};
