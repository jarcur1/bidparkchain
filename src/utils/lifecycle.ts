import type { Listing } from '../types';
import { isValidZone } from './schedule';

/**
 * Where an auction stands for one wallet, derived only from contract state (the listing snapshot,
 * including the protected-booking state) and chain time.
 */
export type LifecycleState =
  | 'leading' // bidding open, this wallet holds the highest bid
  | 'outbid' // another wallet holds the highest bid (bidding open, or lost)
  | 'awaiting-settlement'
  | 'upcoming'
  | 'in-progress'
  | 'completed'
  | 'cancelled-refunded'
  | 'disputed'
  | 'expired';

export interface Lifecycle {
  state: LifecycleState;
  label: string;
  /** One honest sentence about what the contract state does and does not say. */
  detail: string;
}

export const LIFECYCLE_STATES: LifecycleState[] = [
  'awaiting-settlement', 'upcoming', 'in-progress', 'completed', 'cancelled-refunded', 'disputed', 'expired', 'leading', 'outbid',
];

const same = (a?: string | null, b?: string | null) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

/** The lifecycle of `listing` for `address`, or null when that wallet is neither its leader nor a bidder. */
export function reservationLifecycle(
  listing: Listing,
  address: string,
  nowSec: number,
  /** True when the wallet is known to have bid on this auction (from the bid history). */
  bidOn = false,
): Lifecycle | null {
  const b = listing.booking;
  const hasBid = parseFloat(listing.highestBid) > 0;

  if (!same(listing.highestBidder, address) || !hasBid) {
    if (!bidOn) return null;
    const open = !listing.cancelled && !listing.settled && listing.bidEnd > nowSec;
    return {
      state: 'outbid',
      label: open ? 'Outbid, bidding open' : 'Outbid, another bidder won',
      detail: listing.cancelled
        ? 'Another wallet held the highest bid and the auction was cancelled. Your displaced bid is in your refund balance.'
        : 'Another wallet holds the highest bid. Your displaced bid is in your refund balance.',
    };
  }

  if (listing.cancelled) {
    switch (b?.outcome) {
      case 'expired':
        return { state: 'expired', label: 'Expired, refunded', detail: 'The auction was not settled before parking began; your bid was credited back.' };
      case 'winner-cancelled':
        return { state: 'cancelled-refunded', label: 'Cancelled by you, refunded', detail: 'You cancelled early enough for a full refund.' };
      case 'host-cancelled':
        return { state: 'cancelled-refunded', label: 'Cancelled by host, refunded', detail: 'The host cancelled; your bid was credited back.' };
      case 'dispute-upheld':
        return { state: 'cancelled-refunded', label: 'Dispute upheld, refunded', detail: 'A seller-failure report was upheld; your bid was credited back.' };
      case 'dispute-expired':
        return { state: 'cancelled-refunded', label: 'Report unresolved, refunded', detail: 'A seller-failure report was not decided in time; your bid was credited back.' };
      default:
        return { state: 'cancelled-refunded', label: 'Cancelled', detail: 'The auction was cancelled. Check your refund balance.' };
    }
  }

  if (listing.settled) {
    if (b?.disputeReporter) {
      return { state: 'disputed', label: 'Disputed', detail: 'A seller-failure report is open and the payment is held until it is decided.' };
    }
    const late = b?.lateCancelled ? ' A late cancellation is recorded; it does not refund the bid.' : '';
    if (listing.payoutClaimed || b?.outcome === 'host-paid') {
      return { state: 'completed', label: 'Completed, host paid', detail: `The parking window ended and the host claimed the payment.${late}` };
    }
    if (nowSec < listing.parkingStart) {
      return { state: 'upcoming', label: 'Upcoming', detail: `Settled on-chain. This is a simulated record, not a parking permit.${late}` };
    }
    if (nowSec < listing.parkingEnd) {
      return { state: 'in-progress', label: 'In progress', detail: `The parking window is running. The contract does not record arrival or access.${late}` };
    }
    return { state: 'completed', label: 'Completed', detail: `The parking window has ended. The contract does not record whether parking took place.${late}` };
  }

  if (listing.bidEnd > nowSec) {
    return { state: 'leading', label: 'Leading', detail: 'Bidding is open and you hold the highest bid.' };
  }
  if (b?.protected && nowSec >= listing.parkingStart) {
    return { state: 'expired', label: 'Expired, refund due', detail: 'Parking began before settlement, so it can only expire with a full refund.' };
  }
  return { state: 'awaiting-settlement', label: 'Awaiting settlement', detail: 'Bidding closed and you hold the highest bid. Anyone can settle it on-chain.' };
}

/**
 * Names the time zone a listing's times are shown in: the parking location's own IANA zone, or
 * the viewer's zone (named) when the space has none.
 */
export function zoneNote(timeZone?: string): string {
  if (timeZone && isValidZone(timeZone)) return `Times in the parking location's time zone (${timeZone}).`;
  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `No location time zone is set, so times are in your time zone (${viewer}).`;
}
