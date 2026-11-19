import { describe, expect, it } from 'vitest';
import type { Listing } from '../src/types';
import { reservationLifecycle as life, zoneNote } from '../src/utils/lifecycle';

const ME = '0x00000000000000000000000000000000000000a1';
const RIVAL = '0x00000000000000000000000000000000000000b2';
const now = 1_000_000;
const booking = (over = {}) => ({ protected: true, outcome: 'none' as const, lateCancelled: false, noShowRecorded: false, disputeReporter: null, ...over });
const l = (over: Partial<Listing> = {}): Listing => ({
  id: '1', spaceId: '1', timeZone: 'America/Chicago', owner: '0xc3', minBid: '0.05', highestBid: '0.08', highestBidder: ME,
  bidEnd: now - 100, parkingStart: now + 1000, parkingEnd: now + 5000, settled: false, cancelled: false, payoutClaimed: false,
  metadataHash: '0x1', title: 't', address: 'a', neighborhood: 'n', latitude: 0, longitude: 0, description: '', image: '', kind: 'driveway',
  amenities: [], booking: booking(), ...over,
});

describe('reservationLifecycle', () => {
  it('leading while bidding is open', () => expect(life(l({ bidEnd: now + 10 }), ME, now)?.state).toBe('leading'));
  it('awaiting settlement after the cutoff', () => expect(life(l(), ME, now)?.state).toBe('awaiting-settlement'));
  it('expired (refund due) for a protected win unsettled at parking start', () => {
    expect(life(l({ parkingStart: now - 1 }), ME, now)?.label).toBe('Expired, refund due');
  });
  it('a version 1 win stays awaiting settlement after parking starts', () => {
    expect(life(l({ parkingStart: now - 1, booking: booking({ protected: false }) }), ME, now)?.state).toBe('awaiting-settlement');
  });
  it('upcoming, in progress and completed from the settled window', () => {
    expect(life(l({ settled: true }), ME, now)?.state).toBe('upcoming');
    expect(life(l({ settled: true, parkingStart: now }), ME, now)?.state).toBe('in-progress');
    expect(life(l({ settled: true, parkingStart: now - 10, parkingEnd: now }), ME, now)?.state).toBe('completed');
  });
  it('completed once the host is paid', () => {
    expect(life(l({ settled: true, payoutClaimed: true }), ME, now)?.label).toBe('Completed, host paid');
  });
  it('disputed while a report is open', () => {
    expect(life(l({ settled: true, booking: booking({ disputeReporter: RIVAL }) }), ME, now)?.state).toBe('disputed');
  });
  it('says a late cancellation is not a refund', () => {
    expect(life(l({ settled: true, booking: booking({ lateCancelled: true }) }), ME, now)?.detail).toContain('does not refund');
  });
  it('cancelled-refunded for each refund outcome, expired for expiry', () => {
    for (const outcome of ['winner-cancelled', 'host-cancelled', 'dispute-upheld', 'dispute-expired'] as const) {
      expect(life(l({ cancelled: true, booking: booking({ outcome }) }), ME, now)?.state).toBe('cancelled-refunded');
    }
    expect(life(l({ cancelled: true, booking: booking({ outcome: 'expired' }) }), ME, now)?.state).toBe('expired');
  });
  it('does not claim a refund when the cancellation outcome is unknown', () => {
    expect(life(l({ cancelled: true, booking: null }), ME, now)?.label).toBe('Cancelled');
  });
  it('outbid only for a known bidder, open or lost', () => {
    expect(life(l({ highestBidder: RIVAL }), ME, now)).toBeNull();
    expect(life(l({ highestBidder: RIVAL, bidEnd: now + 5 }), ME, now, true)?.label).toBe('Outbid, bidding open');
    expect(life(l({ highestBidder: RIVAL }), ME, now, true)?.label).toBe('Outbid, another bidder won');
  });
  it('names the zone used', () => {
    expect(zoneNote('America/Chicago')).toContain('America/Chicago');
    expect(zoneNote('')).toContain('your time zone');
  });
});
