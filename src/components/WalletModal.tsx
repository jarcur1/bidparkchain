import React, { useEffect, useState } from 'react';
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
import { formatBalance, shortenAddress } from '../utils/formatters';

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
    balanceRead,
  } = useWallet();

  const [copiedAddr, setCopiedAddr] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (walletState.address) {
      navigator.clipboard.writeText(walletState.address);
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 2000);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
    >
      <div className="modal-dialog modal-wallet-dialog" onClick={(e) => e.stopPropagation()}>
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
              {formatBalance(walletState.balance, balanceRead)}
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
                <span>{copiedAddr ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>

          {wrongChain && (
            <div className="wallet-wrong-chain-notice">
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
                <div
                  key={acc.index}
                  className={`demo-account-item ${isActive ? 'is-active-account' : ''}`}
                  onClick={() => connectLocal(acc.index)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="account-item-left">
                    <div className="account-avatar">
                      <User size={15} />
                    </div>
                    <div className="account-labels">
                      <div className="account-title-row">
                        <span className="account-label-text">{acc.label}</span>
                        <span className="account-role-tag">{acc.role}</span>
                      </div>
                      <span className="account-address-sub">
                        {shortenAddress(acc.address, 6)}
                      </span>
                    </div>
                  </div>

                  <div className="account-item-right">
                    {isActive ? (
                      <span className="badge-active-pill">
                        <CheckCircle2 size={13} />
                        <span>Active</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn-select-account"
                        onClick={(e) => {
                          e.stopPropagation();
                          connectLocal(acc.index);
                        }}
                      >
                        Switch
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Option 2: Browser Injected Wallet */}
        <div className="wallet-section">
          <div className="section-title-row">
            <span className="section-label">Browser Wallet (MetaMask / Extension)</span>
          </div>

          <div
            className={`demo-account-item ${
              walletState.type === 'injected' ? 'is-active-account' : ''
            }`}
            onClick={connectInjected}
            role="button"
            tabIndex={0}
          >
            <div className="account-item-left">
              <div className="account-avatar avatar-injected">
                <Wallet size={15} />
              </div>
              <div className="account-labels">
                <span className="account-label-text">Injected Web3 Provider</span>
                <span className="account-address-sub">
                  {typeof window.ethereum !== 'undefined'
                    ? 'MetaMask or compatible extension detected'
                    : 'No browser extension found'}
                </span>
              </div>
            </div>

            <div className="account-item-right">
              {walletState.type === 'injected' ? (
                <span className="badge-active-pill">
                  <CheckCircle2 size={13} />
                  <span>Active</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-select-account"
                  onClick={(e) => {
                    e.stopPropagation();
                    connectInjected();
                  }}
                >
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Notice */}
        <div className="wallet-notice-footer">
          <ShieldCheck size={14} />
          <span>
            Test keys only. Never deposit real mainnet funds. All transactions execute against local RPC.
          </span>
        </div>
      </div>
    </div>
  );
};
