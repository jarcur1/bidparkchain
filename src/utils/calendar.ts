import type { Listing } from '../types';
import { formatParkingWindow } from './formatters';
import type { Lifecycle, LifecycleState } from './lifecycle';
import { isValidZone } from './schedule';

const utc = (sec: number) => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = (value: string) => value.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\r?\n/g, '\\n');

/** RFC 5545 line folding: at most 75 octets per line, never splitting a UTF-8 character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > 75) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  lines.push(current);
  return lines.join('\r\n');
}

export type IcsStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

/**
 * Calendar status and revision number per lifecycle state. The revision (SEQUENCE) only grows as a
 * reservation moves on, so re-importing a later export replaces the event instead of duplicating
 * it. An outbid wallet has no reservation, so it has no event.
 */
const ICS: Record<LifecycleState, { status: IcsStatus; sequence: number } | null> = {
  leading: { status: 'TENTATIVE', sequence: 0 },
  'awaiting-settlement': { status: 'TENTATIVE', sequence: 0 },
  upcoming: { status: 'CONFIRMED', sequence: 1 },
  'in-progress': { status: 'CONFIRMED', sequence: 1 },
  completed: { status: 'CONFIRMED', sequence: 1 },
  disputed: { status: 'TENTATIVE', sequence: 2 },
  'cancelled-refunded': { status: 'CANCELLED', sequence: 3 },
  expired: { status: 'CANCELLED', sequence: 3 },
  outbid: null,
};

export const canExportIcs = (lifecycle: Lifecycle | null): lifecycle is Lifecycle => Boolean(lifecycle && ICS[lifecycle.state]);

/**
 * A calendar event for a reservation in any lifecycle state. Times are absolute UTC instants, which
 * stay correct across daylight-saving changes in every calendar app and need no VTIMEZONE; the
 * space's IANA zone and its local wall-clock window are named in the description instead. The UID is
 * stable per deployment and auction, so re-importing updates the same event. Only public listing
 * fields are included.
 */
export function reservationIcs(
  listing: Pick<Listing, 'id' | 'title' | 'address' | 'parkingStart' | 'parkingEnd'> & { timeZone?: string },
  deployment: { chainId: number; contractAddress: string },
  lifecycle: Lifecycle,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const kind = ICS[lifecycle.state];
  if (!kind) throw new Error(`No calendar event for state ${lifecycle.state}`);
  const zone = listing.timeZone && isValidZone(listing.timeZone) ? listing.timeZone : '';
  const where = zone
    ? `Local time (${zone}): ${formatParkingWindow(listing.parkingStart, listing.parkingEnd, zone).full}.`
    : 'The space has no time zone set; times are in UTC.';
  const cancelled = kind.status === 'CANCELLED' ? 'CANCELLED: ' : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BidPark//Reservation//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${deployment.chainId}-${deployment.contractAddress.toLowerCase()}-${listing.id}@bidpark`,
    `SEQUENCE:${kind.sequence}`,
    `DTSTAMP:${utc(nowSec)}`,
    `DTSTART:${utc(listing.parkingStart)}`,
    `DTEND:${utc(listing.parkingEnd)}`,
    `SUMMARY:${text(`${cancelled}Parking: ${listing.title}`)}`,
    `LOCATION:${text(listing.address)}`,
    `DESCRIPTION:${text(`${lifecycle.label}. ${where} BidPark auction #${listing.id} on chain ${deployment.chainId}. Simulated test reservation, not a parking permit.`)}`,
    `STATUS:${kind.status}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function downloadReservationIcs(...args: Parameters<typeof reservationIcs>): void {
  const url = URL.createObjectURL(new Blob([reservationIcs(...args)], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `bidpark-reservation-${args[0].id}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
