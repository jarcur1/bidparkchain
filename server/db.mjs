import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMetadata } from '../shared/metadata.js';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_PATH = path.resolve(DEFAULT_DATA_DIR, 'bidpark.db');
export const LOCAL_CHAIN_ID = 31337;

const LISTING_COLUMNS = `
  metadata_hash TEXT NOT NULL,
  metadata_json TEXT,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  neighborhood TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  description TEXT NOT NULL,
  image TEXT NOT NULL,
  kind TEXT NOT NULL,
  amenities TEXT NOT NULL,
  created_at INTEGER NOT NULL`;

/**
 * Ordered schema migrations; PRAGMA user_version records how many have run.
 * Each runs once, inside a transaction, and must preserve existing data.
 */
const MIGRATIONS = [
  // 1: listings keyed by (chain, contract, auction) with the exact canonical metadata JSON,
  //    deployment history, and metadata staged before its auction is created.
  //    Pre-migration rows (keyed by auction id alone) belong to this database's chain.
  (db, chainId) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE listings (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        auction_id TEXT NOT NULL,${LISTING_COLUMNS},
        PRIMARY KEY (chain_id, contract_address, auction_id)
      );
      CREATE INDEX idx_listings_hash ON listings (chain_id, contract_address, metadata_hash);
      CREATE TABLE deployments (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        deployment_tx_hash TEXT NOT NULL DEFAULT '',
        deployment_block INTEGER NOT NULL DEFAULT 0,
        profile TEXT,
        seed_scenario TEXT,
        first_seen_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, deployment_tx_hash, deployment_block)
      );
      CREATE TABLE staged_metadata (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        metadata_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        staged_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, metadata_hash)
      );
    `);
    const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listings_metadata'").get();
    if (legacy) {
      db.prepare(`
        INSERT INTO listings (chain_id, contract_address, auction_id, metadata_hash, metadata_json, title, address,
          neighborhood, latitude, longitude, description, image, kind, amenities, created_at)
        SELECT ?, LOWER(contract_address), auction_id, LOWER(metadata_hash), NULL, title, address,
          neighborhood, latitude, longitude, description, image, kind, amenities, created_at
        FROM listings_metadata
      `).run(chainId);
      db.exec('DROP TABLE listings_metadata');
    }
  },
  // 2: wallet sign-in. Single-use nonces bound to the exact message, origin and chain, and sessions
  //    stored by the SHA-256 of their token so a database copy cannot be replayed as a cookie.
  (db) => {
    db.exec(`
      CREATE TABLE auth_nonces (
        nonce TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        origin TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
  // 3: minimal driver/host profile per signed-in wallet. Holds no contact details or property claims.
  (db) => {
    db.exec(`
      CREATE TABLE profiles (
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('driver', 'host', 'both')),
        display_name TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, address)
      );
    `);
  },
  // 4: auction event index. Every log is kept with its block and transaction identity; a reorg flips
  //    `canonical` off instead of deleting, so orphaned history stays auditable. Public data only.
  (db) => {
    db.exec(`
      CREATE TABLE index_checkpoints (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address)
      );
      CREATE TABLE index_blocks (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        PRIMARY KEY (chain_id, contract_address, block_number)
      );
      CREATE TABLE auction_events (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        event TEXT NOT NULL,
        auction_id TEXT,
        account TEXT,
        amount TEXT,
        canonical INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (chain_id, contract_address, block_hash, log_index)
      );
      CREATE INDEX idx_events_auction ON auction_events (chain_id, contract_address, auction_id, canonical);
    `);
  },
  // 5: inbox read state per wallet. Inbox entries are derived from canonical events and identified by
  //    the triggering event's (block hash, log index); only which ones a wallet has read is stored.
  (db) => {
    db.exec(`
      CREATE TABLE inbox_reads (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        address TEXT NOT NULL,
        item_id TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, address, item_id)
      );
      CREATE INDEX idx_events_account ON auction_events (chain_id, contract_address, account);
    `);
  },
  // 6: host space-control verification. One current state per space with the host's private evidence
  //    (never returned by public endpoints), and an audit log that triggers keep append-only.
  (db) => {
    db.exec(`
      CREATE TABLE space_verifications (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        space_id TEXT NOT NULL,
        host TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
        evidence TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, space_id)
      );
      CREATE TABLE verification_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        space_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'revoke', 'report')),
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_space ON verification_audit (chain_id, contract_address, space_id);
      CREATE TRIGGER verification_audit_no_update BEFORE UPDATE ON verification_audit
        BEGIN SELECT RAISE(ABORT, 'verification_audit is append-only'); END;
      CREATE TRIGGER verification_audit_no_delete BEFORE DELETE ON verification_audit
        BEGIN SELECT RAISE(ABORT, 'verification_audit is append-only'); END;
    `);
  },
  // 7: settlement jobs, one per auction the keeper has acted on. `tx_hash` is recorded before the
  //    next attempt may run, so a restart checks that transaction instead of sending a second one.
  (db) => {
    db.exec(`
      CREATE TABLE settlement_jobs (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        auction_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, auction_id)
      );
    `);
  },
  // 8: listing drafts and reusable space templates, private to the wallet that saved them.
  (db) => {
    db.exec(`
      CREATE TABLE host_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        address TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('draft', 'template')),
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_host_drafts_owner ON host_drafts (chain_id, contract_address, address, updated_at);
    `);
  },
  // 9: restricted review channel for protected-booking reports (docs/booking-policy.md). Records hold the
  //    reporting party's evidence or a resolver's reason; only `reference` (a hash of the record) goes
  //    on-chain. Both tables are append-only. Also records which action each keeper job performed.
  (db) => {
    db.exec(`
      CREATE TABLE dispute_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        auction_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('report', 'decision')),
        author TEXT NOT NULL,
        uphold INTEGER CHECK (uphold IN (0, 1)),
        body TEXT NOT NULL,
        reference TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_dispute_records_auction ON dispute_records (chain_id, contract_address, auction_id);
      CREATE TABLE dispute_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        auction_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('submit-report', 'submit-decision', 'view')),
        record_id INTEGER,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_dispute_audit_auction ON dispute_audit (chain_id, contract_address, auction_id);
      CREATE TRIGGER dispute_records_no_update BEFORE UPDATE ON dispute_records
        BEGIN SELECT RAISE(ABORT, 'dispute_records is append-only'); END;
      CREATE TRIGGER dispute_records_no_delete BEFORE DELETE ON dispute_records
        BEGIN SELECT RAISE(ABORT, 'dispute_records is append-only'); END;
      CREATE TRIGGER dispute_audit_no_update BEFORE UPDATE ON dispute_audit
        BEGIN SELECT RAISE(ABORT, 'dispute_audit is append-only'); END;
      CREATE TRIGGER dispute_audit_no_delete BEFORE DELETE ON dispute_audit
        BEGIN SELECT RAISE(ABORT, 'dispute_audit is append-only'); END;
      ALTER TABLE settlement_jobs ADD COLUMN action TEXT NOT NULL DEFAULT 'settle';
    `);
  },
  // 10: private arrival instructions (per space, or per auction overriding the space's) and the
  //    winner's off-chain check-in, one per auction. Neither is ever part of a public listing.
  (db) => {
    db.exec(`
      CREATE TABLE arrival_instructions (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('space', 'auction')),
        target_id TEXT NOT NULL,
        instructions TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, scope, target_id)
      );
      CREATE TABLE arrival_checkins (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        auction_id TEXT NOT NULL,
        winner TEXT NOT NULL,
        checked_in_at INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, auction_id)
      );
    `);
  },
  // Bind proof to the ownership period that was actually reviewed. Older reviews need new proof.
  (db) => db.exec('ALTER TABLE space_verifications ADD COLUMN ownership_epoch TEXT'),
];
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applies pending migrations in order. A database that already holds data is first copied with
 * `VACUUM INTO` (a consistent snapshot) next to itself; each migration then runs in its own
 * transaction, so a failure rolls back to the last good version and the snapshot stays for recovery.
 * A schema newer than `migrations` is refused rather than opened by older code.
 */
