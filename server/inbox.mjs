/**
 * Inbox entries for one wallet, derived from canonical auction events in chain order (oldest first):
 * - outbid: someone else bid while this wallet held the highest bid; its bid became a pending refund
 * - won: an auction settled with this wallet as the winner
 * - refund: this wallet withdrew its pending refunds
 * - payout: this wallet claimed a host payout
 * Each entry's id is the triggering event's (block hash, log index), so a reorg that replaces the
 * event replaces the entry. Returned newest first.
 */
export function deriveInbox(events, address) {
  const me = address.toLowerCase();
  const highest = new Map(); // auction id -> { bidder, amount } of the latest bid
  const items = [];
  const OWN = { AuctionSettled: 'won', RefundWithdrawn: 'refund', PayoutClaimed: 'payout' };
  for (const e of events) {
    const account = e.account?.toLowerCase();
    let kind = null;
    let amount = e.amount;
    if (e.event === 'BidPlaced') {
      const previous = highest.get(e.auction_id);
      if (account !== me && previous?.bidder === me) {
        kind = 'outbid';
        amount = previous.amount;
      }
      highest.set(e.auction_id, { bidder: account, amount: e.amount });
    } else if (account === me) {
      kind = OWN[e.event] ?? null;
    }
    if (kind) {
      items.push({
        id: `${e.block_hash}:${e.log_index}`, kind, auctionId: e.auction_id, amount,
        blockNumber: e.block_number, txHash: e.tx_hash,
      });
    }
  }
  return items.reverse();
}
