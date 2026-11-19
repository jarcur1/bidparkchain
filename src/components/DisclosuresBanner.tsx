import React, { useState } from 'react';
import { Info, ShieldAlert, X } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { webProfile } from '../utils/networkProfile';

export const DisclosuresBanner: React.FC = () => {
  const { wrongChain, switchInjectedChain, walletState } = useWallet();
  const [dismissed, setDismissed] = useState(false);

  if (wrongChain && walletState.type === 'injected') {
    return (
      <aside className="disclosure-banner wrong-chain-banner" aria-label="Network warning">
        <div className="banner-content">
          <ShieldAlert className="banner-icon" size={18} />
          <div className="banner-text">
            <strong>Wrong Network Detected:</strong> BidPark operates on {webProfile.networkName} (Chain ID {webProfile.chainId}). Please switch your wallet network to continue bidding.
            {webProfile.id === 'sepolia' && (
              <div>This is an illustrative testnet rehearsal, not a real booking. No parking or physical access is provided. Only faucet-funded Sepolia test ETH is used; it is test currency, not payment for parking.</div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn-banner-action"
          onClick={switchInjectedChain}
        >
          Switch to {webProfile.networkName} ({webProfile.chainId})
        </button>
      </aside>
    );
  }

  if (dismissed) return null;

  return (
    <aside className="disclosure-banner prototype-banner" aria-label="Prototype disclosures">
      <div className="banner-content">
        <Info className="banner-icon" size={16} />
        <div className="banner-text">
          <span className="banner-tag">{webProfile.id === 'local' ? 'Local Prototype' : 'Testnet Rehearsal'}</span>
          <span>
            {webProfile.id === 'local' ? (
              <>Operating on local Hardhat chain. <strong>ETH has no monetary value.</strong> All bids are secured in Solidity escrow until settled. Host seller receives funds <em>only after parking end window</em> (no dispute protection claim). Sample listings are for local demonstration.</>
            ) : (
              <>This is an illustrative testnet rehearsal, not a real booking. No parking or physical access is provided. Only faucet-funded Sepolia test ETH is used; it is test currency, not payment for parking.</>
            )}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="banner-close-btn"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss notice"
      >
        <X size={15} />
      </button>
    </aside>
  );
};