export function applyMigrations(db, { chainId, dbPath, migrations = MIGRATIONS }) {
  const from = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (from > migrations.length) {
    throw new Error(`Database schema version ${from} is newer than this code supports (${migrations.length}).`);
  }
  if (from === migrations.length) return { from, to: from, snapshot: null };
  const hasData = from > 0 ||
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listings_metadata'").get();
  let snapshot = null;
  if (hasData && dbPath && dbPath !== ':memory:') {
    snapshot = `${dbPath}.pre-v${migrations.length}-${Date.now()}.bak`;
    db.prepare('VACUUM INTO ?').run(snapshot);
  }
  for (let next = from; next < migrations.length; next++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrations[next](db, chainId);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw Object.assign(new Error(
        `Migration to schema ${next + 1} failed and was rolled back; the database is still at schema ${next}.` +
        (snapshot ? ` A pre-migration copy is at ${snapshot}.` : ''),
      ), { cause: error, snapshot });
    }
  }
  return { from, to: migrations.length, snapshot };
}

export class EscrowDatabase {
  /**
   * One database serves one chain: every listing, staged metadata and deployment row is keyed by
   * that chain id plus the contract address, so equal auction ids on other contracts never collide.
   * @param {string} [dbPath]
   * @param {{ chainId?: number }} [options]
   */
  constructor(dbPath = DEFAULT_DB_PATH, { chainId = LOCAL_CHAIN_ID } = {}) {
    this.dbPath = dbPath;
    this.chainId = chainId;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._migrate();
  }

