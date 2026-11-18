import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { formatSyncTime, isUnhealthy, type ReadState } from '../utils/readState';

export interface ReadSource {
  key: 'config' | 'listings' | 'refund' | 'balance';
  label: string;
  read: ReadState;
  // Shown with the failure so users know what is blocked or unreliable.
  impact: string;
  onRetry: () => void;
}

interface ReadStatusBannerProps {
  sources: ReadSource[];
  isRetrying: boolean;
}

export const ReadStatusBanner: React.FC<ReadStatusBannerProps> = ({ sources, isRetrying }) => {
  const problems = sources.filter((s) => isUnhealthy(s.read));
  return (
    <section className="read-status" aria-label="Data status">
      {problems.map((source) => (
        <div key={source.key} className="read-status-row read-status-problem" role="alert" data-source={source.key}>
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="read-status-text">
            <strong>
              {source.label} {source.read.status === 'stale' ? 'may be out of date' : 'unavailable'}
            </strong>
            <span>
              {' '}
              {source.read.error}. {source.impact}
              {source.read.lastSuccessAt !== null && ` Last successful read: ${formatSyncTime(source.read.lastSuccessAt)}.`}
            </span>
          </div>
          <button type="button" className="read-status-retry" onClick={source.onRetry} disabled={isRetrying}>
            <RefreshCw size={14} aria-hidden="true" />
            <span>Retry {source.label.toLowerCase()}</span>
          </button>
        </div>
      ))}
      <p className="read-status-summary" data-testid="last-sync">
        Last successful read:{' '}
        {sources.map((s, i) => (
          <span key={s.key}>
            {i > 0 && ' · '}
            {s.label} {formatSyncTime(s.read.lastSuccessAt)}
          </span>
        ))}
      </p>
    </section>
  );
};
