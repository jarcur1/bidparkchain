import React from 'react';
import type { TxStatus } from '../services/blockchain';
import type { TxRecord } from '../utils/txStore';

const STATUS_TEXT: Record<TxStatus, string> = {
  'awaiting-wallet': 'Waiting for wallet approval',
  submitted: 'Submitted',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  rejected: 'Rejected in wallet',
  failed: 'Failed before sending',
  reverted: 'Reverted on-chain',
  replaced: 'Replaced by another transaction',
  cancelled: 'Cancelled in wallet',
  unknown: 'Outcome unknown, check the transaction',
};

interface Props {
  records: TxRecord[];
  staleCount: number;
  explorerUrl?: string | null;
  onCompleteRegistration: (record: TxRecord) => void;
  isActionBusy: boolean;
}

/** Persisted history of this account's transactions on the current deployment. */
export const TransactionCenter: React.FC<Props> = ({ records, staleCount, explorerUrl, onCompleteRegistration, isActionBusy }) => {
  const link = (hash: string) => explorerUrl
    ? <a href={`${explorerUrl.replace(/\/$/, '')}/tx/${hash}`} target="_blank" rel="noreferrer"><code>{hash.slice(0, 10)}…</code></a>
    : <code title={hash}>{hash.slice(0, 10)}…</code>;
  return (
    <section className="activity-section" aria-labelledby="tx-center-title">
      <div className="activity-section-header">
        <h2 id="tx-center-title" className="activity-section-title">Transactions ({records.length})</h2>
      </div>
      {records.length === 0 ? (
        <div className="activity-empty-box">
          <div>
            <p className="activity-empty-heading">No transactions from this account yet</p>
            <p className="activity-empty-text">Bids, listings, refunds and settlements you send appear here and survive a page reload.</p>
          </div>
        </div>
      ) : (
        <div className="active-bids-table-wrap">
          <table className="activity-table">
            <thead>
              <tr><th>Action</th><th>Status</th><th>Transaction</th><th>Next step</th></tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const needsRegistration = r.kind === 'create' && r.status === 'confirmed' && r.auctionId && !r.registered;
                return (
                  <tr key={r.id} data-tx-status={r.status}>
                    <td>{r.label}</td>
                    <td>
                      {STATUS_TEXT[r.status]}
                      {r.replacementHash && <> (by {link(r.replacementHash)})</>}
                    </td>
                    <td>{r.hash ? link(r.hash) : 'Not sent'}</td>
                    <td>
                      {needsRegistration ? (
                        <button type="button" className="btn-table-action" disabled={isActionBusy} onClick={() => onCompleteRegistration(r)}>
                          Complete registration
                        </button>
                      ) : r.kind === 'create' && r.registered ? 'Listing registered' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {staleCount > 0 && (
        <p className="activity-empty-text">
          {staleCount} earlier transaction{staleCount === 1 ? '' : 's'} belong to a previous deployment of this chain (it was reset)
          and can't be resumed.
        </p>
      )}
    </section>
  );
};
