import { formatEther } from 'ethers';
import { ARRIVAL_OPENS_BEFORE, winnerAccess } from './arrival.mjs';

/** Protected-booking events that both parties of a booking are told about. */
export const BOOKING_EVENTS = ['BookingRefunded', 'LateCancellationRecorded', 'NoShowRecorded', 'DisputeOpened', 'DisputeResolved'];

/** Which preference category each entry kind belongs to. */
export const INBOX_CATEGORIES = {
  outbid: 'bids', won: 'bids',
  upcoming: 'reservations', arrival: 'reservations', 'checked-in': 'reservations',
  booking: 'bookings', 'booking-refund': 'bookings',
  refund: 'funds', payout: 'funds', 'payout-ready': 'funds',
};
export const CATEGORY_NAMES = [...new Set(Object.values(INBOX_CATEGORIES))];

/** Entry ids: an event's (block hash, log index), or an off-chain entry's kind and auction. */
export const INBOX_ID = /^(0x[0-9a-f]{64}:\d{1,6}|(upcoming|arrival|checkin|payout-ready):[1-9]\d{0,77})$/;

/** The upcoming-reservation entry appears this long before parking starts. */
export const UPCOMING_BEFORE = 24 * 60 * 60;

/** A protected booking's host payout is held this long after parking ends (the contract's REPORT_WINDOW). */
export const PAYOUT_HOLD = 24 * 60 * 60;

const CHANGES = {
  LateCancellationRecorded: 'late-cancelled', NoShowRecorded: 'no-show', DisputeOpened: 'dispute-opened',
};

/**
 * Inbox entries for one wallet, derived from canonical auction events in chain order (oldest first):
 * - outbid: someone else bid while this wallet held the highest bid; its bid became a pending refund
 * - won: an auction settled with this wallet as the winner
 * - refund: this wallet withdrew its pending refunds
 * - payout: this wallet claimed a host payout
 * - booking-refund: a protected booking credited this winner's full bid back (cancellation, expiry or dispute)
 * - booking: a change to a protected booking this wallet hosts or won. `change` is refunded,
 *   late-cancelled, no-show, dispute-opened, dispute-upheld, dispute-denied or dispute-expired; `role`
 *   is this wallet's side and `byMe` whether this wallet sent it.
 * `owned` lists auctions on spaces this wallet owns that it did not create; it is told about their
 * booking changes as a host too.
 * Each entry's id is the triggering event's (block hash, log index), so a reorg that replaces the
 * event replaces the entry. Returned newest first.
 */
export function deriveInbox(events, address, owned = []) {
  const me = address.toLowerCase();
  const hosted = new Set(owned);
  const won = new Set();
  const refundTxs = new Set();
  const decisionTxs = new Set();
  for (const e of events) {
    const account = e.account?.toLowerCase();
    if (e.event === 'AuctionCreated' && account === me) hosted.add(e.auction_id);
    if ((e.event === 'AuctionSettled' || e.event === 'BookingRefunded') && account === me) won.add(e.auction_id);
    if (e.event === 'BookingRefunded') refundTxs.add(e.tx_hash);
    if (e.event === 'DisputeResolved') decisionTxs.add(e.tx_hash);
  }
  const highest = new Map(); // auction id -> { bidder, amount } of the latest bid
  const openDispute = new Set();
  const items = [];
  const OWN = { AuctionSettled: 'won', RefundWithdrawn: 'refund', PayoutClaimed: 'payout' };
  for (const e of events) {
    const account = e.account?.toLowerCase();
    const party = hosted.has(e.auction_id) || won.has(e.auction_id);
    let kind = null;
    let change = null;
    let amount = e.amount;
    if (e.event === 'BidPlaced') {
      const previous = highest.get(e.auction_id);
      if (account !== me && previous?.bidder === me) {
        kind = 'outbid';
        amount = previous.amount;
      }
      highest.set(e.auction_id, { bidder: account, amount: e.amount });
    } else if (e.event === 'BookingRefunded') {
      if (account === me) kind = 'booking-refund';
      // A host hears of an upheld report once, from the decision in the same transaction.
      else if (party && !decisionTxs.has(e.tx_hash)) change = openDispute.has(e.auction_id) ? 'dispute-expired' : 'refunded';
      openDispute.delete(e.auction_id);
    } else if (e.event === 'DisputeResolved') {
      openDispute.delete(e.auction_id);
      if (party) change = refundTxs.has(e.tx_hash) ? 'dispute-upheld' : 'dispute-denied';
    } else if (CHANGES[e.event]) {
      if (e.event === 'DisputeOpened') openDispute.add(e.auction_id);
      if (party) change = CHANGES[e.event];
    } else if (account === me) {
      kind = OWN[e.event] ?? null;
    }
    if (change) kind = 'booking';
    if (kind) {
      items.push({
        id: `${e.block_hash}:${e.log_index}`, kind, auctionId: e.auction_id, amount,
        ...(change && { change, role: hosted.has(e.auction_id) ? 'host' : 'winner', byMe: account === me }),
        blockNumber: e.block_number, blockHash: e.block_hash, txHash: e.tx_hash,
      });
    }
  }
  return items.reverse();
}

