// Space verification and moderation queries, space aliases, and arrival instructions and check-ins.
import { decryptArrival, encryptArrival } from '../arrival-crypto.mjs';
import { transaction } from './transaction.mjs';

export const withVerification = (Base) => class extends Base {
  /** A space's current verification state, including its private evidence, or null. */
  getVerification(contractAddress, spaceId) {
    return this.db.prepare('SELECT * FROM space_verifications WHERE chain_id = ? AND contract_address = ? AND space_id = ?')
      .get(this.chainId, contractAddress.toLowerCase(), spaceId) || null;
  }

  /** Current states for every space a host has requested verification for. */
  getHostVerifications(contractAddress, host) {
    return this.db.prepare('SELECT * FROM space_verifications WHERE chain_id = ? AND contract_address = ? AND host = ?')
      .all(this.chainId, contractAddress.toLowerCase(), host);
  }

  /** Every space with a request or a report, newest activity first, with its current state if any. */
  getModerationQueue(contractAddress, { limit = 25, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT a.space_id, MAX(a.at) AS last_at, v.host, v.status, v.evidence, v.updated_at, v.ownership_epoch
      FROM verification_audit a
      LEFT JOIN space_verifications v
        ON v.chain_id = a.chain_id AND v.contract_address = a.contract_address AND v.space_id = a.space_id
      WHERE a.chain_id = ? AND a.contract_address = ?
      GROUP BY a.space_id ORDER BY last_at DESC, a.space_id DESC LIMIT ? OFFSET ?
    `).all(this.chainId, contractAddress.toLowerCase(), limit, offset);
  }

  countModerationQueue(contractAddress) {
    return this.db.prepare('SELECT COUNT(DISTINCT space_id) AS n FROM verification_audit WHERE chain_id = ? AND contract_address = ?')
      .get(this.chainId, contractAddress.toLowerCase()).n;
  }

  /**
   * Records a space's alias keys (replacing any earlier ones for it) and returns the other hosts' spaces
   * that share a key, as [{ spaceId, key, host }] with one entry per space and key. `host` is the owner
   * recorded with that space's aliases, which a reorg or transfer may have made stale.
   */
  recordSpaceAliases(contractAddress, spaceId, host, keys) {
    const contract = contractAddress.toLowerCase();
    const owner = host.toLowerCase();
    return transaction(this.db, () => {
      this.deleteSpaceAliases(contract, spaceId);
      const insert = this.db.prepare('INSERT INTO space_aliases VALUES (?, ?, ?, ?, ?)');
      const find = this.db.prepare(`
        SELECT space_id AS spaceId, alias_key AS key, host FROM space_aliases
        WHERE chain_id = ? AND contract_address = ? AND alias_key = ? AND space_id != ? AND host != ? ORDER BY CAST(space_id AS INTEGER)
      `);
      const matches = [];
      for (const key of keys) {
        insert.run(this.chainId, contract, spaceId, key, owner);
        matches.push(...find.all(this.chainId, contract, key, spaceId, owner));
      }
      return matches;
    });
  }

  /** Forgets a space's alias keys, e.g. when the space no longer belongs to the host they were recorded for. */
  deleteSpaceAliases(contractAddress, spaceId) {
    this.db.prepare('DELETE FROM space_aliases WHERE chain_id = ? AND contract_address = ? AND space_id = ?')
      .run(this.chainId, contractAddress.toLowerCase(), spaceId);
  }

  getVerificationAudit(contractAddress, spaceId) {
    return this.db.prepare(`
      SELECT action, status, actor, reason, note, at FROM verification_audit
      WHERE chain_id = ? AND contract_address = ? AND space_id = ? ORDER BY id
    `).all(this.chainId, contractAddress.toLowerCase(), spaceId);
  }

  /**
   * Appends an audit entry and, in the same transaction, moves the space to `status`. `evidence` replaces
   * the stored evidence when given; `null` clears it. A report changes no state (pass no status change).
   */
  recordVerification(contractAddress, spaceId, { action, status, actor, reason, note = '', host, evidence, epoch = null }) {
    const contract = contractAddress.toLowerCase();
    const now = Date.now();
    transaction(this.db, () => {
      if (action === 'submit') {
        this.db.prepare(`
          INSERT INTO space_verifications (chain_id, contract_address, space_id, host, status, evidence, updated_at, ownership_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chain_id, contract_address, space_id) DO UPDATE SET
            host = excluded.host, status = excluded.status, evidence = excluded.evidence,
            updated_at = excluded.updated_at, ownership_epoch = excluded.ownership_epoch
        `).run(this.chainId, contract, spaceId, host, status, evidence, now, epoch);
      } else if (action !== 'report' && action !== 'appeal') {
        this.db.prepare(`
          UPDATE space_verifications SET status = ?, evidence = CASE WHEN ? THEN '' ELSE evidence END, updated_at = ?
          WHERE chain_id = ? AND contract_address = ? AND space_id = ?
        `).run(status, evidence === null ? 1 : 0, now, this.chainId, contract, spaceId);
      }
      this.db.prepare(`
        INSERT INTO verification_audit (chain_id, contract_address, space_id, action, status, actor, reason, note, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.chainId, contract, spaceId, action, status, actor, reason, note, now);
    });
  }

  _arrivalAad(contract, scope, targetId) {
    return `${this.chainId}|${contract}|${scope}|${targetId}`;
  }

  /**
   * Sets the AES-256-GCM key (32 bytes, or null for none) and encrypts every plaintext row in place.
   * ponytail: no key rotation; re-save instructions or write a one-off script if the key must change.
   */
  setArrivalKey(key) {
    this.arrivalKey = key;
    if (!key) return 0;
    const rows = this.db.prepare('SELECT chain_id, contract_address, scope, target_id, instructions FROM arrival_instructions WHERE encrypted = 0').all();
    const update = this.db.prepare(`
      UPDATE arrival_instructions SET instructions = ?, encrypted = 1
      WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?
    `);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const aad = `${r.chain_id}|${r.contract_address}|${r.scope}|${r.target_id}`;
        update.run(encryptArrival(key, r.instructions, aad), r.chain_id, r.contract_address, r.scope, r.target_id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  hasArrivalInstructions(contractAddress, scope, targetId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM arrival_instructions
      WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?
    `).get(this.chainId, contractAddress.toLowerCase(), scope, targetId));
  }

  /** Stored arrival instructions for a space or auction (decrypted), or null. */
  getArrivalInstructions(contractAddress, scope, targetId) {
    const contract = contractAddress.toLowerCase();
    const row = this.db.prepare(`
      SELECT instructions, encrypted, updated_by, updated_at FROM arrival_instructions
      WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?
    `).get(this.chainId, contract, scope, targetId);
    if (!row) return null;
    if (!row.encrypted) return { instructions: row.instructions, updated_by: row.updated_by, updated_at: row.updated_at };
    if (!this.arrivalKey) throw new Error('Arrival instructions are encrypted and BIDPARK_ARRIVAL_KEY is not set');
    return {
      instructions: decryptArrival(this.arrivalKey, row.instructions, this._arrivalAad(contract, scope, targetId)),
      updated_by: row.updated_by, updated_at: row.updated_at,
    };
  }

  /** Replaces the instructions; empty text removes them. */
  saveArrivalInstructions(contractAddress, scope, targetId, { instructions, updatedBy }) {
    const contract = contractAddress.toLowerCase();
    if (!instructions) {
      this.db.prepare('DELETE FROM arrival_instructions WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?')
        .run(this.chainId, contract, scope, targetId);
      return;
    }
    const stored = this.arrivalKey ? encryptArrival(this.arrivalKey, instructions, this._arrivalAad(contract, scope, targetId)) : instructions;
    this.db.prepare(`
      INSERT INTO arrival_instructions (chain_id, contract_address, scope, target_id, instructions, encrypted, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract_address, scope, target_id) DO UPDATE SET
        instructions = excluded.instructions, encrypted = excluded.encrypted,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(this.chainId, contract, scope, targetId, stored, this.arrivalKey ? 1 : 0, updatedBy.toLowerCase(), Date.now());
  }

  getCheckIn(contractAddress, auctionId) {
    return this.db.prepare(`
      SELECT winner, checked_in_at, block_number, verified_by, verified_at FROM arrival_checkins WHERE chain_id = ? AND contract_address = ? AND auction_id = ?
    `).get(this.chainId, contractAddress.toLowerCase(), auctionId) ?? null;
  }

  /** Records the first check-in for an auction; a repeat keeps the original. Returns [row, created]. */
  recordCheckIn(contractAddress, auctionId, { winner, blockNumber }) {
    const created = this.db.prepare(`
      INSERT OR IGNORE INTO arrival_checkins (chain_id, contract_address, auction_id, winner, checked_in_at, block_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.chainId, contractAddress.toLowerCase(), auctionId, winner.toLowerCase(), Date.now(), blockNumber).changes > 0;
    return [this.getCheckIn(contractAddress, auctionId), created];
  }

  /**
   * Spends an arrival token's nonce and records the host-verified check-in in one transaction.
   * Returns { replayed: true } if the nonce was used; else { row, created } (created: first verification).
   */
  verifyArrivalToken(contractAddress, auctionId, { nonce, winner, host, blockNumber }) {
    const contract = contractAddress.toLowerCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const spent = this.db.prepare(`
        INSERT OR IGNORE INTO arrival_token_uses (chain_id, contract_address, nonce, auction_id, used_at) VALUES (?, ?, ?, ?, ?)
      `).run(this.chainId, contract, nonce, auctionId, now).changes > 0;
      if (!spent) {
        this.db.exec('ROLLBACK');
        return { replayed: true };
      }
      this.recordCheckIn(contractAddress, auctionId, { winner, blockNumber });
      const created = this.db.prepare(`
        UPDATE arrival_checkins SET verified_by = ?, verified_at = ?
        WHERE chain_id = ? AND contract_address = ? AND auction_id = ? AND verified_by IS NULL
      `).run(host.toLowerCase(), now, this.chainId, contract, auctionId).changes > 0;
      this.db.exec('COMMIT');
      return { row: this.getCheckIn(contractAddress, auctionId), created };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
};
