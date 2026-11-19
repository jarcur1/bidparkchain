import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther } from 'ethers';
import { WalletProvider, useWallet } from '../../src/context/WalletContext';
import { bridgeCrypto } from './crypto';
import { Header } from '../../src/components/Header';
import { WalletModal } from '../../src/components/WalletModal';
import type { Config } from '../../src/types';

const local = vi.hoisted(() => ({ balance: 42n * 10n ** 18n, chainId: 31337n, error: false }));
vi.mock('ethers', async (original) => {
  const actual = await original<typeof import('ethers')>();
  return { ...actual, JsonRpcProvider: class extends actual.JsonRpcProvider {
    async getNetwork() { return actual.Network.from(local.chainId); }
    async getBalance() { if (local.error) throw new Error('Local RPC unavailable'); return local.balance; }
  } };
});

const config: Config = {
  profile: 'local', confirmation: 'mined', explorerUrl: null,
  chainId: 31337, contractAddress: '0x0000000000000000000000000000000000000001', abi: [],
  currency: 'ETH', networkName: 'Hardhat Local', deploymentBlock: 1, deploymentBlockHash: '0xdeploy',
  demoMnemonic: 'test test test test test test test test test test test junk', demoAccountIndex: 1,
};
const a = '0x1111111111111111111111111111111111111111';
const b = '0x2222222222222222222222222222222222222222';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
class Injected {
  accounts = [a]; chainId = '0x7a69';
  balances = new Map([[a, parseEther('11')], [b, parseEther('22')]]);
  slow: { promise: Promise<string>; resolve: (value: string) => void } | null = null;
  listeners = new Map<string, Set<(value: unknown) => void>>();
  request = vi.fn(async ({ method, params }: { method: string; params?: (string | { chainId: string })[] }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return this.accounts;
    if (method === 'eth_chainId') return this.chainId;
    if (method === 'eth_getBalance') return this.slow ? this.slow.promise : `0x${this.balances.get(String(params![0]).toLowerCase())!.toString(16)}`;
    if (method === 'wallet_switchEthereumChain') { const target = params![0]; if (typeof target !== 'object') throw new Error('Missing chain'); this.chainId = target.chainId; this.emit('chainChanged', this.chainId); return null; }
    throw new Error(`Unexpected RPC ${method}`);
  });
  on(event: string, listener: (value: unknown) => void) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(listener); }
  removeListener(event: string, listener: (value: unknown) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value: unknown) { this.listeners.get(event)?.forEach((listener) => listener(value)); }
}
function Controls() {
  const { walletState, refreshBalance } = useWallet();
  return <><output data-state>{JSON.stringify(walletState)}</output><button onClick={() => void refreshBalance()}>Refresh balance</button></>;
}
let host: HTMLDivElement, root: Root, injected: Injected;
const query = (selector: string) => document.querySelector(selector)!;
async function click(element: Element) { await act(async () => { (element as HTMLElement).click(); }); }
async function until(check: () => void) { await vi.waitFor(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); check(); }, { timeout: 3000 }); }
const state = () => JSON.parse(query('[data-state]').textContent!);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  bridgeCrypto();
  localStorage.clear(); local.chainId = 31337n; local.error = false;
  injected = new Injected(); Object.defineProperty(window, 'ethereum', { configurable: true, value: injected });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<WalletProvider config={config}><Header currentTab="marketplace" onTabChange={() => {}} onOpenCreate={() => {}} onOpenWalletModal={() => {}} onRefresh={() => {}} isRefreshing={false} refundStatus="empty" activeBidsCount={0}/><WalletModal isOpen onClose={() => {}}/><Controls/></WalletProvider>));
}
async function connect() { await render(); await click(query('.avatar-injected').closest('button')!); await until(() => expect(state().isReady).toBe(true)); }

describe('wallet identity and network regressions', () => {
  it('updates the rendered address and balance on account changes and disconnects on an empty account list', async () => {
    await connect(); expect(query('.active-address-text').textContent).toBe(a); expect(query('.wallet-btn-balance').textContent).toContain('11.000');
    await act(async () => { injected.accounts = [b]; injected.emit('accountsChanged', [b]); });
    expect(query('.active-balance-pill').textContent).not.toContain('11.000');
    await until(() => expect(query('.active-address-text').textContent).toBe(b));
    expect(query('.wallet-btn-balance').textContent).toContain('22.000');
    await act(async () => { injected.accounts = []; injected.emit('accountsChanged', []); });
    expect(query('.active-address-text').textContent).toBe('Not connected'); expect(query('.wallet-btn').textContent).toContain('Connect Wallet'); expect(state().isReady).toBe(false);
  });

  it('offers a network switch and restores readiness when switching back', async () => {
    await connect();
    await act(async () => { injected.chainId = '0x1'; injected.emit('chainChanged', '0x1'); });
    await until(() => expect(query('.wallet-wrong-chain-notice').textContent).toContain('Connected to wrong chain!'));
    expect(state().isReady).toBe(false); expect(state().balance).toBeNull(); expect(query('.network-name').textContent).toBe('Wrong Chain');
    await click(query('.btn-switch-network-inline'));
    await until(() => expect(state().isReady).toBe(true));
    expect(query('.network-name').textContent).toBe('Hardhat 31337'); expect(query('.wallet-btn-balance').textContent).toContain('11.000');
    expect(injected.request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
  });

  it.each(['account', 'network'])('discards a slow balance refresh superseded by a %s change', async (kind) => {
    await connect(); const slow = deferred<string>(); injected.slow = slow;
    await click(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Refresh balance')!);
    await until(() => expect(injected.request.mock.calls.filter(([arg]) => arg.method === 'eth_getBalance').length).toBeGreaterThan(1));
    injected.slow = null;
    await act(async () => {
      if (kind === 'account') { injected.accounts = [b]; injected.emit('accountsChanged', [b]); }
      else { injected.chainId = '0x1'; injected.emit('chainChanged', '0x1'); }
    });
    await until(() => expect(state().isConnecting).toBe(false));
    await act(async () => { slow.resolve(`0x${parseEther('99').toString(16)}`); });
    expect(document.body.textContent).not.toContain('99.000');
    expect(state().balance).toBe(kind === 'account' ? '22.0' : null);
  });

  it('selects a local test account and only shows a connected header after its RPC succeeds', async () => {
    await render(); expect(query('.wallet-btn').textContent).toContain('Connect Wallet');
    await click(document.querySelectorAll('.demo-accounts-list button')[1]);
    await until(() => expect(state().isReady).toBe(true));
    expect(state().type).toBe('local'); expect(state().localAccountIndex).toBe(0);
    expect(query('.active-address-text').textContent).toBe(state().address); expect(query('.wallet-btn-balance').textContent).toContain('42.000');
  });

  it('keeps the header disconnected when the local RPC rejects the selected wallet', async () => {
    local.error = true; await render(); await click(document.querySelectorAll('.demo-accounts-list button')[1]);
    await until(() => expect(state().error).toBe('Local RPC unavailable'));
    expect(state().isReady).toBe(false); expect(query('.wallet-btn').textContent).toContain('Connect Wallet'); expect(query('.active-address-text').textContent).toBe('Not connected');
  });
});
