// Indexed auction events, index checkpoints, and settlement queries.
import { transaction } from './transaction.mjs';

export const withEvents = (Base) => class extends Base {
  getCheckpoint(contractAddress) {
    return this.db.prepare('SELECT block_number, block_hash, updated_at FROM index_checkpoints WHERE chain_id = ? AND contract_address = ?')
      .get(this.chainId, contractAddress.toLowerCase()) || null;
  }

  /** Stored blocks that produced events, newest first, at or below `maxBlock`. */
  getIndexedBlocks(contractAddress, maxBlock) {
    return this.db.prepare(`
      SELECT block_number, block_hash FROM index_blocks
      WHERE chain_id = ? AND contract_address = ? AND block_number <= ? ORDER BY block_number DESC
    `).all(this.chainId, contractAddress.toLowerCase(), maxBlock);
  }

  /**
   * Commits one scanned range atomically: its events (re-ingesting one is a no-op that re-marks it
   * canonical), the hashes of the blocks they came from, and the new checkpoint.
   */
  commitIndexBatch(contractAddress, { events, blocks, checkpoint }) {
    const contract = contractAddress.toLowerCase();
    return transaction(this.db, () => {
      const insertEvent = this.db.prepare(`
        INSERT INTO auction_events (chain_id, contract_address, block_number, block_hash, tx_hash, log_index, event, auction_id, account, amount, canonical)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(chain_id, contract_address, block_hash, log_index) DO UPDATE SET canonical = 1 WHERE canonical = 0
      `);
      let added = 0;
      for (const e of events) {
        added += insertEvent.run(this.chainId, contract, e.blockNumber, e.blockHash, e.txHash, e.logIndex,
          e.event, e.auctionId, e.account, e.amount).changes;
      }
      const saveBlock = this.db.prepare(`
        INSERT INTO index_blocks (chain_id, contract_address, block_number, block_hash) VALUES (?, ?, ?, ?)
        ON CONFLICT(chain_id, contract_address, block_number) DO UPDATE SET block_hash = excluded.block_hash
      `);
      for (const [number, hash] of blocks) saveBlock.run(this.chainId, contract, number, hash);
      this.db.prepare(`
        INSERT INTO index_checkpoints (chain_id, contract_address, block_number, block_hash, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chain_id, contract_address) DO UPDATE SET
          block_number = excluded.block_number, block_hash = excluded.block_hash, updated_at = excluded.updated_at
      `).run(this.chainId, contract, checkpoint.number, checkpoint.hash, Date.now());
      return added;
    });
  }

  /**
   * Undoes everything above `ancestor` (the newest block still on the canonical chain, or null to
   * start over): those events stop counting but are kept, and the checkpoint moves back.
   * @returns {number} Events that were orphaned.
   */
  rewindIndex(contractAddress, ancestor) {
    const contract = contractAddress.toLowerCase();
    const floor = ancestor ? ancestor.number : -1;
    return transaction(this.db, () => {
      const orphaned = this.db.prepare(`
        UPDATE auction_events SET canonical = 0
        WHERE chain_id = ? AND contract_address = ? AND block_number > ? AND canonical = 1
      `).run(this.chainId, contract, floor).changes;
      this.db.prepare('DELETE FROM index_blocks WHERE chain_id = ? AND contract_address = ? AND block_number > ?')
        .run(this.chainId, contract, floor);
      if (ancestor) {
        this.db.prepare('UPDATE index_checkpoints SET block_number = ?, block_hash = ?, updated_at = ? WHERE chain_id = ? AND contract_address = ?')
          .run(ancestor.number, ancestor.hash, Date.now(), this.chainId, contract);
      } else {
        this.db.prepare('DELETE FROM index_checkpoints WHERE chain_id = ? AND contract_address = ?').run(this.chainId, contract);
      }
      return orphaned;
    });
  }

  /** Canonical AuctionCreated rows whose creation parameters are not stored yet. */
  getCreatedWithoutDetail(contractAddress) {
    return this.db.prepare(`
      SELECT block_hash, log_index, auction_id FROM auction_events
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND event = 'AuctionCreated' AND detail IS NULL
    `).all(this.chainId, contractAddress.toLowerCase());
  }

  setEventDetail(contractAddress, blockHash, logIndex, detail) {
    this.db.prepare('UPDATE auction_events SET detail = ? WHERE chain_id = ? AND contract_address = ? AND block_hash = ? AND log_index = ?')
      .run(JSON.stringify(detail), this.chainId, contractAddress.toLowerCase(), blockHash, logIndex);
  }

  /**
   * Auction state as of block `atBlock`, from canonical indexed events only: creation parameters (null
   * until stored), the latest bid (bids only rise) and whether it was settled or cancelled.
   * @returns {Map<string, {detail: object|null, highestBid: string, settled: boolean, cancelled: boolean}>}
   */
  getIndexedAuctions(contractAddress, atBlock) {
    const rows = this.db.prepare(`
      SELECT auction_id, event, amount, detail FROM auction_events
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND block_number <= ?
        AND event IN ('AuctionCreated', 'BidPlaced', 'AuctionSettled', 'AuctionCancelled', 'BookingRefunded')
      ORDER BY block_number, log_index
    `).all(this.chainId, contractAddress.toLowerCase(), atBlock);
    const auctions = new Map();
    for (const row of rows) {
      if (row.event === 'AuctionCreated') {
        auctions.set(row.auction_id, { detail: row.detail && JSON.parse(row.detail), highestBid: '0', settled: false, cancelled: false });
        continue;
      }
      const auction = auctions.get(row.auction_id);
      if (!auction) continue;
      if (row.event === 'BidPlaced') auction.highestBid = row.amount;
      else if (row.event === 'AuctionSettled') auction.settled = true;
      else auction.cancelled = true;
    }
    return auctions;
  }

  /** Canonical events for one auction (or all, when auctionId is omitted), in chain order. */
  getAuctionEvents(contractAddress, auctionId, { includeOrphaned = false } = {}) {
    return this.db.prepare(`
      SELECT block_number, block_hash, tx_hash, log_index, event, auction_id, account, amount, canonical
      FROM auction_events
      WHERE chain_id = ? AND contract_address = ? AND (? IS NULL OR auction_id = ?) AND (? OR canonical = 1)
      ORDER BY block_number, log_index
    `).all(this.chainId, contractAddress.toLowerCase(), auctionId ?? null, auctionId ?? null, includeOrphaned ? 1 : 0);
  }

  /**
   * Auctions the settlement keeper should look at: indexed as created with at least one bid and not
   * (yet) indexed as settled or cancelled, plus any with a job still in flight or retrying.
   */
  getSettlementCandidates(contractAddress) {
    const contract = contractAddress.toLowerCase();
    return this.db.prepare(`
      SELECT auction_id FROM (SELECT auction_id FROM auction_events e
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND event = 'BidPlaced'
        AND NOT EXISTS (
          SELECT 1 FROM auction_events s
          WHERE s.chain_id = e.chain_id AND s.contract_address = e.contract_address AND s.auction_id = e.auction_id
            AND s.canonical = 1 AND s.event IN ('AuctionSettled', 'AuctionCancelled', 'BookingRefunded')
        )
      UNION
      SELECT auction_id FROM settlement_jobs WHERE chain_id = ? AND contract_address = ? AND status IN ('sent', 'failed'))
      ORDER BY CAST(auction_id AS INTEGER)
    `).all(this.chainId, contract, this.chainId, contract).map((row) => row.auction_id);
  }

  getSettlementJob(contractAddress, auctionId) {
    return this.db.prepare('SELECT * FROM settlement_jobs WHERE chain_id = ? AND contract_address = ? AND auction_id = ?')
      .get(this.chainId, contractAddress.toLowerCase(), auctionId) || null;
  }

  saveSettlementJob(contractAddress, auctionId, { status, txHash = null, attempts = 0, error = null, nextAttemptAt = null, updatedAt = Date.now(), action = 'settle' }) {
    this.db.prepare(`
      INSERT INTO settlement_jobs (chain_id, contract_address, auction_id, status, tx_hash, attempts, last_error, next_attempt_at, updated_at, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract_address, auction_id) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash, action = excluded.action,
        attempts = excluded.attempts, last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
    `).run(this.chainId, contractAddress.toLowerCase(), auctionId, status, txHash, attempts, error, nextAttemptAt, updatedAt, action);
  }

  /** Job counts by status and the most recently updated failing jobs. */
  getSettlementSummary(contractAddress, { failures = 10 } = {}) {
    const contract = contractAddress.toLowerCase();
    const counts = Object.fromEntries(this.db.prepare(
      'SELECT status, COUNT(*) AS n FROM settlement_jobs WHERE chain_id = ? AND contract_address = ? GROUP BY status',
    ).all(this.chainId, contract).map((row) => [row.status, row.n]));
    const recentFailures = this.db.prepare(`
      SELECT auction_id, attempts, last_error, next_attempt_at, updated_at FROM settlement_jobs
      WHERE chain_id = ? AND contract_address = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT ?
    `).all(this.chainId, contract, failures);
    return { counts, recentFailures };
  }

  /** Gauges for the metrics endpoint: jobs by status, total attempts, and when the oldest unconfirmed job last moved. */
  getSettlementMetrics(contractAddress) {
    const contract = contractAddress.toLowerCase();
    const { counts } = this.getSettlementSummary(contract, { failures: 0 });
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(attempts), 0) AS attempts,
        MIN(CASE WHEN status IN ('sent', 'failed') THEN updated_at END) AS oldest
      FROM settlement_jobs WHERE chain_id = ? AND contract_address = ?
    `).get(this.chainId, contract);
    return { counts, attempts: row.attempts, oldestUnconfirmedAt: row.oldest };
  }
};
