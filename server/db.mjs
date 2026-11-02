import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_PATH = path.resolve(DEFAULT_DATA_DIR, 'bidpark.db');

export class EscrowDatabase {
  /**
   * @param {string} [dbPath]
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS listings_metadata (
        auction_id TEXT PRIMARY KEY,
        contract_address TEXT NOT NULL,
        metadata_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        address TEXT NOT NULL,
        neighborhood TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        description TEXT NOT NULL,
        image TEXT NOT NULL,
        kind TEXT NOT NULL,
        amenities TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_listings_contract
        ON listings_metadata (contract_address);

      CREATE INDEX IF NOT EXISTS idx_listings_hash
        ON listings_metadata (contract_address, metadata_hash);
    `);
  }

  /**
   * Gets a value from deployment_meta.
   * @param {string} key
   * @returns {string | null}
   */
  getMeta(key) {
    const stmt = this.db.prepare('SELECT value FROM deployment_meta WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : null;
  }

  /**
   * Sets a value in deployment_meta.
   * @param {string} key
   * @param {string} value
   */
  setMeta(key, value) {
    const stmt = this.db.prepare(`
      INSERT INTO deployment_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  /**
   * Cleans listings that do not match the currently active deployed contract.
   * Maintains strict chain-to-DB consistency across redeployments.
   * @param {string} activeContractAddress
   */
  clearStaleListings(activeContractAddress) {
    const stmt = this.db.prepare('DELETE FROM listings_metadata WHERE contract_address != ?');
    const result = stmt.run(activeContractAddress);
    return result.changes;
  }

  /**
   * Clears all listing metadata records. Used on fresh chain deployments
   * to guarantee pristine database consistency when local nodes restart.
   * @returns {number} Number of deleted rows.
   */
  clearAllListings() {
    const stmt = this.db.prepare('DELETE FROM listings_metadata');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Inserts or reconciles a listing's off-chain metadata.
   * If a record already exists for this auctionId, updates it with the new valid metadata.
   * Handles chain rollback / ID reuse safely.
   */
  upsertListing(record) {
    const stmt = this.db.prepare(`
      INSERT INTO listings_metadata (
        auction_id,
        contract_address,
        metadata_hash,
        title,
        address,
        neighborhood,
        latitude,
        longitude,
        description,
        image,
        kind,
        amenities,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(auction_id) DO UPDATE SET
        contract_address = excluded.contract_address,
        metadata_hash = excluded.metadata_hash,
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
    `);

    stmt.run(
      record.auctionId,
      record.contractAddress,
      record.metadataHash,
      record.title,
      record.address,
      record.neighborhood,
      record.latitude,
      record.longitude,
      record.description,
      record.image,
      record.kind,
      JSON.stringify(record.amenities),
      record.createdAt || Math.floor(Date.now() / 1000)
    );
  }

  /**
   * Inserts a listing's off-chain metadata, checking for existing identical records.
   */
  insertListing(record) {
    return this.upsertListing(record);
  }

  /**
   * Retrieves a single listing metadata record.
   * @param {string} auctionId
   * @param {string} [contractAddress]
   */
  getListing(auctionId, contractAddress) {
    let sql = 'SELECT * FROM listings_metadata WHERE auction_id = ?';
    const params = [auctionId];
    if (contractAddress) {
      sql += ' AND contract_address = ?';
      params.push(contractAddress);
    }
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) || null;
  }

  /**
   * Retrieves a listing metadata record matching a specific metadataHash for a contract.
   * Used for deterministic seed resumption without duplicate auctions.
   * @param {string} contractAddress
   * @param {string} metadataHash
   */
  getListingByMetadataHash(contractAddress, metadataHash) {
    const stmt = this.db.prepare(
      'SELECT * FROM listings_metadata WHERE contract_address = ? AND LOWER(metadata_hash) = LOWER(?) LIMIT 1'
    );
    return stmt.get(contractAddress, metadataHash) || null;
  }

  /**
   * Retrieves all listing metadata records for the specified contract.
   * @param {string} contractAddress
   */
  getAllListings(contractAddress) {
    const stmt = this.db.prepare(
      'SELECT * FROM listings_metadata WHERE contract_address = ? ORDER BY CAST(auction_id AS INTEGER) ASC'
    );
    return stmt.all(contractAddress);
  }

  /**
   * Counts stored listings for a contract.
   * @param {string} contractAddress
   * @returns {number}
   */
  countListings(contractAddress) {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM listings_metadata WHERE contract_address = ?'
    );
    const row = stmt.get(contractAddress);
    return row ? Number(row.cnt) : 0;
  }

  close() {
    this.db.close();
  }
}
