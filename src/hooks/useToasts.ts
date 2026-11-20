import { useCallback, useState } from 'react';
import type { ToastMessage } from '../types';

export type AddToast = (type: 'success' | 'error' | 'info', title: string, message?: string, txHash?: string) => void;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const addToast = useCallback(
    (type: 'success' | 'error' | 'info', title: string, message?: string, txHash?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, type, title, message, txHash }]);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
