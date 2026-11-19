import type { Listing } from '../types';

// Protected-booking deadlines (docs/booking-policy.md); they mirror the escrow's constants.
export const EARLY_CANCEL_NOTICE = 24 * 3600;
export const NO_SHOW_GRACE = 30 * 60;
export const REPORT_WINDOW = 24 * 3600;
export const RESOLUTION_WINDOW = 72 * 3600;
export const MIN_BID_LEAD = 30 * 60;

export type BookingAction =
  | 'expire' | 'cancelBooking' | 'hostCancelBooking' | 'recordNoShow' | 'reportSellerFailure'
  | 'upholdDispute' | 'denyDispute' | 'expireDispute';

const OUTCOME_TEXT: Record<string, string> = {
  'winner-cancelled': 'Cancelled by the winner with enough notice: the full winning bid was credited back to the winner.',
  'host-cancelled': 'Withdrawn by the host: the full winning bid was credited back to the winner.',
  expired: 'Not settled before parking started: the full winning bid was credited back to the winner.',
  'dispute-upheld': 'Seller-failure report upheld by a resolver: the full winning bid was credited back to the winner.',
  'dispute-expired': 'Seller-failure report was not decided in time: the full winning bid was credited back to the winner.',
  'host-paid': 'Host payout claimed: the winning bid was credited to the host.',
};

/** Host payout eligibility: version 1 at parkingEnd; protected after the report window with no open report. */
export function payoutOpensAt(listing: Listing): number {
  return listing.booking?.protected ? listing.parkingEnd + REPORT_WINDOW : listing.parkingEnd;
}

export function canClaimPayout(listing: Listing, now: number): boolean {
  const hasBids = parseFloat(listing.highestBid) > 0;
  return listing.settled && hasBids && !listing.payoutClaimed && !listing.cancelled &&
    now >= payoutOpensAt(listing) && !listing.booking?.disputeReporter;
}

/**
 * What a protected booking's state means and which actions `account` may take now. Mirrors the
 * contract's checks so buttons only appear when the transaction can succeed; the chain decides.
 * Resolver actions are offered to any non-party wallet: the contract rejects wallets that are not resolvers.
 */
export function bookingView(listing: Listing, account: string | null, now: number): { status: string; actions: BookingAction[] } | null {
  const booking = listing.booking;
  if (!booking?.protected) return null;
  const me = account?.toLowerCase() ?? '';
  const isWinner = Boolean(me) && listing.highestBidder.toLowerCase() === me;
  const isHost = Boolean(me) && listing.owner.toLowerCase() === me;
  const hasWinner = parseFloat(listing.highestBid) > 0;
  const { parkingStart: S, parkingEnd: E, bidEnd: B } = listing;
  const actions: BookingAction[] = [];

  if (booking.outcome !== 'none') return { status: OUTCOME_TEXT[booking.outcome] ?? booking.outcome, actions };
  if (!hasWinner) {
    return { status: 'Protected booking. No bids yet, so no funds are held.', actions };
  }

  const notes: string[] = [];
  if (!listing.settled) {
    if (now < S) {
      notes.push('Protected booking. The winner must be settled before parking starts; otherwise the winner is refunded in full.');
      if (isHost && now >= B) actions.push('hostCancelBooking');
    } else {
      notes.push('Parking started before settlement, so this booking can only expire: anyone may credit the full winning bid back to the winner.');
      actions.push('expire');
    }
    return { status: notes.join(' '), actions };
  }

  if (booking.lateCancelled) notes.push('The winner cancelled late (less than 24 hours before parking): no ordinary refund.');
  else if (now < S) {
    notes.push(now + EARLY_CANCEL_NOTICE <= S
      ? 'The winner can still cancel for a full refund until 24 hours before parking starts.'
      : 'Less than 24 hours before parking: a winner cancellation is recorded but not refunded.');
  }
  if (booking.noShowRecorded) notes.push('The host recorded a no-show. That is an attestation only; it changes no funds or deadlines.');
  if (booking.disputeReporter) {
    notes.push(`A seller-failure report is open: the payout is held until a resolver decides, or until ${new Date((E + RESOLUTION_WINDOW) * 1000).toLocaleString()}, when the winner is refunded in full.`);
  } else if (now < E + REPORT_WINDOW) {
    notes.push(`The winner or host can report a seller failure until ${new Date((E + REPORT_WINDOW) * 1000).toLocaleString()}; the host payout opens then.`);
  } else {
    notes.push('The report window has closed; the host can claim the payout.');
  }

  if (now < S) {
    if (isWinner && !booking.lateCancelled) actions.push('cancelBooking');
    if (isHost) actions.push('hostCancelBooking');
  }
  const noShowFrom = Math.min(S + NO_SHOW_GRACE, E);
  if (isHost && !booking.noShowRecorded && !booking.lateCancelled && now >= noShowFrom && now < E + REPORT_WINDOW) actions.push('recordNoShow');
  if ((isWinner || isHost) && !booking.disputeReporter && now < E + REPORT_WINDOW) actions.push('reportSellerFailure');
  if (booking.disputeReporter) {
    if (now >= E + RESOLUTION_WINDOW) actions.push('expireDispute');
    else if (me && !isWinner && !isHost) actions.push('upholdDispute', 'denyDispute');
  }
  return { status: `Protected booking. ${notes.join(' ')}`, actions };
}

export const BOOKING_ACTION_LABELS: Record<BookingAction, string> = {
  expire: 'Expire and refund winner',
  cancelBooking: 'Cancel my booking',
  hostCancelBooking: 'Withdraw booking (refund winner)',
  recordNoShow: 'Record no-show',
  reportSellerFailure: 'Report seller failure',
  upholdDispute: 'Resolver: uphold report',
  denyDispute: 'Resolver: deny report',
  expireDispute: 'Expire report and refund winner',
};

// Arrival windows; they mirror server/arrival.mjs. Instructions show from 1 hour before parking, check-in from 15 minutes.
export const ARRIVAL_OPENS_BEFORE = 60 * 60;
export const CHECK_IN_OPENS_BEFORE = 15 * 60;
