import crypto from 'node:crypto';

/**
 * AES-256-GCM for arrival instructions at rest. The key comes from BIDPARK_ARRIVAL_KEY (64 hex
 * characters or 44 base64 characters for 32 bytes). A stored value is base64(iv | tag | ciphertext);
 * the row's identity is authenticated too, so a value copied to another row fails to decrypt.
 */
export function parseArrivalKey(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('BIDPARK_ARRIVAL_KEY must be 32 bytes, as 64 hex characters or base64');
  return key;
}

export function encryptArrival(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptArrival(key, stored, aad) {
  const raw = Buffer.from(stored, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
