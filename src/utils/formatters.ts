import { formatEther } from 'ethers';
import type { Listing } from '../types';

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

export function formatTimestamp(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  return d.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatParkingWindow(startSec: number, endSec: number): {
  dateStr: string;
  timeRange: string;
  durationHours: string;
} {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const dateStr = start.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const hours = ((endSec - startSec) / 3600).toFixed(1).replace(/\.0$/, '');

  return {
    dateStr,
    timeRange: `${startTime} – ${endTime}`,
    durationHours: `${hours} hr${Number(hours) === 1 ? '' : 's'}`,
  };
}

export function getAuctionTimeRemaining(bidEndSec: number): {
  isEnded: boolean;
  text: string;
  totalSeconds: number;
} {
  const now = Math.floor(Date.now() / 1000);
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

export function getListingStatus(listing: Listing): {
  label: string;
  colorClass: string;
  isBiddable: boolean;
  canSettle: boolean;
} {
  const now = Math.floor(Date.now() / 1000);

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
      isBiddable: true,
      canSettle: false,
    };
  }

  return {
    label: 'Active Auction',
    colorClass: 'status-active',
    isBiddable: true,
    canSettle: false,
  };
}
