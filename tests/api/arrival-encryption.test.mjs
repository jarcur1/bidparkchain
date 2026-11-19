import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../server/app.mjs';
import { EscrowDatabase } from '../../server/db.mjs';
import { parseArrivalKey } from '../../server/arrival-crypto.mjs';
import { createScope } from '../support/owned-env.mjs';

const SECRET = 'Gate code 4471, then the second door on the left';
const KEY = 'ab'.repeat(32);
const CONTRACT = '0x' + 'a'.repeat(40);
let scope;
beforeAll(async () => { scope = await createScope('api-arrival-encryption'); });
afterAll(async () => { await scope?.close(); });

const rawRows = (file) => {
  const raw = new DatabaseSync(file);
  const rows = raw.prepare('SELECT instructions, encrypted FROM arrival_instructions').all();
  raw.close();
  return rows;
};
const fileBytes = (file) => [file, `${file}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f).toString('latin1')).join('');

it('stores instructions as ciphertext when a key is set, and reads them back', () => {
  const file = path.join(scope.tempDir('enc'), 'bidpark.db');
  const db = new EscrowDatabase(file);
  db.setArrivalKey(parseArrivalKey(KEY));
  db.saveArrivalInstructions(CONTRACT, 'space', '1', { instructions: SECRET, updatedBy: CONTRACT });
  expect(db.getArrivalInstructions(CONTRACT, 'space', '1').instructions).toBe(SECRET);
  const [row] = rawRows(file);
  expect(row.encrypted).toBe(1);
  expect(row.instructions).not.toContain('Gate code');
  db.close();
  expect(fileBytes(file)).not.toContain('Gate code');
  expect(fileBytes(file)).not.toContain('second door');
});

it('encrypts existing plaintext rows once a key is configured', () => {
  const file = path.join(scope.tempDir('legacy'), 'bidpark.db');
  const old = new EscrowDatabase(file);
  old.saveArrivalInstructions(CONTRACT, 'auction', '7', { instructions: SECRET, updatedBy: CONTRACT });
  expect(rawRows(file)[0]).toEqual({ instructions: SECRET, encrypted: 0 });
  expect(old.setArrivalKey(parseArrivalKey(KEY))).toBe(1);
  expect(rawRows(file)[0].instructions).not.toContain('Gate code');
  expect(rawRows(file)[0].encrypted).toBe(1);
  expect(old.getArrivalInstructions(CONTRACT, 'auction', '7').instructions).toBe(SECRET);
  expect(old.setArrivalKey(parseArrivalKey(KEY))).toBe(0);
  old.close();
});

it('refuses to read without the key, with the wrong key, or from a copied row', () => {
  const file = path.join(scope.tempDir('wrong'), 'bidpark.db');
  const db = new EscrowDatabase(file);
  db.setArrivalKey(parseArrivalKey(KEY));
  db.saveArrivalInstructions(CONTRACT, 'space', '1', { instructions: SECRET, updatedBy: CONTRACT });
  db.setArrivalKey(null);
  expect(() => db.getArrivalInstructions(CONTRACT, 'space', '1')).toThrow(/BIDPARK_ARRIVAL_KEY/);
  db.setArrivalKey(parseArrivalKey('cd'.repeat(32)));
  expect(() => db.getArrivalInstructions(CONTRACT, 'space', '1')).toThrow();
  db.setArrivalKey(parseArrivalKey(KEY));
  db.db.prepare("UPDATE arrival_instructions SET target_id = '2'").run();
  expect(() => db.getArrivalInstructions(CONTRACT, 'space', '2')).toThrow();
  db.close();
});

it('accepts hex or base64 keys of 32 bytes only', () => {
  expect(parseArrivalKey(KEY)).toHaveLength(32);
  expect(parseArrivalKey(Buffer.alloc(32, 1).toString('base64'))).toHaveLength(32);
  expect(parseArrivalKey('')).toBeNull();
  expect(() => parseArrivalKey('too short')).toThrow(/32 bytes/);
});

async function settings(options) {
  const dir = scope.tempDir();
  const runtime = createApp({ dbPath: path.join(dir, 'bidpark.db'), deploymentPath: path.join(dir, 'none.json'), rpcUrl: 'http://127.0.0.1:9', ...options });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    runtime.db.close();
    runtime.provider.destroy();
  }
}

it('says in /api/settings whether arrival instructions are encrypted, without the key', async () => {
  const off = await settings({});
  expect(off).toMatchObject({ hosted: false, arrivalEncryption: 'off' });
  expect(off.arrivalEncryptionNote).toMatch(/unencrypted/);
  const on = await settings({ arrivalKey: KEY });
  expect(on).toEqual({ hosted: false, arrivalEncryption: 'aes-256-gcm' });
  const hosted = await settings({ allowedOrigins: ['https://staging.bidpark.example'] });
  expect(hosted.arrivalEncryptionNote).toMatch(/cannot be saved/);
});
