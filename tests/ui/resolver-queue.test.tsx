import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResolverQueue } from '../../src/components/Disputes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Thirty open reports: the first page (25) leaves five for Load more.
const openIds = Array.from({ length: 30 }, (_, i) => String(i + 1));
// Serves the paging contract of GET /api/disputes/queue for the ids above.
const queuePage = (url: string) => {
  const params = new URL(url, 'http://localhost').searchParams;
  const limit = Math.min(100, Number(params.get('limit')));
  const start = params.has('after') ? openIds.findIndex((id) => Number(id) > Number(params.get('after'))) : 0;
  const page = start < 0 ? [] : openIds.slice(start, start + limit);
  return {
    nextAfter: start >= 0 && start + limit < openIds.length ? page[page.length - 1] : null,
    items: page.map((auctionId) => ({
      auctionId, title: 'Garage', reporter: '0x0000000000000000000000000000000000000001', parkingEnd: 1000,
      resolveBy: 1000 + 72 * 3600, hasRecord: true, isParty: false, action: 'expireDispute',
    })),
  };
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const rows = () => host.querySelectorAll('li[data-auction-id]');
const button = (row: string | null, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(row === null ? 'button' : `li[data-auction-id="${row}"] button`)]
    .find((b) => b.textContent === name);

it('shows a page, appends the next on Load more, and reloads the extent shown after a decision', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(queuePage(String(input)))));
  const onAct = vi.fn(async () => {});
  await act(async () => root.render(<ResolverQueue nowSec={1000} busy={false} onAct={onAct} />));
  expect(rows()).toHaveLength(25);
  expect(host.querySelector('[data-testid="resolver-queue-count"]')?.textContent).toBe('Showing 25 open reports, more may follow.');

  await act(async () => button(null, 'Load more')!.click());
  expect(rows()).toHaveLength(30);
  expect(host.querySelector('[data-testid="resolver-queue-count"]')?.textContent).toBe('Showing 30 open reports.');
  expect(button(null, 'Load more')).toBeUndefined();

  await act(async () => button('7', 'Expire report and refund winner')!.click());
  expect(onAct).toHaveBeenCalledWith('7', 'expireDispute', '');
  // The reload walks pages back to the extent already shown, so the list stays at 30.
  expect(fetchMock.mock.lastCall?.[0]).toBe('/api/disputes/queue?limit=100');
  expect(rows()).toHaveLength(30);
});
