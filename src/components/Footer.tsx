import React from 'react';
import { Car } from 'lucide-react';
import type { Config } from '../types';
import { shortenAddress } from '../utils/formatters';

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
            <span className="footer-version-tag">Local Testnet MVP</span>
          </div>
          <p className="footer-bio">
            A little space. A better arrival. Timed private parking auctions with smart contract escrow in Austin, Texas.
          </p>
        </div>

        <div className="footer-disclosures-col">
          <h4 className="footer-heading">Local Prototype Disclosures</h4>
          <p className="footer-legal-text">
            BidPark is an experimental demonstration built for local evaluation on Hardhat Local (Chain ID 31337). ETH displayed is simulation test currency with <strong>zero monetary value</strong>.
          </p>
          <p className="footer-legal-text">
            Smart contracts autonomously enforce bid escrow and reservation rights. Host seller receives funds <em>strictly after</em> the parking window concludes. Sample listings are mock local demonstrations. No dispute protection or physical access guarantee is provided in this prototype.
          </p>
        </div>

        <div className="footer-telemetry-col">
          <h4 className="footer-heading">System Telemetry</h4>
          <ul className="footer-meta-list">
            <li>
              <span className="meta-k">Network:</span>
              <span className="meta-v">Hardhat Local (31337)</span>
            </li>
            <li>
              <span className="meta-k">JSON RPC:</span>
              <span className="meta-v">127.0.0.1:8545 (/rpc)</span>
            </li>
            <li>
              <span className="meta-k">Express API:</span>
              <span className="meta-v">127.0.0.1:3001 (/api)</span>
            </li>
            {config?.contractAddress && (
              <li>
                <span className="meta-k">Escrow Contract:</span>
                <span className="meta-v mono-val" title={config.contractAddress}>
                  {shortenAddress(config.contractAddress, 6)}
                </span>
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="footer-bottom-bar">
        <div className="footer-bottom-inner">
          <span>&copy; {new Date().getFullYear()} BidPark. Local Demonstration Prototype.</span>
          <span className="footer-leaf-pill">Solidity 0.8 Escrow • React 19 • Leaflet OSM</span>
        </div>
      </div>
    </footer>
  );
};
