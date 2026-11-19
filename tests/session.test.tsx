import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';

const alice = new Wallet('0x' + '11'.repeat(32));
const bob = new Wallet('0x' + '22'.repeat(32));
const wallet = {
  walletState: { address: alice.address as string | null, chainId: 31337, isReady: true, isConnecting: false },
  signer: alice as unknown,
  wrongChain: false,
  balanceRead: { status: 'success', lastSuccessAt: 0, error: null },
};
vi.mock('../src/context/WalletContext', () => ({ useWallet: () => wallet }));

import { SessionProvider, useSession, type SessionContextValue } from '../src/context/SessionContext';
import { WalletModal } from '../src/components/WalletModal';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let server: { session: { address: string; chainId: number; expiresAt: number } | null; calls: string[] };
let current: SessionContextValue;
let root: Root;
let host: HTMLDivElement;
const Probe = () => { current = useSession(); return null; };
const render = () => act(() => root.render(<SessionProvider><Probe /></SessionProvider>));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  server = { session: null, calls: [] };
  wallet.walletState = { address: alice.address, chainId: 31337, isReady: true, isConnecting: false };
  wallet.signer = alice;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    server.calls.push(input);
    if (input === '/api/auth/session') return server.session ? Response.json(server.session) : Response.json({ error: 'Not signed in' }, { status: 401 });
    if (input === '/api/auth/nonce') return Response.json({ nonce: 'n1', message: 'Sign in to BidPark', expiresAt: Date.now() + 60_000 });
    if (input === '/api/auth/verify') {
      const { signature } = JSON.parse(String(init?.body));
      if (signature !== await alice.signMessage('Sign in to BidPark')) return Response.json({ error: 'The signature does not match the wallet address.' }, { status: 401 });
      server.session = { address: alice.address, chainId: 31337, expiresAt: Date.now() + 60_000 };
      return Response.json(server.session);
    }
    if (input === '/api/auth/logout') { server.session = null; return Response.json({ signedOut: true }); }
    throw new Error(`Unexpected fetch ${input}`);
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('signs in by signing the server-issued message, and signs out on the server', async () => {
  render(); await settle();
  expect(current.session).toBeNull();
  await act(() => current.signIn());
  expect(current.session?.address).toBe(alice.address);
  await act(() => current.signOut());
  expect(current.session).toBeNull();
  expect(server.calls).toContain('/api/auth/logout');
});

it('reports a rejected signature request and stays signed out', async () => {
  wallet.signer = { signMessage: async () => { throw Object.assign(new Error('user rejected'), { code: 'ACTION_REJECTED' }); } };
  render(); await settle();
  await act(() => current.signIn());
  expect(current.session).toBeNull();
  expect(current.error).toBe('Signature request was rejected. You are not signed in.');
  expect(server.calls).not.toContain('/api/auth/verify');
});

it('keeps a session through a reload, but revokes it when another account connects', async () => {
  server.session = { address: alice.address, chainId: 31337, expiresAt: Date.now() + 60_000 };
  wallet.walletState = { address: null, chainId: null as unknown as number, isReady: false, isConnecting: false };
  render(); await settle();
  expect(current.session).toBeNull();
  expect(server.calls).not.toContain('/api/auth/logout');

  wallet.walletState = { address: alice.address, chainId: 31337, isReady: true, isConnecting: false };
  render(); await settle();
  expect(current.session?.address).toBe(alice.address);

  wallet.walletState = { address: bob.address, chainId: 31337, isReady: true, isConnecting: false };
  render(); await settle();
  expect(current.session).toBeNull();
  expect(current.error).toBe('Signed out because the wallet account or network changed.');
  expect(server.calls).toContain('/api/auth/logout');
});

it('stops presenting a session once it expires', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
  try {
    server.session = { address: alice.address, chainId: 31337, expiresAt: Date.now() + 1_000 };
    render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(current.session?.address).toBe(alice.address);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(current.session).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('signs in and out from the wallet dialog, explaining what signing proves', async () => {
  act(() => root.render(<SessionProvider><WalletModal isOpen onClose={() => {}} /></SessionProvider>));
  await settle();
  const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
  expect(document.body.textContent).toContain('does not verify that you control any parking space');
  expect(document.body.textContent).toContain('Not signed in');
  await act(async () => { button('Sign in with this wallet').click(); });
  await settle();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Signed in as');
  await act(async () => { button('Sign out').click(); });
  await settle();
  expect(button('Sign in with this wallet')).toBeTruthy();
  expect(server.session).toBeNull();
});
