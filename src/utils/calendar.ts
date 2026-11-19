import type { Listing } from '../types';

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

/**
 * A calendar event for a confirmed reservation window, in UTC. The UID is stable per deployment
 * and auction, so re-importing updates the same event. Only public listing fields are included.
 */
export function reservationIcs(
  listing: Pick<Listing, 'id' | 'title' | 'address' | 'parkingStart' | 'parkingEnd'>,
  deployment: { chainId: number; contractAddress: string },
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BidPark//Reservation//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${deployment.chainId}-${deployment.contractAddress.toLowerCase()}-${listing.id}@bidpark`,
    `DTSTAMP:${utc(nowSec)}`,
    `DTSTART:${utc(listing.parkingStart)}`,
    `DTEND:${utc(listing.parkingEnd)}`,
    `SUMMARY:${text(`Parking: ${listing.title}`)}`,
    `LOCATION:${text(listing.address)}`,
    `DESCRIPTION:${text(`BidPark auction #${listing.id} on chain ${deployment.chainId}. Simulated test reservation, not a parking permit.`)}`,
    'STATUS:CONFIRMED',
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
