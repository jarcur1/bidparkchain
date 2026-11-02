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

/**
 * Generates 7 diverse, realistic Austin private parking spot listings
 * with real relative timestamps adhering strictly to the contract constraints:
 * - Bidding ends 20-120 minutes from baseTimestamp
 * - Parking starts >= 1h from baseTimestamp and >= bidEnd
 * - Parking ends > parkingStart
 * - Clearly marked local demonstration
 */
export function getSeededListings(baseTimestamp = Math.floor(Date.now() / 1000)) {
  const rawListings = [
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

  return rawListings.map((item) => {
    const normalized = normalizeMetadata(item.metadata);
    const metadataHash = computeMetadataHash(normalized);
    const bidEnd = baseTimestamp + item.bidEndMinutes * 60;
    const parkingStart = baseTimestamp + item.parkingStartMinutes * 60;
    const parkingEnd = baseTimestamp + item.parkingEndMinutes * 60;
    const minBidWei = ethers.parseEther(item.minBidEth);

    return {
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
