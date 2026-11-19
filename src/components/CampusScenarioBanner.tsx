import React from 'react';
import { GraduationCap } from 'lucide-react';
import { CAMPUS_SCENARIO_NAMES, CAMPUS_TIER_LABELS } from '../../shared/campus.js';
import type { Listing } from '../types';
import type { ReadStatus } from '../utils/readState';

interface Props {
  scenario: string | undefined;
  listings: Listing[];
  listingsStatus: ReadStatus;
}

/** Class demo framing for the fictional campus scenarios; renders nothing for other seeds. */
export const CampusScenarioBanner: React.FC<Props> = ({ scenario, listings, listingsStatus }) => {
  const name = scenario ? CAMPUS_SCENARIO_NAMES[scenario] : undefined;
  if (!name) return null;
  const near = listings.filter((l) => l.neighborhood === CAMPUS_TIER_LABELS.near).length;
  const far = listings.filter((l) => l.neighborhood === CAMPUS_TIER_LABELS.far).length;
  const known = listingsStatus === 'success' || listingsStatus === 'empty' || listingsStatus === 'stale';

  return (
    <section className="disclosure-banner" aria-label="Class demo scenario">
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
          <div>
            All prices, bids and wins are simulated test ETH, and winning grants no real parking. If the map does not
            load, use the Cards view.
          </div>
        </div>
      </div>
    </section>
  );
};
