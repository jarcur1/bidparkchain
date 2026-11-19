import { ethers } from 'ethers';
import { normalizeMetadata } from '../../shared/metadata.js';

/**
 * Calculates the canonical keccak256 hash of a SpotMetadata object.
 * Follows exact contract specification:
 * metadataHash = keccak256(toUtf8Bytes(JSON.stringify(normalizeMetadata(metadata))))
 */
export function computeMetadataHash(metadata) {
  const normalized = normalizeMetadata(metadata);
  const jsonString = JSON.stringify(normalized);
  return ethers.keccak256(ethers.toUtf8Bytes(jsonString));
}

// Fictional class-demo campus (#37). Both scenarios share the near/far tiers, opening bids and
// reservation window; the only intentional difference is CAMPUS_EXPANSION_REMOVED. Positions are
// arbitrary points near the default map view, not a real campus, lot, or parking rule.
const CAMPUS_TIERS = {
  near: { neighborhood: 'Near campus · 3-5 min walk', minBidEth: '0.03' },
  far: { neighborhood: 'Farther away · 15-20 min walk', minBidEth: '0.01' },
};
const CAMPUS_WINDOW = { bidEndMinutes: 60, parkingStartMinutes: 90, parkingEndMinutes: 330 };
const CAMPUS_IMAGES = {
  garage: 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=800&q=80',
  covered: 'https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?auto=format&fit=crop&w=800&q=80',
  driveway: 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=800&q=80',
};
const CAMPUS_SPOTS = [
  ['N1', 'near', 3, 'Quad Edge Commuter Spot', 'covered', 30.2700, -97.7425, 'Shaded spot beside the central quad.'],
  ['N2', 'near', 4, 'Library Row Commuter Spot', 'driveway', 30.2706, -97.7415, 'Surface spot across from the main library.'],
  ['N3', 'near', 4, 'Old Gym Lot Commuter Spot', 'driveway', 30.2694, -97.7412, 'Open-air spot behind the old gym.'],
  ['N4', 'near', 5, 'Science Hall Deck Commuter Spot', 'garage', 30.2710, -97.7430, 'Covered deck spot next to the science hall.'],
  ['F1', 'far', 15, 'Riverside Overflow Lot Spot', 'driveway', 30.2640, -97.7480, 'Large overflow lot a long walk from class.'],
  ['F2', 'far', 18, 'Stadium Remote Lot Spot', 'driveway', 30.2760, -97.7490, 'Remote lot past the stadium.'],
  ['F3', 'far', 20, 'Park-and-Walk Garage Spot', 'garage', 30.2650, -97.7360, 'Edge-of-town garage with a long walk in.'],
];
/** Near spots replaced by the fictional residence-hall expansion. */
export const CAMPUS_EXPANSION_REMOVED = ['N2', 'N3', 'N4'];
export const SEED_SCENARIOS = ['austin', 'campus-baseline', 'campus-expansion'];

export function resolveSeedScenario(value = process.env.BIDPARK_SCENARIO) {
  const scenario = value === undefined ? 'austin' : value;
  if (!SEED_SCENARIOS.includes(scenario)) {
    throw new Error(`Unknown BIDPARK_SCENARIO "${scenario}". Use one of: ${SEED_SCENARIOS.join(', ')}.`);
  }
  return scenario;
}

function campusListings(scenario) {
  return CAMPUS_SPOTS
    .filter(([id]) => scenario === 'campus-baseline' || !CAMPUS_EXPANSION_REMOVED.includes(id))
    .map(([fixtureId, tier, walkMinutes, name, kind, latitude, longitude, detail]) => ({
      fixtureId,
      tier,
      metadata: {
        title: `${fixtureId} · ${name} [Fictional Class Demo]`,
        address: `Spot ${fixtureId}, Fictional Demo Campus`,
        neighborhood: CAMPUS_TIERS[tier].neighborhood,
        latitude,
        longitude,
        description: `${detail} About ${walkMinutes} minutes on foot to the main quad. Fictional class-demo spot: not a real lot, parking rule, or bookable space.`,
        image: CAMPUS_IMAGES[kind],
        kind,
        amenities: [tier === 'near' ? 'Near campus' : 'Farther away', `${walkMinutes} min walk`],
      },
      minBidEth: CAMPUS_TIERS[tier].minBidEth,
      ...CAMPUS_WINDOW,
      initialBidEth: null,
    }));
}

