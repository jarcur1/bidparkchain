import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BrowserProvider, formatEther, HDNodeWallet, JsonRpcProvider, type ContractRunner } from 'ethers';
import type { Config, WalletState, WalletType } from '../types';
import {
  LOADING_READ, READ_OK, READ_SKIPPED, READ_SUPERSEDED, readFailed, readFailure, readSucceeded,
  type ReadResult, type ReadState,
} from '../utils/readState';
import { HARDHAT_CHAIN_ID } from '../utils/constants';
import { webProfile } from '../utils/networkProfile';

function configMatches(config: Config | null): boolean {
  if (!config || config.chainId !== webProfile.chainId) return false;
  // Component tests may provide older local config fixtures, but not Sepolia fixtures.
  return (config.profile === webProfile.id || (webProfile.id === 'local' && config.profile === undefined)) &&
    (config.confirmation === webProfile.confirmation || (webProfile.id === 'local' && config.confirmation === undefined));
}

export interface WalletContextValue {
  walletState: WalletState;
  signer: ContractRunner | null;
  isCurrentSigner: (candidate: ContractRunner) => boolean;
  provider: JsonRpcProvider | BrowserProvider | null;
  wrongChain: boolean;
  connectLocal: (accountIndex?: number) => Promise<void>;
  connectInjected: () => Promise<void>;
  switchInjectedChain: () => Promise<void>;
  /** Forgets the wallet selection in this app. It does not revoke the site's access in a wallet extension. */
  disconnect: () => void;
  refreshBalance: () => Promise<ReadResult>;
  balanceRead: ReadState;
}

const STORAGE_WALLET_TYPE = 'bidpark_wallet_type';
const STORAGE_ACCOUNT_INDEX = 'bidpark_account_index';
const WalletContext = createContext<WalletContextValue | null>(null);

/** A connection error in words a user can act on; a declined wallet prompt is not shown as a failure code. */
function describeConnectionError(error: unknown): string {
  const e = error as { code?: unknown; info?: { error?: { code?: unknown } } } | null;
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.info?.error?.code === 4001) {
    return 'The connection request was rejected in your wallet. Choose a wallet again to retry.';
  }
  return error instanceof Error ? error.message : String(error);
}
type Provider = JsonRpcProvider | BrowserProvider;

