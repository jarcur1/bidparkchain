import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BrowserProvider, formatEther, HDNodeWallet, JsonRpcProvider, type ContractRunner } from 'ethers';
import type { Config, WalletState, WalletType } from '../types';
import { HARDHAT_CHAIN_HEX, HARDHAT_CHAIN_ID } from '../utils/constants';

interface WalletContextValue {
  walletState: WalletState;
  signer: ContractRunner | null;
  provider: JsonRpcProvider | BrowserProvider | null;
  wrongChain: boolean;
  connectLocal: (accountIndex?: number) => Promise<void>;
  connectInjected: () => Promise<void>;
  switchInjectedChain: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const STORAGE_WALLET_TYPE = 'bidpark_wallet_type';
const STORAGE_ACCOUNT_INDEX = 'bidpark_account_index';
const WalletContext = createContext<WalletContextValue | null>(null);
type Provider = JsonRpcProvider | BrowserProvider;

export const WalletProvider: React.FC<{ config: Config | null; children: React.ReactNode }> = ({ config, children }) => {
  const [walletState, setWalletState] = useState<WalletState>({
    type: 'local', address: null, balance: null, chainId: null,
    isReady: false, isConnecting: false, error: null, localAccountIndex: 1,
  });
  const [signer, setSigner] = useState<ContractRunner | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [wrongChain, setWrongChain] = useState(false);
  const configRef = useRef(config);
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
    setSigner(null);
    setProvider(null);
    setWrongChain(false);
    publish({ ...stateRef.current, type, localAccountIndex: index, address: null,
      balance: null, chainId: null, isReady: false, isConnecting: true, error: null });
    return id;
  }, [publish]);

  const fail = useCallback((id: number, error: unknown) => {
    if (generation.current !== id) return;
    publish({ ...stateRef.current, isReady: false, isConnecting: false,
      error: error instanceof Error ? error.message : String(error) });
  }, [publish]);

  const connectLocal = useCallback(async (accountIndex?: number) => {
    ++selection.current;
    const index = accountIndex ?? stateRef.current.localAccountIndex;
    const id = begin('local', index);
    try {
      if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
        throw new Error('Local test wallets are restricted to localhost.');
      }
      if (!Number.isInteger(index) || index < 0 || index > 19) throw new Error('Invalid local test account.');
      const currentConfig = configRef.current;
      if (!currentConfig || currentConfig.chainId !== HARDHAT_CHAIN_ID) {
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
      if (generation.current !== id) return;
      localStorage.setItem(STORAGE_WALLET_TYPE, 'local');
      localStorage.setItem(STORAGE_ACCOUNT_INDEX, String(index));
      activeProvider.current = rpc;
      setProvider(rpc);
      setSigner(wallet);
      publish({ type: 'local', address: wallet.address, balance, chainId: HARDHAT_CHAIN_ID,
        isReady: true, isConnecting: false, error: null, localAccountIndex: index });
    } catch (error) { fail(id, error); }
  }, [begin, fail, publish]);

  const connectBrowser = useCallback(async (requestAccess: boolean) => {
    const id = begin('injected');
    try {
      const ethereum = window.ethereum;
      if (!ethereum) throw new Error('No browser wallet found. Use a local test account or install a compatible wallet.');
      const accounts = await ethereum.request({ method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts' }) as string[];
      if (!accounts.length) throw new Error('Browser wallet is disconnected. Connect it to continue.');
      if (generation.current !== id) return;
      const rpc = new BrowserProvider(ethereum, 'any', { cacheTimeout: -1 });
      providers.current.add(rpc);
      const network = await rpc.getNetwork();
      const chainId = Number(network.chainId);
      const mismatch = chainId !== HARDHAT_CHAIN_ID || configRef.current?.chainId !== HARDHAT_CHAIN_ID;
      const wallet = mismatch ? null : await rpc.getSigner(accounts[0]);
      const balance = mismatch ? null : formatEther(await rpc.getBalance(accounts[0]));
      if (generation.current !== id) { rpc.destroy(); providers.current.delete(rpc); return; }
      localStorage.setItem(STORAGE_WALLET_TYPE, 'injected');
      activeProvider.current = rpc;
      setProvider(rpc);
      setSigner(wallet);
      setWrongChain(mismatch);
      publish({ ...stateRef.current, type: 'injected', address: accounts[0], balance, chainId,
        isReady: !mismatch, isConnecting: false, error: null });
    } catch (error) { fail(id, error); }
  }, [begin, fail, publish]);

  const connectInjected = useCallback(() => {
    ++selection.current;
    return connectBrowser(true);
  }, [connectBrowser]);

  const switchInjectedChain = useCallback(async () => {
    if (!window.ethereum || stateRef.current.type !== 'injected') return;
    const intent = selection.current;
    const id = generation.current;
    try {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HARDHAT_CHAIN_HEX }] });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 4902) throw error;
        if (selection.current !== intent || stateRef.current.type !== 'injected') return;
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: HARDHAT_CHAIN_HEX, chainName: 'Hardhat Local',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['http://127.0.0.1:8545'],
        }] });
        if (selection.current !== intent || stateRef.current.type !== 'injected') return;
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: HARDHAT_CHAIN_HEX }] });
      }
      if (selection.current === intent && stateRef.current.type === 'injected') await connectBrowser(false);
    } catch (error) {
      if (selection.current === intent && generation.current === id && stateRef.current.type === 'injected') fail(id, error);
    }
  }, [connectBrowser, fail]);

  const refreshBalance = useCallback(async () => {
    const id = generation.current;
    const address = stateRef.current.address;
    const rpc = activeProvider.current;
    if (!rpc || !address || !stateRef.current.isReady) return;
    try {
      const balance = formatEther(await rpc.getBalance(address));
      if (generation.current === id && stateRef.current.address === address) {
        publish({ ...stateRef.current, balance });
      }
    } catch (error) {
      if (generation.current === id) publish({ ...stateRef.current, balance: null,
        error: `Balance unavailable: ${error instanceof Error ? error.message : String(error)}` });
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
    if (savedType === 'local') void connectLocal(Number.isInteger(savedIndex) ? savedIndex : 1);
    else if (savedType === 'injected' && window.ethereum) void connectBrowser(false);
  }, [config, connectLocal, connectBrowser]);

  useEffect(() => () => {
    ++generation.current;
    for (const rpc of providers.current) rpc.destroy();
    providers.current.clear();
    localProvider.current = null;
    restored.current = false;
  }, []);

  return <WalletContext.Provider value={{ walletState, signer, provider, wrongChain,
    connectLocal, connectInjected, switchInjectedChain, refreshBalance }}>{children}</WalletContext.Provider>;
};

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used within a WalletProvider');
  return context;
}
