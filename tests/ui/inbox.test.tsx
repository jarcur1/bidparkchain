import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Inbox, inboxNotice, type InboxResponse, type InboxState } from '../../src/components/Inbox';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const index = { indexedBlock: 40, headBlock: 40, lagBlocks: 0, lastSyncAt: 1, lastSyncError: null };
const item = (id: string, kind: InboxResponse['items'][number]['kind'], read = false) => ({
  id, kind, auctionId: kind === 'refund' ? null : '7', title: 'Garage', amount: '0.02', blockNumber: 1, txHash: '0x', read,
});
const data: InboxResponse = { items: [item('a', 'outbid'), item('b', 'refund', true), item('c', 'won')], unread: 2, index };
const state = (over: Partial<InboxState> = {}): InboxState => ({
  data, error: null, markRead: vi.fn(async () => {}), dismiss: vi.fn(async () => {}), setHidden: vi.fn(async () => {}),
  reload: vi.fn(async () => {}), ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('lists entries with unread state, links listings and marks entries read', () => {
  const inbox = state();
  const onOpenListing = vi.fn();
  act(() => root.render(<Inbox inbox={inbox} onOpenListing={onOpenListing} />));
  const text = host.textContent ?? '';
  expect(text).toContain('Inbox (2 unread)');
  expect(text).toContain('You were outbid on "Garage". Your 0.02 ETH bid was credited to your refund balance.');
  expect(text).toContain('You withdrew 0.02 ETH of refunds to your wallet.');
  expect(host.querySelectorAll('.is-unread')).toHaveLength(2);
  const button = (name: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent === name);
  act(() => button('Mark all read')[0].click());
  expect(inbox.markRead).toHaveBeenCalledWith(['a', 'c']);
  act(() => button('Mark read')[0].click());
  expect(inbox.markRead).toHaveBeenLastCalledWith(['a']);
  act(() => button('View listing')[0].click());
  expect(onOpenListing).toHaveBeenCalledWith('7');
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('says when the inbox is unavailable, stale or behind instead of showing it as current', () => {
  expect(inboxNotice({ data: null, error: 'Not signed in' })).toBe('Inbox unavailable: Not signed in');
  expect(inboxNotice({ data, error: 'Failed to fetch' })).toContain('Showing the last entries loaded');
  expect(inboxNotice({ data: { ...data, index: { ...index, indexedBlock: null } }, error: null })).toContain('not been indexed yet');
  expect(inboxNotice({ data: { ...data, index: { ...index, lastSyncError: 'Index sync failed' } }, error: null })).toContain('update failed');
  expect(inboxNotice({ data: { ...data, index: { ...index, lagBlocks: 3 } }, error: null })).toContain('3 blocks behind');
  expect(inboxNotice({ data, error: null })).toBeNull();

  const inbox = state({ data: null, error: 'Inbox request failed (503)' });
  act(() => root.render(<Inbox inbox={inbox} onOpenListing={() => {}} />));
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Inbox unavailable: Inbox request failed (503)');
  expect(host.textContent).not.toContain('No notifications yet');
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click());
  expect(inbox.reload).toHaveBeenCalled();
});

it('describes booking and reservation entries by role and links them to arrival details and history', () => {
  const deployment = { chainId: 31337, contractAddress: '0xABC' };
  const entries: InboxResponse['items'] = [
    { id: 'arrival:7', kind: 'arrival', category: 'reservations', auctionId: '7', title: 'Garage', hasInstructions: true, parkingStart: 1, parkingEnd: 2, read: false },
    { id: 'checkin:7', kind: 'checked-in', category: 'reservations', auctionId: '7', title: 'Garage', checkedInAt: 1_700_000_000_000, read: true },
    { id: 'n', kind: 'booking', category: 'bookings', change: 'no-show', role: 'winner', byMe: false, auctionId: '7', title: 'Garage', read: false },
    { id: 'd', kind: 'booking', category: 'bookings', change: 'dispute-opened', role: 'host', byMe: true, auctionId: '7', title: 'Garage', read: true },
    { id: 'u', kind: 'booking', category: 'bookings', change: 'dispute-upheld', role: 'host', byMe: false, auctionId: '7', title: 'Garage', read: true },
  ];
  const inbox = state({ data: { items: entries, unread: 2, preferences: { hidden: [] }, index } });
  const onOpenListing = vi.fn();
  act(() => root.render(<Inbox inbox={inbox} onOpenListing={onOpenListing} deployment={deployment} timeZoneOf={() => 'America/Chicago'} />));
  const rows = [...host.querySelectorAll('li')].map((li) => li.textContent ?? '');
  expect(rows[0]).toContain('Arrival instructions for "Garage" are available.');
  expect(rows[1]).toContain('The winner checked in for "Garage" at Tue, Nov 14, 4:13 PM CST.');
  expect(rows[2]).toContain('The host recorded a no-show for "Garage". This is an attestation only');
  expect(rows[3]).toContain('You reported a seller failure for "Garage".');
  expect(rows[4]).toContain('A resolver upheld the seller-failure report for "Garage".');
  expect(rows.join('')).not.toContain('Gate code');

  const first = host.querySelectorAll('li')[0];
  const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)!;
  act(() => button(first, 'Arrival details').click());
  expect(onOpenListing).toHaveBeenCalledWith('7');
  expect(first.querySelector('a')?.getAttribute('href')).toBe('?tab=activity&chain=31337&contract=0xabc&auction=7');
  act(() => button(first, 'Dismiss').click());
  expect(inbox.dismiss).toHaveBeenCalledWith(['arrival:7']);
});

it('saves category preferences and says when hidden categories leave the inbox empty', () => {
  const inbox = state({ data: { items: [], unread: 0, preferences: { hidden: ['funds'] }, index } });
  act(() => root.render(<Inbox inbox={inbox} onOpenListing={() => {}} />));
  expect(host.textContent).toContain('1 category is hidden in your preferences.');
  expect(host.textContent).toContain('There are no email, SMS or push notifications.');
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.map((box) => [box.parentElement?.textContent?.trim(), box.checked])).toEqual([
    ['Outbids and wins', true], ['Upcoming reservations and check-ins', true],
    ['Booking changes and reports', true], ['Refunds and payouts', false],
  ]);
  act(() => boxes[2].click());
  expect(inbox.setHidden).toHaveBeenLastCalledWith(['funds', 'bookings']);
  act(() => boxes[3].click());
  expect(inbox.setHidden).toHaveBeenLastCalledWith([]);
});

it('says when reservation entries could not be checked', () => {
  expect(inboxNotice({ data: { ...data, index: { ...index, reservationsError: 'Reservation times could not be read from the chain' } }, error: null }))
    .toBe('Reservation times could not be read from the chain, so upcoming reservation entries may be missing.');
});
