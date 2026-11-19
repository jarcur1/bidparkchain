import { ethers } from 'ethers';

/** How each contract event maps onto (auction id, account, amount). RefundWithdrawn has no auction. */
const EVENT_FIELDS = {
  AuctionCreated: ['id', 'owner', null],
  BidPlaced: ['id', 'bidder', 'amount'],
  RefundWithdrawn: [null, 'recipient', 'amount'],
  AuctionSettled: ['id', 'winner', 'amount'],
  PayoutClaimed: ['id', 'owner', 'amount'],
  AuctionCancelled: ['id', null, null],
  // Protected bookings (docs/booking-policy.md).
  BookingRefunded: ['id', 'winner', 'amount'],
  LateCancellationRecorded: ['id', 'winner', null],
  NoShowRecorded: ['id', 'host', null],
  DisputeOpened: ['id', 'reporter', null],
  DisputeResolved: ['id', 'resolver', null],
};

/**
 * Finds the newest block the index recorded that is still on the canonical chain. Hashes chain back
 * to genesis, so once one stored block matches, everything below it does too.
 */
async function findCanonicalAncestor(db, provider, contract, belowOrAt) {
  for (const block of db.getIndexedBlocks(contract, belowOrAt)) {
    const onChain = await provider.getBlock(block.block_number);
    if (onChain?.hash === block.block_hash) return { number: block.block_number, hash: block.block_hash };
  }
  return null;
}

/**
 * Stores the creation parameters search filters on (fixed once an auction exists) on each indexed
 * AuctionCreated row that lacks them, read at block `at` (the checkpoint, so the event is canonical there).
 * Rows left without them (a crash midway) are filled on the next pass.
 */
async function storeCreationDetails({ db, provider, address, iface, at }) {
  for (const row of db.getCreatedWithoutDetail(address)) {
    const data = await provider.send('eth_call', [
      { to: address, data: iface.encodeFunctionData('auctions', [row.auction_id]) }, { blockHash: at },
    ]);
    const a = iface.decodeFunctionResult('auctions', data);
    db.setEventDetail(address, row.block_hash, row.log_index, {
      minBid: a.minBid.toString(), bidEnd: Number(a.bidEnd), parkingStart: Number(a.parkingStart),
      parkingEnd: Number(a.parkingEnd), metadataHash: a.metadataHash,
    });
  }
}

/**
 * Brings the event index for one deployment up to the confirmed head and returns its freshness.
 * Restartable and idempotent: it resumes from the stored checkpoint, and re-ingesting a log is a
 * no-op. If the checkpoint's block is no longer canonical (a reorg), every event above the last
 * still-canonical block is orphaned and that range is scanned again, so replacement events, including
 * a different settlement or refund history, take their place.
 * `confirmation: 'finalized'` indexes only finalized blocks; 'mined' follows the latest block.
 */
export async function syncIndex({ db, provider, address, abi, fromBlock, confirmation = 'mined', batch = 2000 }) {
  const iface = new ethers.Interface(abi);
  const contract = address.toLowerCase();
  let orphaned = 0;
  let checkpoint = db.getCheckpoint(contract);
  if (checkpoint) {
    const onChain = await provider.getBlock(checkpoint.block_number);
    if (onChain?.hash !== checkpoint.block_hash) {
      const ancestor = await findCanonicalAncestor(db, provider, contract, checkpoint.block_number);
      orphaned = db.rewindIndex(contract, ancestor);
      checkpoint = db.getCheckpoint(contract);
    }
  }

  const head = await provider.getBlock(confirmation === 'finalized' ? 'finalized' : 'latest');
  if (!head) throw new Error('Chain head unavailable');
  let next = checkpoint ? checkpoint.block_number + 1 : fromBlock;
  let added = 0;
  while (next <= head.number) {
    const to = Math.min(head.number, next + batch - 1);
    const [logs, end] = await Promise.all([
      provider.getLogs({ address, fromBlock: next, toBlock: to }),
      provider.getBlock(to),
    ]);
    const blocks = new Map();
    const events = [];
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      const fields = parsed && EVENT_FIELDS[parsed.name];
      if (!fields) continue;
      const [idKey, accountKey, amountKey] = fields;
      blocks.set(log.blockNumber, log.blockHash);
      events.push({
        blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.index,
        event: parsed.name,
        auctionId: idKey ? parsed.args[idKey].toString() : null,
        account: accountKey ? parsed.args[accountKey] : null,
        amount: amountKey ? parsed.args[amountKey].toString() : null,
      });
    }
    added += db.commitIndexBatch(contract, { events, blocks, checkpoint: { number: to, hash: end.hash } });
    next = to + 1;
  }
  const final = db.getCheckpoint(contract);
  if (final) await storeCreationDetails({ db, provider, address, iface, at: final.block_hash });
  return {
    added,
    orphaned,
    confirmation,
    indexedBlock: final?.block_number ?? null,
    headBlock: head.number,
    lagBlocks: final ? head.number - final.block_number : null,
  };
}