/**
 * Generates the listings for a seed scenario with real relative timestamps adhering
 * strictly to the contract constraints:
 * - Bidding ends 20-120 minutes from baseTimestamp
 * - Parking starts >= 1h from baseTimestamp and >= bidEnd
 * - Parking ends > parkingStart
 * - Clearly marked local demonstration
 * 'austin' (default) is the 7 sample Austin listings; 'campus-*' are the fictional class-demo campus.
 */
export function getSeededListings(baseTimestamp = Math.floor(Date.now() / 1000), scenario = 'austin') {
  const rawListings = scenario === 'austin' ? AUSTIN_LISTINGS : campusListings(resolveSeedScenario(scenario));
  return rawListings.map((item) => {
    const normalized = normalizeMetadata(item.metadata);
    const metadataHash = computeMetadataHash(normalized);
    const bidEnd = baseTimestamp + item.bidEndMinutes * 60;
    const parkingStart = baseTimestamp + item.parkingStartMinutes * 60;
    const parkingEnd = baseTimestamp + item.parkingEndMinutes * 60;
    const minBidWei = ethers.parseEther(item.minBidEth);

    return {
      fixtureId: item.fixtureId,
      tier: item.tier,
      metadata: normalized,
      metadataHash,
      minBidWei,
      minBidEth: item.minBidEth,
      bidEnd,
      parkingStart,
      parkingEnd,
      initialBidEth: item.initialBidEth,
    };
  });
}

