import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActivityView } from '../src/components/ActivityView';
import type { Listing } from '../src/types';
import { LOADING_READ, readFailed, readSucceeded, type ReadState } from '../src/utils/readState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '0x00000000000000000000000000000000000000a1';
const RIVAL = '0x00000000000000000000000000000000000000b2';
const now = Math.floor(Date.now() / 1000);

const listing = (id: string, over: Partial<Listing>): Listing => ({
  id, owner: '0x00000000000000000000000000000000000000c3', minBid: '0.05', highestBid: '0.08',
  highestBidder: RIVAL, bidEnd: now + 3600, parkingStart: now + 7200, parkingEnd: now + 9000,
  settled: false, cancelled: false, payoutClaimed: false, metadataHash: `0x${id}`,
  title: `Spot ${id}`, address: `${id} Demo St`, neighborhood: 'Demo', latitude: 0, longitude: 0,
  description: 'A demo spot.', image: '/x.jpg', kind: 'driveway', amenities: [], ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(listings: Listing[], bidIds: Set<string> | null, listingsRead: ReadState = readSucceeded()) {
  const noop = vi.fn(async () => {});
  act(() => root.render(
    <ActivityView
      currentAddress={ME}
      listings={listings}
      claimableRefundWei={60000000000000000n}
      refundRead={readSucceeded()}
      myBidAuctionIds={bidIds}
      listingsRead={listingsRead}
      onRetryRefund={vi.fn()}
      onWithdrawRefund={noop}
      onSettleListing={noop}
      onCancelListing={noop}
      onClaimPayoutListing={noop}
      onOpenListingDetail={vi.fn()}
      onOpenBid={vi.fn()}
      onConnectWallet={vi.fn()}
      isActionBusy={false}
    />,
  ));
  return container.textContent ?? '';
}

it('names leading, outbid, pending and confirmed results in text', () => {
  const text = show([
    listing('1', {}),
    listing('2', { highestBidder: ME }),
    listing('3', { bidEnd: now - 60 }),
    listing('4', { bidEnd: now - 60, highestBidder: ME }),
    listing('5', { bidEnd: now - 60, highestBidder: ME, settled: true }),
    listing('6', {}),
  ], new Set(['1', '2', '3', '4', '5']));
  expect(text).toContain('Outbid (2)');
  expect(text).toContain('Outbid — bidding still open');
  expect(text).toContain('Outbid — another bidder won (pending settlement)');
  expect(text).not.toContain('Spot 6');
  expect(text).toContain('You are leading');
  expect(text).toContain('You won — pending settlement');
  expect(text).toContain('You won — confirmed on-chain');
  expect(text).toContain('does not grant access to any real space');
  expect(text).toContain('Withdraw 0.060 ETH');
});

it('offers a direct Connect Wallet action when no wallet is connected', () => {
  const onConnectWallet = vi.fn();
  act(() => root.render(
    <ActivityView currentAddress={null} listings={[]} claimableRefundWei={null} refundRead={LOADING_READ}
      myBidAuctionIds={null} listingsRead={LOADING_READ} onRetryRefund={vi.fn()} onWithdrawRefund={vi.fn()}
      onSettleListing={vi.fn()} onCancelListing={vi.fn()} onClaimPayoutListing={vi.fn()} onOpenListingDetail={vi.fn()}
      onOpenBid={vi.fn()} onConnectWallet={onConnectWallet} isActionBusy={false} />,
  ));
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect Wallet')!;
  act(() => button.click());
  expect(onConnectWallet).toHaveBeenCalledOnce();
});

it('never shows unknown listings or bid history as an empty account', () => {
  let text = show([], null, readFailed(LOADING_READ, new Error('down')));
  expect(text).toContain('Auction status unavailable');
  expect(text).not.toContain('No active leading bids');
  expect(text).not.toContain('Confirmed Reservations (0)');

  text = show([listing('1', {})], null);
  expect(text).toContain('Bid history unavailable');
  expect(text).not.toContain('Not outbid on any auction');
  expect(text).toContain('Withdraw 0.060 ETH');

  text = show([listing('1', {})], new Set());
  expect(text).toContain('Not outbid on any auction');
  expect(text).toContain('Outbid (0)');
});
