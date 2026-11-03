import type { DemoAccount } from '../types';

export const HARDHAT_CHAIN_ID = 31337;
export const HARDHAT_CHAIN_HEX = '0x7a69';

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    index: 1,
    label: 'Account #1 (Buyer)',
    role: 'Primary Test Bidder',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  {
    index: 0,
    label: 'Account #0 (Vendor / Seeds)',
    role: 'Contract Deployer & Host',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  },
  {
    index: 2,
    label: 'Account #2 (Competitor)',
    role: 'Second Test Bidder',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
  {
    index: 3,
    label: 'Account #3 (Driver)',
    role: 'Third Test Bidder',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
] as const;

export const AUSTIN_PRESET_LOCATIONS = [
  {
    name: 'Downtown / 6th St',
    neighborhood: 'Downtown Austin',
    address: '410 E 6th St, Austin, TX 78701',
    latitude: 30.2676,
    longitude: -97.7397,
  },
  {
    name: 'Moody Center / Campus',
    neighborhood: 'University / Red River',
    address: '2001 Robert Dedman Dr, Austin, TX 78712',
    latitude: 30.2818,
    longitude: -97.7322,
  },
  {
    name: 'South Congress (SoCo)',
    neighborhood: 'South Congress',
    address: '1500 S Congress Ave, Austin, TX 78704',
    latitude: 30.2505,
    longitude: -97.7495,
  },
  {
    name: 'Rainey Street District',
    neighborhood: 'Rainey Historic District',
    address: '70 Rainey St, Austin, TX 78701',
    latitude: 30.2592,
    longitude: -97.7383,
  },
  {
    name: 'Zilker Park / Barton Springs',
    neighborhood: 'Zilker / Barton Springs',
    address: '2100 Barton Springs Rd, Austin, TX 78704',
    latitude: 30.2638,
    longitude: -97.7712,
  },
  {
    name: 'East Austin Arts District',
    neighborhood: 'East Austin',
    address: '1209 E 7th St, Austin, TX 78702',
    latitude: 30.2647,
    longitude: -97.7291,
  },
] as const;

export const CURATED_PARKING_PHOTOS = [
  {
    title: 'Modern Covered Carport',
    url: 'https://images.unsplash.com/photo-1590674899484-d5640e854abe?auto=format&fit=crop&w=900&q=80',
    kind: 'covered' as const,
  },
  {
    title: 'Private Gated Residential Driveway',
    url: 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=900&q=80',
    kind: 'driveway' as const,
  },
  {
    title: 'Secure Access Downtown Garage',
    url: 'https://images.unsplash.com/photo-1617814076367-b759c7d7e738?auto=format&fit=crop&w=900&q=80',
    kind: 'garage' as const,
  },
  {
    title: 'Paved Driveway with Shade Tree',
    url: 'https://images.unsplash.com/photo-1584464491033-06628f3a6b7b?auto=format&fit=crop&w=900&q=80',
    kind: 'driveway' as const,
  },
  {
    title: 'Protected Canopy Parking Stall',
    url: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?auto=format&fit=crop&w=900&q=80',
    kind: 'covered' as const,
  },
  {
    title: 'Attached Private Home Garage',
    url: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=900&q=80',
    kind: 'garage' as const,
  },
] as const;

export const COMMON_AMENITIES = [
  'EV Charging Level 2',
  'Gated Entry',
  '24/7 Access',
  'Covered Stall',
  'Wide SUV Friendly',
  'Security Camera',
  'Paved Concrete',
  'Well Lit',
  'Easy Turnaround',
  'Keyless Pin Pad',
] as const;
