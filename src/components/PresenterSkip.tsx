import { useState } from 'react';
import { skipChainTime, type SkipTarget } from '../services/api';

const CONTROLS: { target: SkipTarget; label: string }[] = [
  { target: 'bidding', label: 'Skip to bidding close' },
  { target: 'parking', label: 'Skip to parking end' },
];

/** Local demo only. App renders this just for the local build; the server serves its route only on the local chain. */
export function PresenterSkip({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const skip = async (target: SkipTarget) => {
    setBusy(true);
    setStatus('');
    try {
      const { advancedSeconds } = await skipChainTime(target);
      // Bid eligibility is judged against chain time, so the listings must reload before the result is shown.
      await onRefresh();
      setStatus(advancedSeconds > 0
        ? `Chain time moved forward ${Math.floor(advancedSeconds / 3600)}h ${Math.floor((advancedSeconds % 3600) / 60)}m.`
        : 'Nothing to skip: every deadline for that step has passed.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Skip failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="presenter-skip" aria-label="Local demo clock">
      {CONTROLS.map(({ target, label }) => (
        <button
          key={target}
          type="button"
          className="btn-presenter-skip"
          disabled={busy}
          onClick={() => void skip(target)}
        >
          {label}
        </button>
      ))}
      {status && <p className="presenter-skip-status" role="status">{status}</p>}
    </section>
  );
}
