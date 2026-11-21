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
  // 11: marks arrival instructions stored encrypted. Existing rows stay plaintext (0) until the
  //    server starts with BIDPARK_ARRIVAL_KEY set, which encrypts them in place.
  (db) => {
    db.exec('ALTER TABLE arrival_instructions ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
  },
  // 12: inbox dismissals (kept beside read state) and per-wallet inbox preferences: the entry
  //    categories a wallet has chosen to hide, as a JSON list.
  (db) => {
    db.exec(`
      ALTER TABLE inbox_reads ADD COLUMN dismissed_at INTEGER;
      CREATE TABLE inbox_preferences (
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        hidden TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, address)
      );
    `);
  },
  // 13: bind proof to the ownership period that was actually reviewed. Older reviews need new proof.
  (db) => db.exec('ALTER TABLE space_verifications ADD COLUMN ownership_epoch TEXT'),
  // 14: creation parameters of each indexed auction (JSON on its AuctionCreated row), so search can filter
  //    from the index. Kept on the event row, so a reorg orphans them with the event.
  (db) => db.exec('ALTER TABLE auction_events ADD COLUMN detail TEXT'),
  // 15: host-verified arrival. A used token nonce is kept so a replay is refused, and the check-in
  //    records which host verified it.
  (db) => {
    db.exec(`
      CREATE TABLE arrival_token_uses (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        nonce TEXT NOT NULL,
        auction_id TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, nonce)
      );
      ALTER TABLE arrival_checkins ADD COLUMN verified_by TEXT;
      ALTER TABLE arrival_checkins ADD COLUMN verified_at INTEGER;
    `);
  },
  // 16: alias keys per space for duplicate detection, and an 'appeal' audit action (the CHECK on
  //     verification_audit.action cannot be altered, so the append-only table is rebuilt with its rows and triggers).
  (db) => {
    db.exec(`
      CREATE TABLE space_aliases (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        space_id TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        host TEXT NOT NULL,
        PRIMARY KEY (chain_id, contract_address, space_id, alias_key)
      );
      CREATE INDEX idx_aliases_key ON space_aliases (chain_id, contract_address, alias_key);
      CREATE TABLE verification_audit_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        space_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'reject', 'revoke', 'report', 'appeal')),
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      );
      INSERT INTO verification_audit_new SELECT id, chain_id, contract_address, space_id, action, status, actor, reason, note, at FROM verification_audit;
      DROP TABLE verification_audit;
      ALTER TABLE verification_audit_new RENAME TO verification_audit;
      CREATE INDEX idx_audit_space ON verification_audit (chain_id, contract_address, space_id);
      CREATE TRIGGER verification_audit_no_update BEFORE UPDATE ON verification_audit
        BEGIN SELECT RAISE(ABORT, 'verification_audit is append-only'); END;
      CREATE TRIGGER verification_audit_no_delete BEFORE DELETE ON verification_audit
        BEGIN SELECT RAISE(ABORT, 'verification_audit is append-only'); END;
    `);
  },
  // 17: a host's replacement of an auction that already had bids: original -> replacement, one per original.
  (db) => {
    db.exec(`
      CREATE TABLE listing_replacements (
        chain_id INTEGER NOT NULL,
        contract_address TEXT NOT NULL,
        original_id TEXT NOT NULL,
        replacement_id TEXT NOT NULL,
        host TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, contract_address, original_id)
      );
    `);
  },
  // 18: uploaded listing photos: which wallet stored each content-hashed file, its size, and when a draft or
  //     listing last used it, so quotas apply per wallet and unused files can be reclaimed.
  (db) => {
    db.exec(`
      CREATE TABLE photo_uploads (
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (name, address)
      );
      CREATE INDEX idx_photo_uploads_address ON photo_uploads (address);
    `);
  },
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
