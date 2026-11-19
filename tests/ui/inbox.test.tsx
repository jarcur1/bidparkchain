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
  data, error: null, markRead: vi.fn(async () => {}), reload: vi.fn(async () => {}), ...over,
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
