import React from 'react';
import { GraduationCap } from 'lucide-react';
import { parseEther } from 'ethers';
import { CAMPUS_SCENARIO_NAMES, CAMPUS_TIER_LABELS } from '../../shared/campus.js';
import type { Listing } from '../types';
import type { ReadStatus } from '../utils/readState';
import { formatEth } from '../utils/formatters';

interface Props {
  scenario: string | undefined;
  listings: Listing[];
  listingsStatus: ReadStatus;
}

interface TierStats {
  spots: string;
  withBids: string;
  total: string;
  highest: string;
  average: string;
}

const UNAVAILABLE = 'unavailable';
const UNKNOWN_STATS: TierStats = {
  spots: UNAVAILABLE,
  withBids: UNAVAILABLE,
  total: UNAVAILABLE,
  highest: UNAVAILABLE,
  average: UNAVAILABLE,
};

/** Wei for a decimal ETH string, or null when the string is not one. */
function parseWei(eth: string): bigint | null {
  try {
    return parseEther(eth);
  } catch {
    return null;
  }
}

/**
 * One walking-distance tier as the banner table shows it. Spots with bids and leading bids come from highestBid;
 * total bids comes from bidCount and is unavailable if any listing lacks one. Averages cover only spots with bids.
 */
function tierStats(tier: Listing[]): TierStats {
  const total = tier.every((l) => typeof l.bidCount === 'number')
    ? String(tier.reduce((sum, l) => sum + (l.bidCount ?? 0), 0))
    : UNAVAILABLE;
  const spots = String(tier.length);
  const leading = tier.map((l) => parseWei(l.highestBid));
  if (leading.includes(null)) return { spots, withBids: UNAVAILABLE, total, highest: UNAVAILABLE, average: UNAVAILABLE };
  const bidding = leading.filter((wei): wei is bigint => wei !== null && wei > 0n);
  if (bidding.length === 0) return { spots, withBids: '0', total, highest: 'none yet', average: 'none yet' };
  const highest = bidding.reduce((max, wei) => (wei > max ? wei : max));
  const sum = bidding.reduce((acc, wei) => acc + wei, 0n);
  return {
    spots,
    withBids: String(bidding.length),
    total,
    highest: `${formatEth(highest)} ETH`,
    average: `${formatEth(sum / BigInt(bidding.length))} ETH`,
  };
}

/** Class demo framing for the fictional campus scenarios; renders nothing for other seeds. */
export const CampusScenarioBanner: React.FC<Props> = ({ scenario, listings, listingsStatus }) => {
  const name = scenario ? CAMPUS_SCENARIO_NAMES[scenario] : undefined;
  if (!name) return null;
  const nearListings = listings.filter((l) => l.neighborhood === CAMPUS_TIER_LABELS.near);
  const farListings = listings.filter((l) => l.neighborhood === CAMPUS_TIER_LABELS.far);
  const near = nearListings.length;
  const far = farListings.length;
  const known = listingsStatus === 'success' || listingsStatus === 'empty' || listingsStatus === 'stale';
  const tiers = [
    { label: CAMPUS_TIER_LABELS.near, stats: known ? tierStats(nearListings) : UNKNOWN_STATS },
    { label: CAMPUS_TIER_LABELS.far, stats: known ? tierStats(farListings) : UNKNOWN_STATS },
  ];

  return (
    <section className="disclosure-banner campus-banner" aria-label="Class demo scenario">
      <div className="banner-content">
        <GraduationCap className="banner-icon" size={18} />
        <div className="banner-text">
          <strong>Unofficial campus-parking parody.</strong> Inspired by LSU commuter parking: what if a fictional new
          dorm left so few good spots that students started auctioning them off? Not affiliated with or endorsed by LSU.
          <div>
            Scenario: <strong>{name}</strong>.{' '}
            {known
              ? `Near-campus spots listed: ${near} of ${near + far} (${far} farther away)${listingsStatus === 'stale' ? ', from the last successful read' : ''}.`
              : 'Spot counts are unavailable until listings load.'}
          </div>
          <div className="campus-stats-scroll" role="region" aria-label="Bidding by walking distance" tabIndex={0}>
            <table className="campus-stats">
              <caption>Bidding by walking distance, in simulated test ETH{listingsStatus === 'stale' ? ', from the last successful read' : ''}.</caption>
              <thead>
                <tr>
                  <th scope="col">Walking distance</th>
                  <th scope="col">Spots</th>
                  <th scope="col">Spots with bids</th>
                  <th scope="col">Total bids</th>
                  <th scope="col">Highest leading bid</th>
                  <th scope="col">Average leading bid</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier) => (
                  <tr key={tier.label}>
                    <th scope="row">{tier.label}</th>
                    <td>{tier.stats.spots}</td>
                    <td>{tier.stats.withBids}</td>
                    <td>{tier.stats.total}</td>
                    <td>{tier.stats.highest}</td>
                    <td>{tier.stats.average}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            All prices, bids and wins are simulated test ETH, and winning grants no real parking. If the map does not
            load, use the Cards view.
          </div>
        </div>
      </div>
    </section>
  );
};