/**
 * One feed, newest first: chain entries keep their chain order, and each off-chain entry goes before
 * the first chain entry with a known time no later than its own. Entries carry `at` in unix seconds (null when a
 * block time could not be read).
 */
export function mergeFeed(chainItems, offChainItems) {
  const extra = [...offChainItems].sort((a, b) => b.at - a.at);
  const out = [];
  for (const item of chainItems) {
    while (extra.length && item.at !== null && extra[0].at >= item.at) out.push(extra.shift());
    out.push(item);
  }
  return [...out, ...extra];
}

/**
 * Off-chain entries for one wallet. For auctions it won and still holds: an upcoming-reservation entry
 * from UPCOMING_BEFORE before parking starts and an arrival entry once arrival details open, both until
 * parking ends, checked against one pinned block with the arrival API's rules. For auctions it hosts:
 * the winner's check-in. Never includes instruction text. `times` caches each auction's (immutable)
 * parking window and space between calls; `blockTime(hash)` gives an indexed block's time, if known.
 */
export async function reservationEntries({ db, contractAddress, address, events, pinnedReader, times, blockTime }) {
  const me = address.toLowerCase();
  const items = [];
  for (const e of events) {
    if (e.event !== 'AuctionCreated' || e.account?.toLowerCase() !== me) continue;
    const row = db.getCheckIn(contractAddress, e.auction_id);
    if (!row) continue;
    // Ordered after every event the check-in's pinned block had seen, even if the chain clock runs ahead.
    const at = events.filter((ev) => ev.block_number <= row.block_number)
      .reduce((latest, ev) => Math.max(latest, blockTime(ev.block_hash) ?? 0), Math.floor(row.checked_in_at / 1000));
    items.push({ id: `checkin:${e.auction_id}`, kind: 'checked-in', auctionId: e.auction_id, at, checkedInAt: row.checked_in_at });
  }
  const ended = new Set(events.filter((e) => e.event === 'BookingRefunded' ||
    (e.event === 'LateCancellationRecorded' && e.account?.toLowerCase() === me)).map((e) => e.auction_id));
  // Auction id -> when it settled, so a reservation entry never sorts below the win it follows.
  const held = new Map(events.filter((e) => e.event === 'AuctionSettled' && e.account?.toLowerCase() === me && !ended.has(e.auction_id))
    .map((e) => [e.auction_id, blockTime(e.block_hash) ?? 0]));
  if (!held.size) return { items, error: null };
  try {
    const { block, call } = await pinnedReader();
    const chainTime = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));
    for (const [id, settledAt] of held) {
      const { start, end, spaceId } = await parkingWindow(call, times, contractAddress, id);
      if (chainTime < start - UPCOMING_BEFORE || chainTime >= end) continue;
      const [onchain, booking] = await Promise.all([call('auctions', [id]), call('bookings', [id])]);
      const open = (opensBefore) => winnerAccess({ onchain, booking, address, chainTime, opensBefore }).ok;
      if (!open(UPCOMING_BEFORE)) continue;
      const window = { parkingStart: start, parkingEnd: end };
      items.push({ id: `upcoming:${id}`, kind: 'upcoming', auctionId: id, at: Math.max(start - UPCOMING_BEFORE, settledAt), ...window });
      if (open(ARRIVAL_OPENS_BEFORE)) {
        const hasInstructions = db.hasArrivalInstructions(contractAddress, 'auction', id) ||
          db.hasArrivalInstructions(contractAddress, 'space', spaceId);
        items.push({ id: `arrival:${id}`, kind: 'arrival', auctionId: id, at: Math.max(start - ARRIVAL_OPENS_BEFORE, settledAt), hasInstructions, ...window });
      }
    }
    return { items, error: null };
  } catch {
    return { items, error: 'Reservation times could not be read from the chain' };
  }
}

