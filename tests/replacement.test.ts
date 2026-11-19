import { describe, expect, it } from 'vitest';
import { changePath } from '../src/utils/replacement';
import type { Listing } from '../src/types';

const HOST = '0x00000000000000000000000000000000000000aa';
const base = {
  id: '7', owner: HOST, highestBid: '0', settled: false, cancelled: false, bidEnd: 1000, parkingStart: 2000, parkingEnd: 3000,
  booking: { protected: false, outcome: 'none' },
} as unknown as Listing;
const L = (over: object) => ({ ...base, ...over }) as Listing;

describe('changePath', () => {
  it('offers a free cancel when nothing has been bid', () => {
    expect(changePath(base, HOST, 500)).toMatchObject({ action: 'cancel', hasBids: false });
  });
  it('offers no path for a standard auction with a bid, and says the bid stands', () => {
    const p = changePath(L({ highestBid: '0.5' }), HOST, 1500);
    expect(p.action).toBeNull();
    expect(p.consequence).toContain('bid stands');
  });
  it('offers the booking withdrawal only after bidding closes, with the refund stated', () => {
    const protectedBid = L({ highestBid: '0.5', highestBidder: '0x00000000000000000000000000000000000000cc', booking: { protected: true, outcome: 'none' } });
    expect(changePath(protectedBid, HOST, 500).action).toBeNull();
    const p = changePath(protectedBid, HOST, 1500);
    expect(p.action).toBe('hostCancelBooking');
    expect(p.consequence).toContain('0.5 ETH');
    expect(p.consequence).toContain('receive nothing');
    expect(changePath(protectedBid, HOST, 2500).action).toBeNull();
  });
  it('offers nothing to another wallet or for a cancelled auction', () => {
    expect(changePath(base, '0x00000000000000000000000000000000000000bb', 500).action).toBeNull();
    expect(changePath(L({ cancelled: true }), HOST, 500).action).toBeNull();
  });
});
