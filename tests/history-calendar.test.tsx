import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '../src/types';
import { formatDateTime, formatParkingWindow } from '../src/utils/formatters';
import { reservationIcs } from '../src/utils/calendar';
import { BidHistory } from '../src/components/BidHistory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHI = 'America/Chicago';
const at = (iso: string) => Date.parse(iso) / 1000;

describe('date and time-zone display', () => {
  it('names the time zone', () => {
    expect(formatDateTime(at('2026-11-19T07:27:00Z'), CHI)).toBe('Thu, Nov 19, 1:27 AM CST');
  });

  it('keeps a same-day window compact', () => {
    const w = formatParkingWindow(at('2026-11-19T19:00:00Z'), at('2026-11-19T21:30:00Z'), CHI);
    expect(w.full).toBe('Thu, Nov 19, 1:00 PM – 3:30 PM CST');
    expect(w.durationHours).toBe('2.5 hrs');
  });

  it('shows both dates for an overnight window', () => {
    const w = formatParkingWindow(at('2026-11-20T05:00:00Z'), at('2026-11-20T08:00:00Z'), CHI);
    expect(w.dateStr).toBe('Thu, Nov 19 – Fri, Nov 20');
    expect(w.full).toBe('Thu, Nov 19, 11:00 PM CST – Fri, Nov 20, 2:00 AM CST');
  });

  it('names both zones across a DST change', () => {
    // 2026-11-01 02:00 CDT falls back to 01:00 CST.
    const w = formatParkingWindow(at('2026-11-01T06:00:00Z'), at('2026-11-01T08:00:00Z'), CHI);
    expect(w.timeRange).toBe('1:00 AM CDT – 2:00 AM CST');
    expect(w.durationHours).toBe('2 hrs');
  });

  it('falls back to the viewer zone for an unset or unknown space time zone', () => {
    const sec = at('2026-11-19T07:27:00Z');
    expect(formatDateTime(sec, 'Not/AZone')).toBe(formatDateTime(sec));
    expect(formatParkingWindow(sec, sec + 3600, '').full).toBe(formatParkingWindow(sec, sec + 3600).full);
    expect(formatDateTime(sec, 'Asia/Tokyo')).toBe('Thu, Nov 19, 4:27 PM GMT+9');
  });
});

describe('reservation calendar export', () => {
  const listing = {
    id: '7', title: 'Garage; level 2, spot A', address: '100 Main St, Austin',
    parkingStart: at('2026-11-20T05:00:00Z'), parkingEnd: at('2026-11-20T08:00:00Z'),
  };
  const ics = reservationIcs(listing, { chainId: 31337, contractAddress: '0xABCDEF' }, at('2026-11-19T00:00:00Z'));

  it('writes UTC instants, a stable UID and escaped text with CRLF lines', () => {
    const lines = ics.split('\r\n');
    expect(lines).toContain('DTSTART:20261120T050000Z');
    expect(lines).toContain('DTEND:20261120T080000Z');
    expect(lines).toContain('DTSTAMP:20261119T000000Z');
    expect(lines).toContain('UID:31337-0xabcdef-7@bidpark');
    expect(lines).toContain('SUMMARY:Parking: Garage\\; level 2\\, spot A');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('folds long lines to 75 octets', () => {
    const long = reservationIcs({ ...listing, title: 'é'.repeat(80) }, { chainId: 1, contractAddress: '0x1' });
    for (const line of long.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(long.replace(/\r\n /g, '')).toContain(`SUMMARY:Parking: ${'é'.repeat(80)}`);
  });

  it('leaves out private and descriptive fields', () => {
    expect(ics).not.toMatch(/DESCRIPTION:.*(access|code|gate)/i);
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).not.toContain('ORGANIZER');
  });
});

describe('bid history', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    vi.restoreAllMocks();
  });

  const listing = { id: '1', highestBid: '0.03' } as Listing;
  const bid = (amount: string, blockNumber: number) => ({
    event: 'BidPlaced', account: '0x00000000000000000000000000000000000000b1', amount, blockNumber, logIndex: 0, txHash: '0x1',
  });
  const respond = (...bodies: Array<object | Error>) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const body of bodies) {
      fetchMock.mockImplementationOnce(async () =>
        body instanceof Error ? new Response('{"error":"down"}', { status: 503 }) : new Response(JSON.stringify(body)));
    }
    return fetchMock;
  };
  const render = async (l: Listing) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<BidHistory listing={l} currentAddress="0x00000000000000000000000000000000000000B1" />));
  };
  const text = () => host.querySelector('[data-testid="bid-history"]')!.textContent;

  it('lists canonical bids and marks the viewer', async () => {
    respond({ indexedBlock: 9, syncError: null, events: [bid('0.02', 5), bid('0.03', 6)] });
    await render(listing);
    expect(host.querySelectorAll('.bid-history-row')).toHaveLength(2);
    expect(text()).toContain('0.030 ETH');
    expect(text()).toContain('(you)');
    expect(text()).not.toMatch(/out of date|catching up|unavailable/);
  });

  it('says no bids only when the index has run', async () => {
    respond({ indexedBlock: 9, syncError: null, events: [] });
    await render({ ...listing, highestBid: '0' });
    expect(text()).toContain('No bids yet.');
  });

  it('does not present an unindexed history as empty', async () => {
    respond({ indexedBlock: null, syncError: null, events: [] });
    await render({ ...listing, highestBid: '0' });
    expect(text()).toContain('not been indexed yet');
    expect(text()).not.toContain('No bids yet.');
  });

  it('flags a history that lags the on-chain highest bid', async () => {
    respond({ indexedBlock: 9, syncError: null, events: [bid('0.02', 5)] });
    await render(listing);
    expect(text()).toContain('catching up');
  });

  it('marks a failed first read as unavailable, not empty', async () => {
    respond(new Error('down'));
    await render(listing);
    expect(text()).toContain('unavailable');
    expect(text()).not.toContain('No bids yet.');
  });

  it('keeps the last history and marks it stale when a refresh fails', async () => {
    vi.useFakeTimers();
    try {
      respond({ indexedBlock: 9, syncError: null, events: [bid('0.03', 6)] }, new Error('down'));
      await render(listing);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(text()).toContain('out of date');
      expect(host.querySelectorAll('.bid-history-row')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
