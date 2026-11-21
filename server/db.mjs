import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './db/migrations.mjs';
import { withEvents } from './db/events.mjs';
import { withInbox } from './db/inbox.mjs';
import { withListings } from './db/listings.mjs';
import { withPhotos } from './db/photos.mjs';
import { withSessions } from './db/sessions.mjs';
import { withVerification } from './db/verification.mjs';

export { applyMigrations, SCHEMA_VERSION } from './db/migrations.mjs';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_PATH = path.resolve(DEFAULT_DATA_DIR, 'bidpark.db');
export const LOCAL_CHAIN_ID = 31337;

class DatabaseCore {
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
    this.arrivalKey = null;
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
    this.db.prepare('DELETE FROM space_aliases WHERE chain_id = ?').run(this.chainId);
    // Same for private arrival details: a new space or auction with a reused id must not see the old ones.
    this.db.prepare('DELETE FROM arrival_instructions WHERE chain_id = ?').run(this.chainId);
    this.db.prepare('DELETE FROM arrival_checkins WHERE chain_id = ?').run(this.chainId);
    this.db.prepare('DELETE FROM arrival_token_uses WHERE chain_id = ?').run(this.chainId);
    return this.db.prepare('DELETE FROM listings WHERE chain_id = ?').run(this.chainId).changes;
  }

  close() {
    this.db.close();
  }
}

/**
 * The escrow database API. DatabaseCore (above) handles the connection, migrations and meta; each
 * domain's query methods are mixed in from server/db/*.mjs.
 */
export class EscrowDatabase extends withEvents(withInbox(withVerification(withSessions(withPhotos(withListings(DatabaseCore)))))) {}
