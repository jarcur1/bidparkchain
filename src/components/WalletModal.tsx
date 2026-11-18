import React, { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ShieldAlert,
  ShieldCheck,
  User,
  Wallet,
  X,
} from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { DEMO_ACCOUNTS } from '../utils/constants';
import { formatEth, shortenAddress } from '../utils/formatters';
import { Dialog } from './Dialog';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WalletModal: React.FC<WalletModalProps> = ({ isOpen, onClose }) => {
  const {
    walletState,
    connectLocal,
    connectInjected,
    switchInjectedChain,
    wrongChain,
  } = useWallet();

  const [copiedAddr, setCopiedAddr] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (walletState.address) {
      navigator.clipboard.writeText(walletState.address);
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 2000);
    }
  };

  return (
    <Dialog
      className="modal-dialog modal-wallet-dialog"
      labelledBy="wallet-modal-title"
      onClose={onClose}
    >
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-icon-title">
            <div className="icon-badge-forest">
              <Wallet size={18} />
            </div>
            <div>
              <h3 id="wallet-modal-title" className="modal-heading">
                Connect & Switch Wallet
              </h3>
              <p className="modal-subheading">
                Local Hardhat Testnet (Chain ID 31337)
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Current active account card */}
        <div className="wallet-active-card">
          <div className="active-card-top">
            <div className="active-badge-row">
              <span className="active-status-dot" />
              <span className="active-type-text">
                {walletState.type === 'local' ? 'Local Test Wallet' : 'Injected Browser Wallet'}
              </span>
            </div>
            <div className="active-balance-pill">
              {formatEth(walletState.balance)} ETH
            </div>
          </div>

          <div className="active-address-row">
            <code className="active-address-text">{walletState.address || 'Not connected'}</code>
            {walletState.address && (
              <button
                type="button"
                className="btn-copy-address"
                onClick={handleCopy}
                title="Copy address"
              >
                <Copy size={13} />
                <span aria-live="polite">{copiedAddr ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>

          {wrongChain && (
            <div className="wallet-wrong-chain-notice" role="alert">
              <ShieldAlert size={15} />
              <span>Connected to wrong chain! Contract requires Hardhat 31337.</span>
              <button
                type="button"
                className="btn-switch-network-inline"
                onClick={switchInjectedChain}
              >
                Switch Network
              </button>
            </div>
          )}
        </div>

        {/* Option 1: Local Test Wallets (Zero setup) */}
        <div className="wallet-section">
          <div className="section-title-row">
            <span className="section-label">Local Test Wallets (Instant, Zero Setup)</span>
            <span className="section-note">Preloaded with 10,000 test ETH</span>
          </div>

          <div className="demo-accounts-list">
            {DEMO_ACCOUNTS.map((acc) => {
              const isActive =
                walletState.type === 'local' &&
                walletState.localAccountIndex === acc.index;
              return (
                <button
                  key={acc.index}
                  type="button"
                  className={`demo-account-item ${isActive ? 'is-active-account' : ''}`}
                  onClick={() => connectLocal(acc.index)}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <span className="account-item-left">
                    <span className="account-avatar">
                      <User size={15} />
                    </span>
                    <span className="account-labels">
                      <span className="account-title-row">
                        <span className="account-label-text">{acc.label}</span>
                        <span className="account-role-tag">{acc.role}</span>
                      </span>
                      <span className="account-address-sub">
                        {shortenAddress(acc.address, 6)}
                      </span>
                    </span>
                  </span>

                  <span className="account-item-right">
                    {isActive ? (
                      <span className="badge-active-pill">
                        <CheckCircle2 size={13} />
                        <span>Active</span>
                      </span>
                    ) : (
                      <span className="btn-select-account">Switch</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Option 2: Browser Injected Wallet */}
        <div className="wallet-section">
          <div className="section-title-row">
            <span className="section-label">Browser Wallet (MetaMask / Extension)</span>
          </div>

          <button
            type="button"
            className={`demo-account-item ${
              walletState.type === 'injected' ? 'is-active-account' : ''
            }`}
            onClick={connectInjected}
            aria-current={walletState.type === 'injected' ? 'true' : undefined}
          >
            <span className="account-item-left">
              <span className="account-avatar avatar-injected">
                <Wallet size={15} />
              </span>
              <span className="account-labels">
                <span className="account-label-text">Injected Web3 Provider</span>
                <span className="account-address-sub">
                  {typeof window.ethereum !== 'undefined'
                    ? 'MetaMask or compatible extension detected'
                    : 'No browser extension found'}
                </span>
              </span>
            </span>

            <span className="account-item-right">
              {walletState.type === 'injected' ? (
                <span className="badge-active-pill">
                  <CheckCircle2 size={13} />
                  <span>Active</span>
                </span>
              ) : (
                <span className="btn-select-account">Connect</span>
              )}
            </span>
          </button>
        </div>

        {/* Notice */}
        <div className="wallet-notice-footer">
          <ShieldCheck size={14} />
          <span>
            Test keys only. Never deposit real mainnet funds. All transactions execute against local RPC.
          </span>
        </div>
    </Dialog>
  );
};
