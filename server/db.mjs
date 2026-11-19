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
];
export const SCHEMA_VERSION = MIGRATIONS.length;

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
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema version ${version} is newer than this code supports (${SCHEMA_VERSION}).`);
    }
    for (let next = version; next < SCHEMA_VERSION; next++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        MIGRATIONS[next](this.db, this.chainId);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
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

  close() {
    this.db.close();
  }
}