const AUSTIN_LISTINGS = [
  {
    metadata: {
      title: 'South Congress Avenue Paved Driveway [Local Demo]',
      address: '1406 S Congress Ave, Austin, TX 78704',
      neighborhood: 'South Congress (SoCo)',
      latitude: 30.2512,
      longitude: -97.7495,
      description:
        'Private residential driveway directly off South Congress. Walking distance to Continental Club, dining, and boutique shops. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=800&q=80',
      kind: 'driveway',
      amenities: ['Paved Surface', 'Direct Street Access', 'Exterior Lighting', 'Midsize/SUV Friendly'],
    },
    minBidEth: '0.02',
    bidEndMinutes: 30,
    parkingStartMinutes: 75,
    parkingEndMinutes: 315,
    initialBidEth: '0.025',
  },
  {
    metadata: {
      title: 'Downtown Warehouse District Covered Garage [Local Demo]',
      address: '301 Lavaca St, Austin, TX 78701',
      neighborhood: 'Downtown / Warehouse District',
      latitude: 30.2662,
      longitude: -97.7471,
      description:
        'Dedicated private parking space inside secure commercial garage near 3rd and Lavaca. Quick walk to Austin Convention Center and Moody Amphitheater. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=800&q=80',
      kind: 'garage',
      amenities: ['Covered Structure', 'CCTV Security', '6ft 10in Clearance', 'Smooth Paved Concrete'],
    },
    minBidEth: '0.05',
    bidEndMinutes: 45,
    parkingStartMinutes: 90,
    parkingEndMinutes: 330,
    initialBidEth: '0.06',
  },
  {
    metadata: {
      title: 'East 6th Street Private Carport [Local Demo]',
      address: '1104 E 6th St, Austin, TX 78702',
      neighborhood: 'East Austin',
      latitude: 30.2635,
      longitude: -97.7308,
      description:
        'Covered carport space situated behind a restored artist studio on historic East 6th Street. Ideal for evening dinners and entertainment. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?auto=format&fit=crop&w=800&q=80',
      kind: 'covered',
      amenities: ['Overhead Weather Canopy', 'Keyless Alley Access', 'Well-Lit Alleyway', 'Sedan / Hatchback'],
    },
    minBidEth: '0.03',
    bidEndMinutes: 60,
    parkingStartMinutes: 105,
    parkingEndMinutes: 345,
    initialBidEth: null,
  },
  {
    metadata: {
      title: 'Rainey Street Historic District Parking Pad [Local Demo]',
      address: '78 Rainey St, Austin, TX 78701',
      neighborhood: 'Rainey Street',
      latitude: 30.2588,
      longitude: -97.7384,
      description:
        'Private residential parking pad located at the edge of the Rainey Street district and Lady Bird Lake hike-and-bike trail. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1563720223185-11003d516935?auto=format&fit=crop&w=800&q=80',
      kind: 'driveway',
      amenities: ['Ground Level Access', 'Security Floodlight', 'Direct Pull-In', 'Quick Expressway Access'],
    },
    minBidEth: '0.04',
    bidEndMinutes: 75,
    parkingStartMinutes: 120,
    parkingEndMinutes: 360,
    initialBidEth: null,
  },
  {
    metadata: {
      title: 'UT Campus Speedway Residential Driveway [Local Demo]',
      address: '2408 Speedway, Austin, TX 78705',
      neighborhood: 'West Campus / University',
      latitude: 30.2885,
      longitude: -97.7365,
      description:
        'Private driveway space steps away from the University of Texas campus, Darrell K Royal Stadium, and Texas Union. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1621929747188-0b4dc28498d2?auto=format&fit=crop&w=800&q=80',
      kind: 'driveway',
      amenities: ['Wide Driveway', 'Level Asphalt Surface', 'Walking Distance to Stadium', 'Bicycle Lock Anchor'],
    },
    minBidEth: '0.025',
    bidEndMinutes: 90,
    parkingStartMinutes: 135,
    parkingEndMinutes: 375,
    initialBidEth: null,
  },
  {
    metadata: {
      title: 'Zilker Park & Barton Springs Covered Space [Local Demo]',
      address: '2100 Barton Springs Rd, Austin, TX 78704',
      neighborhood: 'Zilker',
      latitude: 30.2642,
      longitude: -97.7712,
      description:
        'Private covered parking spot near Barton Springs pool and Zilker Park greenspace. Avoid festival parking congestion with guaranteed reserved space. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1542282088-72c9c27ed0cd?auto=format&fit=crop&w=800&q=80',
      kind: 'covered',
      amenities: ['Covered Carport', 'Shaded Protection', 'SUV Friendly', 'Quiet Residential Lane'],
    },
    minBidEth: '0.035',
    bidEndMinutes: 105,
    parkingStartMinutes: 150,
    parkingEndMinutes: 390,
    initialBidEth: null,
  },
  {
    metadata: {
      title: 'Mueller Town Center Gated Residential Bay [Local Demo]',
      address: '1901 Aldrich St, Austin, TX 78723',
      neighborhood: 'Mueller',
      latitude: 30.2995,
      longitude: -97.7055,
      description:
        'Dedicated private space inside secure residential parking structure on Aldrich Street. Walk to Mueller Lake Park, farmers market, and Aldrich promenade dining. Local demonstration prototype.',
      image: 'https://images.unsplash.com/photo-1517524008697-84bbe3c3fd98?auto=format&fit=crop&w=800&q=80',
      kind: 'garage',
      amenities: ['Secured Gate Access', 'Overhead Protection', 'Wide Vehicle Bay', 'EV Charging Nearby'],
    },
    minBidEth: '0.02',
    bidEndMinutes: 120,
    parkingStartMinutes: 165,
    parkingEndMinutes: 405,
    initialBidEth: null,
  },
];
