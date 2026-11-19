import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Signer } from 'ethers';
import { useWallet } from './WalletContext';
import { fetchSession, requestSignIn, signOutSession, verifySignIn, type Session } from '../services/auth';

export interface SessionContextValue {
  /** The signed-in session for the connected account and network, or null. */
  session: Session | null;
  isSigningIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SIGNED_OUT: SessionContextValue = {
  session: null, isSigningIn: false, error: null, signIn: async () => {}, signOut: async () => {},
};
const SessionContext = createContext<SessionContextValue | null>(null);

function isRejection(error: unknown): boolean {
  const e = error as { code?: unknown; info?: { error?: { code?: unknown } } } | null;
  return e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001;
}

/**
 * Wallet sign-in (EIP-4361). A session only counts while the same account on the same network stays
 * connected; switching either signs the app out. Signing in never moves funds and does not prove
 * control of any parking space.
 */
export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { walletState, signer } = useWallet();
  const [stored, setStored] = useState<Session | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    fetchSession().then(setStored, () => setStored(null));
  }, []);

  // Re-render when the session expires so it is never shown past its expiry.
  useEffect(() => {
    if (!stored) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, stored.expiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [stored]);

  const matchesWallet = (s: Session) =>
    walletState.address !== null && s.address.toLowerCase() === walletState.address.toLowerCase() &&
    s.chainId === walletState.chainId;

  // A session for a different account or network is ended on the server, not just hidden.
  useEffect(() => {
    // No address yet (page load, reconnecting) only hides the session; it is not revoked.
    if (!stored || !walletState.address || walletState.isConnecting || matchesWallet(stored)) return;
    setStored(null);
    setError('Signed out because the wallet account or network changed.');
    void signOutSession().catch(() => {});
  }, [stored, walletState.address, walletState.chainId, walletState.isConnecting]);

  const signIn = useCallback(async () => {
    const address = walletState.address;
    if (!address || !walletState.isReady || !signer || !('signMessage' in signer)) {
      setError('Connect a wallet on the supported network before signing in.');
      return;
    }
    setIsSigningIn(true);
    setError(null);
    try {
      const { nonce, message } = await requestSignIn(address);
      const signature = await (signer as Signer).signMessage(message);
      setStored(await verifySignIn(nonce, signature));
    } catch (err) {
      setError(isRejection(err)
        ? 'Signature request was rejected. You are not signed in.'
        : err instanceof Error ? err.message : String(err));
    } finally {
      setIsSigningIn(false);
    }
  }, [signer, walletState.address, walletState.isReady]);

  const signOut = useCallback(async () => {
    setStored(null);
    setError(null);
    await signOutSession().catch(() => {});
  }, []);

  const session = stored && stored.expiresAt > now && matchesWallet(stored) ? stored : null;
  return (
    <SessionContext.Provider value={{ session, isSigningIn, error, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
};

/** Session state; outside a SessionProvider (isolated component tests) it is always signed out. */
export function useSession(): SessionContextValue {
  return useContext(SessionContext) ?? SIGNED_OUT;
}