export const WalletProvider: React.FC<{ config: Config | null; children: React.ReactNode }> = ({ config, children }) => {
  const [walletState, setWalletState] = useState<WalletState>({
    type: 'local', address: null, balance: null, chainId: null,
    isReady: false, isConnecting: false, error: null, localAccountIndex: 1,
  });
  const [signer, setSigner] = useState<ContractRunner | null>(null);
  const signerRef = useRef<ContractRunner | null>(null);
  const publishSigner = useCallback((next: ContractRunner | null) => {
    signerRef.current = next;
    setSigner(next);
  }, []);
  const isCurrentSigner = useCallback((candidate: ContractRunner) =>
    signerRef.current === candidate && configMatches(configRef.current) &&
    stateRef.current.chainId === webProfile.chainId &&
    (webProfile.id === 'local' || stateRef.current.type === 'injected'), []);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [wrongChain, setWrongChain] = useState(false);
  // Each balance read is stamped with the deployment it was read under.
  const [balanceScope, setBalanceScope] = useState<{ read: ReadState; deployment: string | null }>(
    { read: LOADING_READ, deployment: null });
  const balanceSeq = useRef(0);
  const configRef = useRef(config);
  const deploymentKey = config ? `${config.chainId}:${config.contractAddress}:${config.deploymentBlock}:${config.deploymentBlockHash}` : null;
  const deploymentKeyRef = useRef(deploymentKey);
  deploymentKeyRef.current = deploymentKey;
  const setBalanceRead = useCallback((next: ReadState | ((prev: ReadState) => ReadState)) => {
    const deployment = deploymentKeyRef.current;
    setBalanceScope((prev) => ({ read: typeof next === 'function' ? next(prev.read) : next, deployment }));
  }, []);
  // Synchronously derived: a balance read under another deployment is never presented as current.
  const balanceRead: ReadState = balanceScope.deployment === deploymentKey || balanceScope.read.status === 'loading' ||
    balanceScope.read.status === 'failed' || balanceScope.read.status === 'stale'
    ? balanceScope.read
    : { ...balanceScope.read, status: 'stale', error: 'Deployment changed; balance is being re-read' };
  const stateRef = useRef(walletState);
  const activeProvider = useRef<Provider | null>(null);
  const localProvider = useRef<JsonRpcProvider | null>(null);
  const providers = useRef(new Set<Provider>());
  const generation = useRef(0);
  const selection = useRef(0);
  const restored = useRef(false);
  configRef.current = config;

  const publish = useCallback((next: WalletState) => {
    stateRef.current = next;
    setWalletState(next);
  }, []);

  // Every connection attempt invalidates all earlier asynchronous completions.
  const begin = useCallback((type: WalletType, index = stateRef.current.localAccountIndex) => {
    const id = ++generation.current;
    activeProvider.current = null;
    ++balanceSeq.current;
    setBalanceRead(LOADING_READ);
    publishSigner(null);
    setProvider(null);
    setWrongChain(false);
    publish({ ...stateRef.current, type, localAccountIndex: index, address: null,
      balance: null, chainId: null, isReady: false, isConnecting: true, error: null });
    return id;
  }, [publish, publishSigner]);

  const fail = useCallback((id: number, error: unknown) => {
    if (generation.current !== id) return;
    setBalanceRead(readFailed(LOADING_READ, error));
    publish({ ...stateRef.current, isReady: false, isConnecting: false, error: describeConnectionError(error) });
  }, [publish]);

  const connectLocal = useCallback(async (accountIndex?: number) => {
    ++selection.current;
    const index = accountIndex ?? stateRef.current.localAccountIndex;
    const id = begin('local', index);
    try {
      if (import.meta.env.VITE_BIDPARK_PROFILE === 'sepolia') {
        throw new Error('Local test wallets are unavailable on Sepolia.');
      }
      if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
        throw new Error('Local test wallets are restricted to localhost.');
      }
      if (!Number.isInteger(index) || index < 0 || index > 19) throw new Error('Invalid local test account.');
      const currentConfig = configRef.current;
      if (!configMatches(currentConfig) || !currentConfig?.demoMnemonic || currentConfig.chainId !== HARDHAT_CHAIN_ID) {
        throw new Error('Local chain configuration is unavailable or unsupported.');
      }
      if (!localProvider.current) {
        localProvider.current = new JsonRpcProvider(`${window.location.origin}/rpc`, undefined, { cacheTimeout: -1 });
        providers.current.add(localProvider.current);
      }
      const rpc = localProvider.current;
      const network = await rpc.getNetwork();
      if (network.chainId !== BigInt(HARDHAT_CHAIN_ID)) throw new Error('RPC is not local chain 31337.');
      const wallet = HDNodeWallet.fromPhrase(currentConfig.demoMnemonic, undefined, `m/44'/60'/0'/0/${index}`).connect(rpc);
      const balance = formatEther(await rpc.getBalance(wallet.address));
      if (generation.current !== id || !configMatches(configRef.current) || configRef.current !== currentConfig) return;
      localStorage.setItem(STORAGE_WALLET_TYPE, 'local');
      localStorage.setItem(STORAGE_ACCOUNT_INDEX, String(index));
      activeProvider.current = rpc;
      setProvider(rpc);
      publishSigner(wallet);
      publish({ type: 'local', address: wallet.address, balance, chainId: HARDHAT_CHAIN_ID,
        isReady: true, isConnecting: false, error: null, localAccountIndex: index });
      setBalanceRead(readSucceeded());
    } catch (error) { fail(id, error); }
  }, [begin, fail, publish, publishSigner]);

  const connectBrowser = useCallback(async (requestAccess: boolean) => {
    const id = begin('injected');
    try {
      const ethereum = window.ethereum;
      if (!ethereum) throw new Error('No browser wallet found. Use a local test account or install a compatible wallet.');
      const accounts = await ethereum.request({ method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts' }) as string[];
      if (!accounts.length) throw new Error('Browser wallet is disconnected. Connect it to continue.');
      if (generation.current !== id) return;
      const initialRpc = webProfile.id === 'local' ? new BrowserProvider(ethereum, 'any', { cacheTimeout: -1 }) : null;
      if (initialRpc) providers.current.add(initialRpc);
      const chainId = initialRpc
        ? Number((await initialRpc.getNetwork()).chainId)
        : Number(BigInt(await ethereum.request({ method: 'eth_chainId' }) as string));
      const mismatch = chainId !== webProfile.chainId || !configMatches(configRef.current);
      const rpc = initialRpc ?? new BrowserProvider(ethereum, mismatch ? 'any' : webProfile.chainId, { cacheTimeout: -1 });
      providers.current.add(rpc);
      const wallet = mismatch ? null : await rpc.getSigner(accounts[0]);
      const balance = mismatch ? null : formatEther(await rpc.getBalance(accounts[0]));
      if (generation.current !== id || (!mismatch && !configMatches(configRef.current))) { rpc.destroy(); providers.current.delete(rpc); return; }
      localStorage.setItem(STORAGE_WALLET_TYPE, 'injected');
      activeProvider.current = rpc;
      setProvider(rpc);
      publishSigner(wallet);
      setWrongChain(mismatch);
      publish({ ...stateRef.current, type: 'injected', address: accounts[0], balance, chainId,
        isReady: !mismatch, isConnecting: false, error: null });
      setBalanceRead(mismatch ? readFailed(LOADING_READ, 'Wallet is not on the supported network.') : readSucceeded());
    } catch (error) { fail(id, error); }
  }, [begin, fail, publish, publishSigner]);

  const connectInjected = useCallback(() => {
    ++selection.current;
    return connectBrowser(true);
  }, [connectBrowser]);

  const switchInjectedChain = useCallback(async () => {
    if (!window.ethereum || stateRef.current.type !== 'injected') return;
    const intent = selection.current;
    const id = generation.current;
    if (!configMatches(configRef.current)) {
      fail(id, new Error('Network configuration is unavailable or does not match this build.'));
      return;
    }
    const chainId = `0x${webProfile.chainId.toString(16)}`;
    try {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 4902) throw error;
        if (selection.current !== intent || stateRef.current.type !== 'injected') return;
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId, chainName: webProfile.networkName,
          nativeCurrency: { name: webProfile.currency, symbol: webProfile.currency, decimals: 18 }, rpcUrls: [webProfile.walletRpcUrl],
          ...(webProfile.explorerUrl ? { blockExplorerUrls: [webProfile.explorerUrl] } : {}),
        }] });
        if (selection.current !== intent || stateRef.current.type !== 'injected') return;
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      }
      if (selection.current === intent && stateRef.current.type === 'injected') await connectBrowser(false);
    } catch (error) {
      if (selection.current === intent && generation.current === id && stateRef.current.type === 'injected') fail(id, error);
    }
  }, [connectBrowser, fail]);

  const disconnect = useCallback(() => {
    ++selection.current;
    ++generation.current;
    ++balanceSeq.current;
    activeProvider.current = null;
    localStorage.removeItem(STORAGE_WALLET_TYPE);
    localStorage.removeItem(STORAGE_ACCOUNT_INDEX);
    setBalanceRead(LOADING_READ);
    publishSigner(null);
    setProvider(null);
    setWrongChain(false);
    // Type 'local' with no address is "disconnected": extension account/chain events no longer reconnect.
    publish({ ...stateRef.current, type: 'local', address: null, balance: null, chainId: null,
      isReady: false, isConnecting: false, error: null });
  }, [publish, publishSigner, setBalanceRead]);

  const refreshBalance = useCallback(async (): Promise<ReadResult> => {
    const id = generation.current;
    const address = stateRef.current.address;
    const chainId = stateRef.current.chainId;
    const rpc = activeProvider.current;
    if (!rpc || !address || !stateRef.current.isReady) return READ_SKIPPED;
    const seq = ++balanceSeq.current;
    const readDeployment = deploymentKeyRef.current;
    // Only the newest read for the still-current account/chain may publish.
    const isCurrent = () => generation.current === id && balanceSeq.current === seq && deploymentKeyRef.current === readDeployment &&
      stateRef.current.address === address && stateRef.current.chainId === chainId;
    try {
      const balance = formatEther(await rpc.getBalance(address));
      if (!isCurrent()) return READ_SUPERSEDED;
      publish({ ...stateRef.current, balance });
      setBalanceRead(readSucceeded());
      return READ_OK;
    } catch (error) {
      if (!isCurrent()) return READ_SUPERSEDED;
      // The last known balance stays in walletState; the read state labels it stale.
      setBalanceRead((prev) => readFailed(prev, error));
      return readFailure(error);
    }
  }, [publish]);

  useEffect(() => {
    const ethereum = window.ethereum;
    if (!ethereum) return;
    const accountsChanged = (accounts: unknown) => {
      if (stateRef.current.type !== 'injected') return;
      if (Array.isArray(accounts) && accounts.length) void connectBrowser(false);
      else {
        const id = begin('injected');
        fail(id, new Error('Browser wallet disconnected.'));
      }
    };
    const chainChanged = () => {
      if (stateRef.current.type === 'injected') void connectBrowser(false);
    };
    ethereum.on('accountsChanged', accountsChanged);
    ethereum.on('chainChanged', chainChanged);
    return () => {
      ethereum.removeListener?.('accountsChanged', accountsChanged);
      ethereum.removeListener?.('chainChanged', chainChanged);
    };
  }, [begin, connectBrowser, fail]);

  useEffect(() => {
    if (!config || restored.current) return;
    restored.current = true;
    const savedType = localStorage.getItem(STORAGE_WALLET_TYPE);
    const savedIndex = Number(localStorage.getItem(STORAGE_ACCOUNT_INDEX) ?? 1);
    if (savedType === 'local' && import.meta.env.VITE_BIDPARK_PROFILE !== 'sepolia') void connectLocal(Number.isInteger(savedIndex) ? savedIndex : 1);
    else if (savedType === 'injected' && window.ethereum) void connectBrowser(false);
  }, [config, connectLocal, connectBrowser]);

  useEffect(() => () => {
    ++generation.current;
    signerRef.current = null;
    for (const rpc of providers.current) rpc.destroy();
    providers.current.clear();
    localProvider.current = null;
    restored.current = false;
  }, []);

  const usable = configMatches(config) && walletState.chainId === webProfile.chainId &&
    (webProfile.id === 'local' || walletState.type === 'injected');
  return <WalletContext.Provider value={{ walletState: usable ? walletState : { ...walletState, isReady: false },
    signer: usable ? signer : null, isCurrentSigner, provider, wrongChain,
    connectLocal, connectInjected, switchInjectedChain, disconnect, refreshBalance, balanceRead }}>{children}</WalletContext.Provider>;
};

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used within a WalletProvider');
  return context;
}
