import { describe, expect, it } from 'vitest';
import type { Listing } from '../src/types';
import type { AuctionEvent } from '../src/services/api';
import { buildHistoryRows, filterHistory, historyLink, pageOf, readHistoryLink } from '../src/utils/history';

const ME = '0x00000000000000000000000000000000000000a1';
const RIVAL = '0x00000000000000000000000000000000000000b2';
const now = 1_000_000;
const l = (id: string, over: Partial<Listing> = {}): Listing => ({
  id, spaceId: '1', timeZone: 'America/Chicago', owner: '0xc3', minBid: '0.05', highestBid: '0.08', highestBidder: RIVAL,
  bidEnd: now - 100, parkingStart: now + 1000, parkingEnd: now + 5000, settled: false, cancelled: false, payoutClaimed: false,
  metadataHash: '0x1', title: `Spot ${id}`, address: `${id} Demo St`, neighborhood: 'Demo', latitude: 0, longitude: 0, description: '',
  image: '', kind: 'driveway', amenities: [], booking: null, ...over,
});
const bid = (auctionId: string, account: string, blockNumber: number, amount = '0.05'): AuctionEvent => ({
  event: 'BidPlaced', auctionId, account, amount, blockNumber, logIndex: 0, txHash: '0x', blockTime: 1000 + blockNumber,
});
const deployment = { chainId: 31337, contractAddress: '0xAbC0000000000000000000000000000000000001' };

describe('history rows', () => {
  const events = [bid('1', ME, 5), bid('1', RIVAL, 6, '0.09'), bid('2', ME, 7), bid('3', RIVAL, 8)];
  const rows = buildHistoryRows(events, [l('1'), l('2', { highestBidder: ME, settled: true }), l('3')], ME, now);

  it('lists auctions the wallet bid on, including lost ones, newest first, and not others', () => {
    expect(rows.map((r) => r.auctionId)).toEqual(['2', '1']);
    expect(rows[1].lifecycle?.label).toBe('Outbid, another bidder won');
    expect(rows[1].lastBid).toBe('0.05');
    expect(rows[0].lifecycle?.state).toBe('upcoming');
  });
  it('keeps a bid known only from the contract, with no lifecycle if the listing is unknown', () => {
    const r = buildHistoryRows([], [], ME, now, new Set(['9']));
    expect(r).toHaveLength(1);
    expect(r[0].lifecycle).toBeNull();
  });
  it('searches by id, title, address and state, and filters by state', () => {
    expect(filterHistory(rows, '#1').map((r) => r.auctionId)).toEqual(['1']);
    const many = [...rows, ...['10', '11', '21'].map((id) => ({ ...rows[0], auctionId: id }))];
    expect(filterHistory(many, '#1').map((r) => r.auctionId)).toEqual(['1']);
    expect(filterHistory(rows, 'spot 2').map((r) => r.auctionId)).toEqual(['2']);
    expect(filterHistory(rows, 'outbid').map((r) => r.auctionId)).toEqual(['1']);
    expect(filterHistory(rows, '', 'upcoming').map((r) => r.auctionId)).toEqual(['2']);
    expect(filterHistory(rows, 'nothing here')).toEqual([]);
  });
  it('paginates and clamps the page', () => {
    const items = Array.from({ length: 19 }, (_, i) => i);
    expect(pageOf(items, 1)).toMatchObject({ page: 1, pages: 3, items: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(pageOf(items, 9)).toMatchObject({ page: 3, items: [16, 17, 18] });
    expect(pageOf([], 1)).toMatchObject({ page: 1, pages: 1, items: [] });
  });
});

describe('history links', () => {
  it('round-trips on the same network and contract, ignoring address case', () => {
    expect(readHistoryLink(historyLink(deployment, '7'), deployment)).toEqual({ auctionId: '7' });
  });
  it('rejects a link for another chain or contract', () => {
    const link = historyLink(deployment, '7');
    expect(readHistoryLink(link, { ...deployment, chainId: 11155111 })).toBe('mismatch');
    expect(readHistoryLink(link, { ...deployment, contractAddress: '0x0000000000000000000000000000000000000002' })).toBe('mismatch');
    expect(readHistoryLink(link, null)).toBe('mismatch');
  });
  it('ignores unrelated or malformed queries', () => {
    expect(readHistoryLink('?q=garage', deployment)).toBeNull();
    expect(readHistoryLink('?tab=activity&auction=abc&chain=31337', deployment)).toBeNull();
  });
});
