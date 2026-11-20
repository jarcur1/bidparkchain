// Inbox entries, read and dismiss state, inbox preferences, and dispute records.
import { transaction } from './transaction.mjs';

export const withInbox = (Base) => class extends Base {
  /**
   * Canonical events that can produce inbox entries for `address` (checksummed, as the indexer stores
   * it): its own events, every bid on auctions it bid on (to see when it was outbid), and every
   * protected-booking event on auctions it created or won. Chain order.
   */
  getInboxEvents(contractAddress, address) {
    const contract = contractAddress.toLowerCase();
    return this.db.prepare(`
      SELECT block_number, block_hash, tx_hash, log_index, event, auction_id, account, amount
      FROM auction_events
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND (
        account = ? OR (event = 'BidPlaced' AND auction_id IN (
          SELECT auction_id FROM auction_events
          WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND event = 'BidPlaced' AND account = ?
        )) OR (event IN ('BookingRefunded', 'LateCancellationRecorded', 'NoShowRecorded', 'DisputeOpened', 'DisputeResolved')
          AND auction_id IN (
            SELECT auction_id FROM auction_events
            WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND account = ?
              AND event IN ('AuctionCreated', 'AuctionSettled', 'BookingRefunded')
          ))
      )
      ORDER BY block_number, log_index
    `).all(this.chainId, contract, address, this.chainId, contract, address, this.chainId, contract, address);
  }

  /** Every canonical protected-booking event on this deployment, in chain order. */
  getBookingEvents(contractAddress) {
    return this.db.prepare(`
      SELECT block_number, block_hash, tx_hash, log_index, event, auction_id, account, amount
      FROM auction_events
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1
        AND event IN ('BookingRefunded', 'LateCancellationRecorded', 'NoShowRecorded', 'DisputeOpened', 'DisputeResolved')
      ORDER BY block_number, log_index
    `).all(this.chainId, contractAddress.toLowerCase());
  }

  /** The entry ids `address` has read and dismissed on this deployment. */
  getInboxState(contractAddress, address) {
    const rows = this.db.prepare('SELECT item_id, dismissed_at FROM inbox_reads WHERE chain_id = ? AND contract_address = ? AND address = ?')
      .all(this.chainId, contractAddress.toLowerCase(), address.toLowerCase());
    return {
      read: new Set(rows.map((row) => row.item_id)),
      dismissed: new Set(rows.filter((row) => row.dismissed_at !== null).map((row) => row.item_id)),
    };
  }

  /** Dismisses (and so also reads) entries for one wallet. Idempotent. */
  dismissInboxItems(contractAddress, address, itemIds) {
    const upsert = this.db.prepare(`
      INSERT INTO inbox_reads (chain_id, contract_address, address, item_id, read_at, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract_address, address, item_id) DO UPDATE SET dismissed_at = COALESCE(dismissed_at, excluded.dismissed_at)
    `);
    transaction(this.db, () => {
      for (const id of itemIds) upsert.run(this.chainId, contractAddress.toLowerCase(), address.toLowerCase(), id, Date.now(), Date.now());
    });
  }

  /** The inbox categories `address` hides (empty when it never set any). */
  getInboxPreferences(address) {
    const row = this.db.prepare('SELECT hidden FROM inbox_preferences WHERE chain_id = ? AND address = ?')
      .get(this.chainId, address.toLowerCase());
    return { hidden: row ? JSON.parse(row.hidden) : [] };
  }

  setInboxPreferences(address, { hidden }) {
    this.db.prepare(`
      INSERT INTO inbox_preferences (chain_id, address, hidden, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chain_id, address) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at
    `).run(this.chainId, address.toLowerCase(), JSON.stringify(hidden), Date.now());
  }

  markInboxRead(contractAddress, address, itemIds) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO inbox_reads (chain_id, contract_address, address, item_id, read_at) VALUES (?, ?, ?, ?, ?)
    `);
    return transaction(this.db, () => itemIds.reduce((n, id) => n + insert.run(this.chainId,
      contractAddress.toLowerCase(), address.toLowerCase(), id, Date.now()).changes, 0));
  }

  /** Auctions whose indexed events show more reports than decisions and no refund: reports that may still be open. */
  getOpenDisputeAuctions(contractAddress) {
    const count = (event) => `(SELECT COUNT(*) FROM auction_events x WHERE x.chain_id = o.chain_id AND x.contract_address = o.contract_address
      AND x.auction_id = o.auction_id AND x.canonical = 1 AND x.event = '${event}')`;
    return this.db.prepare(`
      SELECT DISTINCT auction_id FROM auction_events o
      WHERE chain_id = ? AND contract_address = ? AND canonical = 1 AND event = 'DisputeOpened'
        AND ${count('DisputeOpened')} > ${count('DisputeResolved')} AND ${count('BookingRefunded')} = 0
      ORDER BY CAST(auction_id AS INTEGER)
    `).all(this.chainId, contractAddress.toLowerCase()).map((row) => row.auction_id);
  }

  /** Appends a review record and its audit entry; returns the stored record. */
  addDisputeRecord(contractAddress, auctionId, { kind, author, uphold = null, body, reference, createdAt }) {
    const contract = contractAddress.toLowerCase();
    return transaction(this.db, () => {
      const { lastInsertRowid } = this.db.prepare(`
        INSERT INTO dispute_records (chain_id, contract_address, auction_id, kind, author, uphold, body, reference, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.chainId, contract, auctionId, kind, author.toLowerCase(), uphold === null ? null : Number(uphold), body, reference, createdAt);
      this.addDisputeAudit(contract, auctionId, author, `submit-${kind}`, Number(lastInsertRowid), createdAt);
      return Number(lastInsertRowid);
    });
  }

  addDisputeAudit(contractAddress, auctionId, actor, action, recordId = null, at = Date.now()) {
    this.db.prepare(`
      INSERT INTO dispute_audit (chain_id, contract_address, auction_id, actor, action, record_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.chainId, contractAddress.toLowerCase(), auctionId, actor.toLowerCase(), action, recordId, at);
  }

  getDisputeRecords(contractAddress, auctionId) {
    return this.db.prepare('SELECT * FROM dispute_records WHERE chain_id = ? AND contract_address = ? AND auction_id = ? ORDER BY id')
      .all(this.chainId, contractAddress.toLowerCase(), auctionId);
  }

  getDisputeAudit(contractAddress, auctionId) {
    return this.db.prepare('SELECT * FROM dispute_audit WHERE chain_id = ? AND contract_address = ? AND auction_id = ? ORDER BY id')
      .all(this.chainId, contractAddress.toLowerCase(), auctionId);
  }
};
