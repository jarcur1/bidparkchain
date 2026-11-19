import { describe, expect, it } from 'vitest';
import type { Listing } from '../../src/types';
import { bookingView, canClaimPayout } from '../../src/utils/booking';

const HOST = '0x00000000000000000000000000000000000000aa';
const WINNER = '0x00000000000000000000000000000000000000bb';
const OTHER = '0x00000000000000000000000000000000000000cc';
const S = 1_000_000;
const E = S + 7200;
const listing = (over: Partial<Listing> = {}, booking: Partial<NonNullable<Listing['booking']>> = {}): Listing => ({
  id: '1', spaceId: '1', timeZone: '', owner: HOST, minBid: '0.01', highestBid: '0.05', highestBidder: WINNER,
  bidEnd: S - 2 * 86400, parkingStart: S, parkingEnd: E, settled: true, cancelled: false, payoutClaimed: false,
  metadataHash: '0x', title: 't', address: 'a', neighborhood: 'n', latitude: 0, longitude: 0, description: '',
  image: '', kind: 'driveway', amenities: [],
  booking: { protected: true, outcome: 'none', lateCancelled: false, noShowRecorded: false, disputeReporter: null, ...booking },
  ...over,
});

describe('protected booking view', () => {
  it('returns nothing for version 1 auctions', () => {
    expect(bookingView(listing({ booking: null }), WINNER, S - 100)).toBeNull();
    expect(bookingView(listing({}, { protected: false }), WINNER, S - 100)).toBeNull();
  });

  it('offers each party only the actions the contract allows at that time', () => {
    expect(bookingView(listing(), WINNER, S - 86400).actions).toEqual(['cancelBooking', 'reportSellerFailure']);
    expect(bookingView(listing(), WINNER, S - 86400).status).toContain('full refund until 24 hours');
    expect(bookingView(listing(), WINNER, S - 86399).status).toContain('recorded but not refunded');
    expect(bookingView(listing(), HOST, S - 1).actions).toEqual(['hostCancelBooking', 'reportSellerFailure']);
    expect(bookingView(listing(), HOST, S + 1800).actions).toEqual(['recordNoShow', 'reportSellerFailure']);
    expect(bookingView(listing(), OTHER, S - 1).actions).toEqual([]);
    expect(bookingView(listing({}, { disputeReporter: WINNER }), OTHER, E).actions).toEqual(['upholdDispute', 'denyDispute']);
    expect(bookingView(listing({}, { disputeReporter: WINNER }), WINNER, E + 72 * 3600).actions).toEqual(['expireDispute']);
    expect(bookingView(listing({ settled: false }), OTHER, S).actions).toEqual(['expire']);
    expect(bookingView(listing({ settled: false }), HOST, S - 1).actions).toEqual(['hostCancelBooking']);
    expect(bookingView(listing({ cancelled: true }, { outcome: 'host-cancelled' }), WINNER, S).status).toContain('credited back to the winner');
  });

  it('holds the host payout until 24 hours after parking ends and while a report is open', () => {
    expect(canClaimPayout(listing(), E + 86399)).toBe(false);
    expect(canClaimPayout(listing(), E + 86400)).toBe(true);
    expect(canClaimPayout(listing({}, { disputeReporter: WINNER }), E + 86400)).toBe(false);
    expect(canClaimPayout(listing({ booking: null }), E)).toBe(true);
  });
});
