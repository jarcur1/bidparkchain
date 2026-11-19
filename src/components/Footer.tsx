import React from 'react';
import { Car } from 'lucide-react';
import type { Config } from '../types';
import { shortenAddress } from '../utils/formatters';
import { webProfile } from '../utils/networkProfile';

interface FooterProps {
  config: Config | null;
}

export const Footer: React.FC<FooterProps> = ({ config }) => {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand-col">
          <div className="footer-logo-row">
            <Car size={20} className="footer-logo-icon" />
            <span className="footer-logo-text">BidPark</span>
            <span className="footer-version-tag">{webProfile.id === 'local' ? 'Local Testnet MVP' : 'Sepolia Testnet Rehearsal'}</span>
          </div>
          <p className="footer-bio">
            A little space. A better arrival. Timed private parking auctions with smart contract escrow in Austin, Texas.
          </p>
        </div>

        <div className="footer-disclosures-col">
          <h4 className="footer-heading">{webProfile.id === 'local' ? 'Local Prototype Disclosures' : 'Testnet Rehearsal Disclosures'}</h4>
          {webProfile.id === 'local' ? (
            <>
              <p className="footer-legal-text">
                BidPark is an experimental demonstration built for local evaluation on Hardhat Local (Chain ID 31337). ETH displayed is simulation test currency with <strong>zero monetary value</strong>.
              </p>
              <p className="footer-legal-text">
                Smart contracts autonomously enforce bid escrow and reservation rights. Host seller receives funds <em>strictly after</em> the parking window concludes. Sample listings are mock local demonstrations. No dispute protection or physical access guarantee is provided in this prototype.
              </p>
            </>
          ) : (
            <p className="footer-legal-text">
              This is an illustrative testnet rehearsal, not a real booking. No parking or physical access is provided. Only faucet-funded Sepolia test ETH is used; it is test currency, not payment for parking. The contract does not check physical delivery and provides no dispute protection.
            </p>
          )}
        </div>

        <div className="footer-telemetry-col">
          <h4 className="footer-heading">System Telemetry</h4>
          <ul className="footer-meta-list">
            <li>
              <span className="meta-k">Network:</span>
              <span className="meta-v">{webProfile.networkName} ({webProfile.chainId})</span>
            </li>
            {config?.contractAddress && (
              <li>
                <span className="meta-k">Escrow Contract:</span>
                <span className="meta-v mono-val" title={config.contractAddress}>
                  {webProfile.explorerUrl && config.explorerUrl === webProfile.explorerUrl && /^0x[0-9a-fA-F]{40}$/.test(config.contractAddress) ? (
                    <a href={`${webProfile.explorerUrl}/address/${config.contractAddress}`} target="_blank" rel="noopener noreferrer">
                      {shortenAddress(config.contractAddress, 6)}
                    </a>
                  ) : shortenAddress(config.contractAddress, 6)}
                </span>
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="footer-bottom-bar">
        <div className="footer-bottom-inner">
          <span>&copy; {new Date().getFullYear()} BidPark. {webProfile.id === 'local' ? 'Local Demonstration Prototype.' : 'Testnet Rehearsal.'}</span>
          <span className="footer-leaf-pill">Solidity 0.8 Escrow • React 19 • Leaflet OSM</span>
        </div>
      </div>
    </footer>
  );
};
