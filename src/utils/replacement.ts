import type { Listing } from '../types';
import { bookingView } from './booking';

export interface ChangePath {
  /** The contract call the host may use now, if any. */
  action: 'cancel' | 'hostCancelBooking' | null;
  /** True when the auction already has a bid, so editing it means publishing a new auction. */
  hasBids: boolean;
  /** What the action does, and what it costs, in plain words. */
  consequence: string;
}

/**
 * How a host can change a listing: published details are immutable, so any change is a new auction.
 * Lists the contract's existing cancellation path where it is allowed and what it does to the bids.
 * Mirrors the contract's checks; the chain decides when the host signs.
 */
export function changePath(listing: Listing, account: string | null, now: number): ChangePath {
  const hasBids = parseFloat(listing.highestBid) > 0;
  const isHost = Boolean(account) && listing.owner.toLowerCase() === account!.toLowerCase();
  if (listing.cancelled) return { action: null, hasBids, consequence: 'This auction is already cancelled.' };
  if (!hasBids) {
    return isHost && !listing.settled
      ? { action: 'cancel', hasBids, consequence: 'No one has bid, so cancelling costs nothing and nobody is owed a refund. Cancel it, then publish the corrected listing.' }
      : { action: null, hasBids, consequence: 'This auction cannot be cancelled by this wallet.' };
  }
  if (now >= listing.parkingStart) {
    return { action: null, hasBids, consequence: 'Parking has started, so the contract no longer allows a cancellation. The bid stands.' };
  }
  if (!listing.booking?.protected) {
    return {
      action: null, hasBids,
      consequence: 'This is a standard auction with a bid on it. The contract has no cancellation path, so the bid stands and the winner can still be settled. A replacement cannot reuse this window while the original holds it.',
    };
  }
  if (bookingView(listing, account, now)?.actions.includes('hostCancelBooking')) {
    return {
      action: 'hostCancelBooking', hasBids,
      consequence: `Withdrawing refunds the winner's ${listing.highestBid} ETH in full, with no review. You receive nothing from this auction. The refund is credited to the winner to withdraw, and it cannot be undone.`,
    };
  }
  return {
    action: null, hasBids,
    consequence: now < listing.bidEnd
      ? 'Bidding is still open and the bids stand. A protected booking can be withdrawn by the host once bidding closes and before parking starts.'
      : 'This booking can no longer be withdrawn.',
  };
}
