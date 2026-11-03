import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { ToastMessage } from '../types';
import { shortenAddress } from '../utils/formatters';

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  useEffect(() => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1];
    const timer = setTimeout(() => {
      onDismiss(latest.id);
    }, 6000);
    return () => clearTimeout(timer);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.map((toast) => {
        const isSuccess = toast.type === 'success';
        const isError = toast.type === 'error';

        return (
          <div
            key={toast.id}
            className={`toast-item toast-${toast.type}`}
            role="status"
          >
            <div className="toast-icon-col">
              {isSuccess && <CheckCircle2 size={18} className="toast-icon success" />}
              {isError && <AlertCircle size={18} className="toast-icon error" />}
              {!isSuccess && !isError && <Info size={18} className="toast-icon info" />}
            </div>

            <div className="toast-content-col">
              <strong className="toast-title">{toast.title}</strong>
              {toast.message && <p className="toast-desc">{toast.message}</p>}
              {toast.txHash && (
                <div className="toast-tx-hash">
                  <span>Tx Hash:</span>
                  <code>{shortenAddress(toast.txHash, 8)}</code>
                </div>
              )}
            </div>

            <button
              type="button"
              className="toast-close-btn"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss toast"
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