  _migrate() {
    try {
      this.migration = applyMigrations(this.db, { chainId: this.chainId, dbPath: this.dbPath });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * Gets a value from deployment_meta.
   * @param {string} key
   * @returns {string | null}
   */
  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM deployment_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /**
   * Sets a value in deployment_meta.
   * @param {string} key
   * @param {string} value
   */
  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO deployment_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  /**
   * Records a deployment this database has served. History is append-only and never cleared.
   */
  recordDeployment({ contractAddress, deploymentTxHash, deploymentBlock, profile, seedScenario }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO deployments
        (chain_id, contract_address, deployment_tx_hash, deployment_block, profile, seed_scenario, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.chainId, contractAddress.toLowerCase(), deploymentTxHash ?? '', Number(deploymentBlock ?? 0),
      profile ?? null, seedScenario ?? null, Math.floor(Date.now() / 1000));
  }

  getDeployments() {
    return this.db.prepare('SELECT * FROM deployments WHERE chain_id = ? ORDER BY first_seen_at, deployment_block')
      .all(this.chainId);
  }

  /**
   * Explicit local demo reset: drops this local chain's listings and staged metadata, keeping
   * deployment history. Refused for any other chain, so persistent profiles never lose records.
   * @returns {number} Number of deleted listing rows.
   */
  resetLocalDemo() {
    if (this.chainId !== LOCAL_CHAIN_ID) throw new Error('Demo reset is only allowed on the local chain.');
    this.db.prepare('DELETE FROM staged_metadata WHERE chain_id = ?').run(this.chainId);
    // The redeployed contract reuses the address and space ids, so old verification states must not carry
    // over. ponytail: the append-only audit keeps the old deployment's entries under the same space ids.
    this.db.prepare('DELETE FROM space_verifications WHERE chain_id = ?').run(this.chainId);
    // Same for private arrival details: a new space or auction with a reused id must not see the old ones.
    this.db.prepare('DELETE FROM arrival_instructions WHERE chain_id = ?').run(this.chainId);
    this.db.prepare('DELETE FROM arrival_checkins WHERE chain_id = ?').run(this.chainId);
    return this.db.prepare('DELETE FROM listings WHERE chain_id = ?').run(this.chainId).changes;
  }

  /**
   * Stores normalized metadata under its hash before the auction is created, so the details survive
   * a lost registration. Content-addressed: re-staging the same metadata is a no-op.
   */
  stageMetadata(contractAddress, metadataHash, metadata) {
    // ponytail: unbounded staging table; public-endpoint limits belong to the hosted deployment work (#23).
    this.db.prepare(`
      INSERT OR IGNORE INTO staged_metadata (chain_id, contract_address, metadata_hash, metadata_json, staged_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.chainId, contractAddress.toLowerCase(), metadataHash.toLowerCase(),
      JSON.stringify(normalizeMetadata(metadata)), Math.floor(Date.now() / 1000));
  }

  getStagedMetadata(contractAddress, metadataHash) {
    const row = this.db.prepare(
      'SELECT metadata_json FROM staged_metadata WHERE chain_id = ? AND contract_address = ? AND metadata_hash = ?'
    ).get(this.chainId, contractAddress.toLowerCase(), metadataHash.toLowerCase());
    return row ? JSON.parse(row.metadata_json) : null;
  }

  /**
   * Inserts or reconciles a listing's off-chain metadata for (chain, contract, auction).
   * Keeps the exact canonical JSON that hashes to metadataHash.
   */
  upsertListing(record) {
    const normalized = normalizeMetadata(record);
    this.db.prepare(`
      INSERT INTO listings (chain_id, contract_address, auction_id, metadata_hash, metadata_json, title, address,
        neighborhood, latitude, longitude, description, image, kind, amenities, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract_address, auction_id) DO UPDATE SET
        metadata_hash = excluded.metadata_hash,
        metadata_json = excluded.metadata_json,
        title = excluded.title,
        address = excluded.address,
        neighborhood = excluded.neighborhood,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        description = excluded.description,
        image = excluded.image,
        kind = excluded.kind,
        amenities = excluded.amenities,
        created_at = excluded.created_at
    `).run(
      this.chainId,
      record.contractAddress.toLowerCase(),
      record.auctionId,
      record.metadataHash.toLowerCase(),
      JSON.stringify(normalized),
      normalized.title,
      normalized.address,
      normalized.neighborhood,
      normalized.latitude,
      normalized.longitude,
      normalized.description,
      normalized.image,
      normalized.kind,
      JSON.stringify(normalized.amenities),
      record.createdAt || Math.floor(Date.now() / 1000)
    );
  }

  /**
   * Retrieves a single listing metadata record on this chain.
   * @param {string} auctionId
   * @param {string} [contractAddress]
   */
  getListing(auctionId, contractAddress) {
    let sql = 'SELECT * FROM listings WHERE chain_id = ? AND auction_id = ?';
    const params = [this.chainId, auctionId];
    if (contractAddress) {
      sql += ' AND contract_address = ?';
      params.push(contractAddress.toLowerCase());
    }
    return this.db.prepare(sql).get(...params) || null;
  }

  /**
   * Retrieves a listing record matching a metadataHash for a contract.
   * Used for deterministic seed resumption without duplicate auctions.
   */
  getListingByMetadataHash(contractAddress, metadataHash) {
    return this.db.prepare(
      'SELECT * FROM listings WHERE chain_id = ? AND contract_address = ? AND metadata_hash = ? LIMIT 1'
    ).get(this.chainId, contractAddress.toLowerCase(), metadataHash.toLowerCase()) || null;
  }

  /**
   * Retrieves all listing records for a contract on this chain.
   * @param {string} contractAddress
   */
  getAllListings(contractAddress) {
    return this.db.prepare(
      'SELECT * FROM listings WHERE chain_id = ? AND contract_address = ? ORDER BY CAST(auction_id AS INTEGER) ASC'
    ).all(this.chainId, contractAddress.toLowerCase());
  }

  /**
   * Counts stored listings for a contract on this chain.
   * @param {string} contractAddress
   * @returns {number}
   */
  countListings(contractAddress) {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM listings WHERE chain_id = ? AND contract_address = ?'
    ).get(this.chainId, contractAddress.toLowerCase());
    return row ? Number(row.cnt) : 0;
  }

  createNonce({ nonce, address, origin, message, expiresAt }) {
    this.db.prepare(`
      INSERT INTO auth_nonces (nonce, address, chain_id, origin, message, expires_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(nonce, address, this.chainId, origin, message, expiresAt);
  }

  getNonce(nonce) {
    return this.db.prepare('SELECT * FROM auth_nonces WHERE nonce = ? AND chain_id = ?').get(nonce, this.chainId) || null;
  }

  /** Marks a nonce used; true only for the first caller, which is what prevents replay. */
  consumeNonce(nonce) {
    return this.db.prepare('UPDATE auth_nonces SET used = 1 WHERE nonce = ? AND used = 0').run(nonce).changes === 1;
  }

  createSession({ tokenHash, address, origin, createdAt, expiresAt }) {
    this.db.prepare(`
      INSERT INTO sessions (token_hash, address, chain_id, origin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenHash, address, this.chainId, origin, createdAt, expiresAt);
  }

  getSession(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND chain_id = ?').get(tokenHash, this.chainId) || null;
  }

  revokeSession(tokenHash) {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
  }

  getProfile(address) {
    return this.db.prepare('SELECT role, display_name FROM profiles WHERE chain_id = ? AND address = ?')
      .get(this.chainId, address) || null;
  }

  saveProfile(address, { role, displayName }) {
    this.db.prepare(`
      INSERT INTO profiles (chain_id, address, role, display_name, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, address) DO UPDATE SET
        role = excluded.role, display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(this.chainId, address, role, displayName, Math.floor(Date.now() / 1000));
  }

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

  #transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Commits one scanned range atomically: its events (re-ingesting one is a no-op that re-marks it
   * canonical), the hashes of the blocks they came from, and the new checkpoint.
   */
  commitIndexBatch(contractAddress, { events, blocks, checkpoint }) {
    const contract = contractAddress.toLowerCase();
    return this.#transaction(() => {
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
    return this.#transaction(() => {
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
   * Canonical events that can produce inbox entries for `address` (checksummed, as the indexer stores
   * it): its own events, plus every bid on auctions it bid on (to see when it was outbid). Chain order.
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
        ))
      )
      ORDER BY block_number, log_index
    `).all(this.chainId, contract, address, this.chainId, contract, address);
  }

  getInboxReads(contractAddress, address) {
    return new Set(this.db.prepare('SELECT item_id FROM inbox_reads WHERE chain_id = ? AND contract_address = ? AND address = ?')
      .all(this.chainId, contractAddress.toLowerCase(), address.toLowerCase()).map((row) => row.item_id));
  }

  markInboxRead(contractAddress, address, itemIds) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO inbox_reads (chain_id, contract_address, address, item_id, read_at) VALUES (?, ?, ?, ?, ?)
    `);
    return this.#transaction(() => itemIds.reduce((n, id) => n + insert.run(this.chainId,
      contractAddress.toLowerCase(), address.toLowerCase(), id, Date.now()).changes, 0));
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
    return this.#transaction(() => {
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

  /** A wallet's drafts and templates, newest first. */
  listHostDrafts(contractAddress, address) {
    return this.db.prepare(`
      SELECT id, kind, name, payload, updated_at FROM host_drafts
      WHERE chain_id = ? AND contract_address = ? AND address = ? ORDER BY updated_at DESC, id DESC
    `).all(this.chainId, contractAddress.toLowerCase(), address.toLowerCase());
  }

  /** Creates a draft (id null) or replaces one the wallet owns. Returns its id, or null if it is not the wallet's. */
  saveHostDraft(contractAddress, address, { id = null, kind, name, payload }) {
    const contract = contractAddress.toLowerCase();
    const owner = address.toLowerCase();
    const now = Date.now();
    if (id === null) {
      return Number(this.db.prepare(`
        INSERT INTO host_drafts (chain_id, contract_address, address, kind, name, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.chainId, contract, owner, kind, name, payload, now).lastInsertRowid);
    }
    const changed = this.db.prepare(`
      UPDATE host_drafts SET kind = ?, name = ?, payload = ?, updated_at = ?
      WHERE id = ? AND chain_id = ? AND contract_address = ? AND address = ?
    `).run(kind, name, payload, now, id, this.chainId, contract, owner).changes;
    return changed ? id : null;
  }

  deleteHostDraft(contractAddress, address, id) {
    return this.db.prepare('DELETE FROM host_drafts WHERE id = ? AND chain_id = ? AND contract_address = ? AND address = ?')
      .run(id, this.chainId, contractAddress.toLowerCase(), address.toLowerCase()).changes > 0;
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
    this.#transaction(() => {
      if (action === 'submit') {
        this.db.prepare(`
          INSERT INTO space_verifications (chain_id, contract_address, space_id, host, status, evidence, updated_at, ownership_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chain_id, contract_address, space_id) DO UPDATE SET
            host = excluded.host, status = excluded.status, evidence = excluded.evidence,
            updated_at = excluded.updated_at, ownership_epoch = excluded.ownership_epoch
        `).run(this.chainId, contract, spaceId, host, status, evidence, now, epoch);
      } else if (action !== 'report') {
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

  /** Stored arrival instructions for a space or auction, or null. */
  getArrivalInstructions(contractAddress, scope, targetId) {
    return this.db.prepare(`
      SELECT instructions, updated_by, updated_at FROM arrival_instructions
      WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?
    `).get(this.chainId, contractAddress.toLowerCase(), scope, targetId) ?? null;
  }

  /** Replaces the instructions; empty text removes them. */
  saveArrivalInstructions(contractAddress, scope, targetId, { instructions, updatedBy }) {
    const contract = contractAddress.toLowerCase();
    if (!instructions) {
      this.db.prepare('DELETE FROM arrival_instructions WHERE chain_id = ? AND contract_address = ? AND scope = ? AND target_id = ?')
        .run(this.chainId, contract, scope, targetId);
      return;
    }
    this.db.prepare(`
      INSERT INTO arrival_instructions (chain_id, contract_address, scope, target_id, instructions, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chain_id, contract_address, scope, target_id) DO UPDATE SET
        instructions = excluded.instructions, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(this.chainId, contract, scope, targetId, instructions, updatedBy.toLowerCase(), Date.now());
  }

  getCheckIn(contractAddress, auctionId) {
    return this.db.prepare(`
      SELECT winner, checked_in_at, block_number FROM arrival_checkins WHERE chain_id = ? AND contract_address = ? AND auction_id = ?
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

  close() {
    this.db.close();
  }
}
