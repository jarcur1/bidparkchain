/// <reference types="vite/client" />

interface Window {
  ethereum?: {
    isMetaMask?: boolean;
    request: (request: { method: string; params?: readonly unknown[] | Record<string, unknown> }) => Promise<unknown>;
    on: (eventName: string, handler: (...args: readonly unknown[]) => void) => void;
    removeListener: (eventName: string, handler: (...args: readonly unknown[]) => void) => void;
  };
}
