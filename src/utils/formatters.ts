import { formatEther } from 'ethers';
import type { Listing } from '../types';
import { getChainNowSec, isAuctionOpen } from './eligibility';
import type { ReadState } from './readState';

export function shortenAddress(address?: string | null, chars = 4): string {
  if (!address) return '';
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

export function formatEth(val?: string | number | bigint | null): string {
  if (val === undefined || val === null) return '0.00';
  if (typeof val === 'bigint') {
    const formatted = formatEther(val);
    const num = parseFloat(formatted);
    return isNaN(num) ? '0.00' : num.toFixed(num < 0.01 && num > 0 ? 4 : 3);
  }
  const str = String(val).trim();
  const num = parseFloat(str);
  if (isNaN(num)) return '0.00';
  return num < 0.01 && num > 0 ? num.toFixed(4) : num.toFixed(3);
}

// Wallet balance text that never presents an unknown balance as zero.
export function formatBalance(balance: string | null, read: ReadState): string {
  if (balance === null) return read.status === 'loading' ? 'Loading…' : 'Unavailable';
  const text = `${formatEth(balance)} ETH`;
  return read.status === 'stale' ? `${text} (stale)` : text;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** A valid IANA zone name to format in, or undefined (the viewer's zone) when unset or unknown. */
function zone(timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

function part(sec: number, opts: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Date(sec * 1000).toLocaleString('en-US', { ...opts, timeZone: zone(timeZone) });
}

function zoneName(sec: number, timeZone?: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', timeZone: zone(timeZone) })
      .formatToParts(new Date(sec * 1000))
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/** Date, time and time zone, e.g. "Thu, Nov 19, 1:27 AM CST". */
export function formatDateTime(sec: number, timeZone?: string): string {
  if (!sec) return '—';
  return `${part(sec, DATE_OPTS, timeZone)}, ${part(sec, TIME_OPTS, timeZone)} ${zoneName(sec, timeZone)}`;
}

/**
 * A parking window with explicit dates and time zone. A window that crosses midnight names both
 * dates, and one that crosses a DST change names both zone abbreviations (e.g. CDT and CST).
 */
export function formatParkingWindow(startSec: number, endSec: number, timeZone?: string): {
  dateStr: string;
  timeRange: string;
  durationHours: string;
  full: string;
} {
  const startDate = part(startSec, DATE_OPTS, timeZone);
  const endDate = part(endSec, DATE_OPTS, timeZone);
  const startTime = part(startSec, TIME_OPTS, timeZone);
  const endTime = part(endSec, TIME_OPTS, timeZone);
  const startZone = zoneName(startSec, timeZone);
  const endZone = zoneName(endSec, timeZone);
  const sameDay = startDate === endDate;
  const timeRange = `${startTime}${startZone === endZone ? '' : ` ${startZone}`} – ${endTime} ${endZone}`;
  const hours = ((endSec - startSec) / 3600).toFixed(1).replace(/\.0$/, '');

  return {
    dateStr: sameDay ? startDate : `${startDate} – ${endDate}`,
    timeRange,
    durationHours: `${hours} hr${Number(hours) === 1 ? '' : 's'}`,
    full: sameDay
      ? `${startDate}, ${timeRange}`
      : `${formatDateTime(startSec, timeZone)} – ${formatDateTime(endSec, timeZone)}`,
  };
}

export function getAuctionTimeRemaining(bidEndSec: number): {
  isEnded: boolean;
  text: string;
  totalSeconds: number;
} {
  const now = getChainNowSec();
  const diff = bidEndSec - now;

  if (diff <= 0) {
    return { isEnded: true, text: 'Bidding Closed', totalSeconds: 0 };
  }

  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return { isEnded: false, text: `${days}d ${hours % 24}h remaining`, totalSeconds: diff };
  }

  if (hours > 0) {
    return { isEnded: false, text: `${hours}h ${minutes}m ${seconds}s`, totalSeconds: diff };
  }

  return { isEnded: false, text: `${minutes}m ${seconds}s`, totalSeconds: diff };
}

export function getListingStatus(listing: Listing, nowSec: number = getChainNowSec()): {
  label: string;
  colorClass: string;
  isBiddable: boolean;
  canSettle: boolean;
} {
  const now = nowSec;

  if (listing.cancelled) {
    return {
      label: 'Cancelled',
      colorClass: 'status-cancelled',
      isBiddable: false,
      canSettle: false,
    };
  }

  if (listing.settled) {
    return {
      label: 'Settled',
      colorClass: 'status-settled',
      isBiddable: false,
      canSettle: false,
    };
  }

  if (listing.bidEnd <= now) {
    return {
      label: 'Bidding Ended',
      colorClass: 'status-ended',
      isBiddable: false,
      canSettle: true,
    };
  }

  const remaining = listing.bidEnd - now;
  if (remaining < 1800) {
    return {
      label: 'Ending Soon',
      colorClass: 'status-ending-soon',
      isBiddable: isAuctionOpen(listing, now),
      canSettle: false,
    };
  }

  return {
    label: 'Active Auction',
    colorClass: 'status-active',
    isBiddable: isAuctionOpen(listing, now),
    canSettle: false,
  };
}
