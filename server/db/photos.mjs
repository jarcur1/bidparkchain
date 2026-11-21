// Uploaded listing photos: who stored each file, how big it is, and whether any draft or listing still uses it.

export const withPhotos = (Base) => class extends Base {
  /** True when the wallet has saved any draft or template, on any contract this database has served. */
  hasHostDrafts(address) {
    return Boolean(this.db.prepare('SELECT 1 FROM host_drafts WHERE chain_id = ? AND address = ? LIMIT 1')
      .get(this.chainId, address.toLowerCase()));
  }

  /** Photos this wallet has stored and not yet had reclaimed. */
  countWalletPhotos(address) {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM photo_uploads WHERE address = ?').get(address.toLowerCase()).n);
  }

  /** Bytes on disk for stored photos; one file shared by several wallets counts once. */
  storedPhotoBytes() {
    return Number(this.db.prepare(
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM (SELECT MAX(size) AS size FROM photo_uploads GROUP BY name)',
    ).get().bytes);
  }

  hasPhotoRow(name, address) {
    return Boolean(this.db.prepare('SELECT 1 FROM photo_uploads WHERE name = ? AND address = ?').get(name, address.toLowerCase()));
  }

  hasPhotoFile(name) {
    return Boolean(this.db.prepare('SELECT 1 FROM photo_uploads WHERE name = ? LIMIT 1').get(name));
  }

  /** Records an upload, or restarts the grace period of one this wallet already stored. */
  recordPhoto(name, address, size, now) {
    this.db.prepare(`
      INSERT INTO photo_uploads (name, address, size, uploaded_at, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name, address) DO UPDATE SET seen_at = excluded.seen_at
    `).run(name, address.toLowerCase(), size, now, now);
  }

  forgetPhoto(name, address) {
    this.db.prepare('DELETE FROM photo_uploads WHERE name = ? AND address = ?').run(name, address.toLowerCase());
  }

  /** Distinct stored photo names. */
  listPhotoNames() {
    return this.db.prepare('SELECT DISTINCT name FROM photo_uploads').all().map((row) => row.name);
  }

  /** True when a draft, template, published listing or staged metadata still points at the photo. */
  isPhotoReferenced(name) {
    return Boolean(this.db.prepare(`
      SELECT 1 WHERE EXISTS (SELECT 1 FROM host_drafts WHERE instr(payload, ?) > 0)
        OR EXISTS (SELECT 1 FROM listings WHERE instr(image, ?) > 0 OR instr(COALESCE(metadata_json, ''), ?) > 0)
        OR EXISTS (SELECT 1 FROM staged_metadata WHERE instr(metadata_json, ?) > 0)
    `).get(name, name, name, name));
  }

  /** Marks a photo as in use now, so its grace period counts from the last time anything referenced it. */
  touchPhoto(name, now) {
    this.db.prepare('UPDATE photo_uploads SET seen_at = ? WHERE name = ?').run(now, name);
  }

  /** Deletes the rows of a photo unused since before `cutoff`; true when none remain (the file may go). */
  dropStalePhotoRows(name, cutoff) {
    this.db.prepare('DELETE FROM photo_uploads WHERE name = ? AND seen_at < ?').run(name, cutoff);
    return !this.hasPhotoFile(name);
  }
};
