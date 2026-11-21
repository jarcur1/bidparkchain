import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface SearchFailureNoticeProps {
  error: string | null;
  onRetry: () => void;
}

// The marketplace filters the loaded listings locally while server search is unavailable.
// Non-blocking: the results stay usable, and retry re-runs the search.
// The live region stays mounted so a failure is announced when its text appears.
export const SearchFailureNotice: React.FC<SearchFailureNoticeProps> = ({ error, onRetry }) => (
  <div role="status">
    {error !== null && (
      <div className="read-status-row search-failure-notice">
        <AlertTriangle size={16} aria-hidden="true" />
        <div className="read-status-text">
          <strong>Server search unavailable</strong>
          <span> {error}. Results are filtered locally from the last loaded listings and may differ from a server search.</span>
        </div>
        <button type="button" className="read-status-retry" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          <span>Retry search</span>
        </button>
      </div>
    )}
  </div>
);
