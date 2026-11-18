// Status of one remote read (configuration, listings, refund balance, wallet balance).
//   loading - nothing known yet, first read in flight
//   success - last read succeeded and returned data
//   empty   - last read succeeded and the source is genuinely empty
//   failed  - last read failed and no earlier value is retained
//   stale   - last read failed but the last successfully read value is retained
export type ReadStatus = 'loading' | 'success' | 'empty' | 'failed' | 'stale';

export interface ReadState {
  status: ReadStatus;
  lastSuccessAt: number | null;
  error: string | null;
}

export type ReadOutcome = 'ok' | 'failed' | 'skipped' | 'superseded';

export interface ReadResult {
  outcome: ReadOutcome;
  error?: string;
}

export const READ_OK: ReadResult = { outcome: 'ok' };
export const READ_SKIPPED: ReadResult = { outcome: 'skipped' };
export const READ_SUPERSEDED: ReadResult = { outcome: 'superseded' };

export const LOADING_READ: ReadState = { status: 'loading', lastSuccessAt: null, error: null };

export function readSucceeded(isEmpty = false, now = Date.now()): ReadState {
  return { status: isEmpty ? 'empty' : 'success', lastSuccessAt: now, error: null };
}

// A value is retained exactly when an earlier read succeeded, so that decides stale vs failed.
export function readFailed(prev: ReadState, error: unknown): ReadState {
  return {
    status: prev.lastSuccessAt !== null ? 'stale' : 'failed',
    lastSuccessAt: prev.lastSuccessAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function readFailure(error: unknown): ReadResult {
  return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
}

export function isUnhealthy(read: ReadState): boolean {
  return read.status === 'failed' || read.status === 'stale';
}

export function formatSyncTime(ts: number | null): string {
  return ts === null ? 'never' : new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
