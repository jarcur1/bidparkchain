// Wallet sign-in queries: single-use nonces, sessions, and profiles.

export const withSessions = (Base) => class extends Base {
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
};