/** An auction's immutable parking window and space, read once and kept in `times`. */
async function parkingWindow(call, times, contractAddress, id) {
  const key = `${contractAddress.toLowerCase()}:${id}`;
  if (!times.has(key)) {
    const [onchain, [spaceId]] = await Promise.all([call('auctions', [id]), call('auctionSpace', [id])]);
    times.set(key, { start: Number(onchain.parkingStart), end: Number(onchain.parkingEnd), spaceId: spaceId.toString() });
  }
  return times.get(key);
}

/**
 * Payout-ready entries for the auctions this wallet created and has not been paid for: settled with a
 * winning bid, parking over (plus the report hold for a protected booking), no open report. Checked at
 * one pinned block with the contract's claimPayout rules; it goes away once the payout is claimed.
 */
export async function payoutReadyEntries({ contractAddress, address, events, pinnedReader, times, blockTime }) {
  const me = address.toLowerCase();
  const paid = new Set(events.filter((e) => e.event === 'PayoutClaimed' && e.account?.toLowerCase() === me).map((e) => e.auction_id));
  const mine = events.filter((e) => e.event === 'AuctionCreated' && e.account?.toLowerCase() === me && !paid.has(e.auction_id));
  if (!mine.length) return { items: [], error: null };
  try {
    const { block, call } = await pinnedReader();
    const chainTime = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));
    const items = [];
    for (const e of mine) {
      const { end } = await parkingWindow(call, times, contractAddress, e.auction_id);
      if (chainTime < end) continue;
      const [auction, booking] = await Promise.all([call('auctions', [e.auction_id]), call('bookings', [e.auction_id])]);
      if (!auction.settled || auction.cancelled || auction.payoutClaimed || auction.highestBid === 0n) continue;
      const claimableAt = end + (booking.isProtected ? PAYOUT_HOLD : 0);
      if (chainTime < claimableAt || (booking.isProtected && booking.disputeReporter !== '0x0000000000000000000000000000000000000000')) continue;
      items.push({ id: `payout-ready:${e.auction_id}`, kind: 'payout-ready', auctionId: e.auction_id, amount: formatEther(auction.highestBid),
        // Ready from the later of the hold ending and the last report decision, so it sorts after a denial.
        at: events.filter((ev) => ev.auction_id === e.auction_id).reduce((at, ev) => Math.max(at, blockTime(ev.block_hash) ?? 0), claimableAt) });
    }
    return { items, error: null };
  } catch {
    return { items: [], error: 'Payout and reservation times could not be read from the chain' };
  }
}

/**
 * Auctions on spaces this wallet owns that someone else created, among those with a booking change.
 * `spaces` caches each auction's (immutable) space between calls; ownership is read live.
 */
export async function ownedAuctionIds({ address, bookingEvents, events, pinnedReader, spaces }) {
  const me = address.toLowerCase();
  const created = new Set(events.filter((e) => e.event === 'AuctionCreated' && e.account?.toLowerCase() === me).map((e) => e.auction_id));
  const ids = [...new Set(bookingEvents.map((e) => e.auction_id))].filter((id) => !created.has(id));
  if (!ids.length) return [];
  try {
    const { call } = await pinnedReader();
    const owners = new Map();
    const owns = await Promise.all(ids.map(async (id) => {
      if (!spaces.has(id)) spaces.set(id, (await call('auctionSpace', [id]))[0].toString());
      const space = spaces.get(id);
      if (!owners.has(space)) owners.set(space, call('spaceOwner', [space]).then((r) => String(r[0]).toLowerCase()));
      return (await owners.get(space)) === me;
    }));
    return ids.filter((_, i) => owns[i]);
  } catch {
    return [];
  }
}
