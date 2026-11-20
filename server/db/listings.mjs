// Listing queries: deployment history, staged and published metadata, host drafts and replacements.
import { normalizeMetadata } from '../../shared/metadata.js';

export const withListings = (Base) => class extends Base {
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

  /** Records that `original` was replaced by `replacement`. False when the original already has a replacement. */
  saveReplacement(contractAddress, originalId, replacementId, host) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO listing_replacements (chain_id, contract_address, original_id, replacement_id, host, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.chainId, contractAddress.toLowerCase(), originalId, replacementId, host.toLowerCase(), Date.now()).changes > 0;
  }

  /** Replacements recorded for the given original auction ids. */
  getReplacements(contractAddress, originalIds) {
    if (!originalIds.length) return [];
    const marks = originalIds.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT original_id, replacement_id, created_at FROM listing_replacements
      WHERE chain_id = ? AND contract_address = ? AND original_id IN (${marks})
    `).all(this.chainId, contractAddress.toLowerCase(), ...originalIds);
  }

  deleteHostDraft(contractAddress, address, id) {
    return this.db.prepare('DELETE FROM host_drafts WHERE id = ? AND chain_id = ? AND contract_address = ? AND address = ?')
      .run(id, this.chainId, contractAddress.toLowerCase(), address.toLowerCase()).changes > 0;
  }
};
