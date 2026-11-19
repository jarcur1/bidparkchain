import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { applyMigrations, EscrowDatabase, SCHEMA_VERSION } from '../../server/db.mjs';
import { createScope } from '../support/owned-env.mjs';

const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const spot = {
  title: 'Garage', address: '123 Main Street', neighborhood: 'Downtown', latitude: 30.1, longitude: -97.7,
  description: 'A covered parking space.', image: '/g.jpg', kind: 'garage', amenities: ['Covered'],
};
const version = (db) => Number(db.prepare('PRAGMA user_version').get().user_version);
const snapshots = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.pre-v'));

let scope;
beforeAll(async () => { scope = await createScope('api-migrations'); });
afterAll(async () => { await scope?.close(); });

function populated() {
  const dir = scope.tempDir();
  const file = path.join(dir, 'bidpark.db');
  const db = new EscrowDatabase(file);
  db.upsertListing({ ...spot, auctionId: '1', contractAddress: CONTRACT, metadataHash: ethers.id('spot') });
  db.close();
  return { dir, file };
}

it('takes no snapshot of a brand-new database', () => {
  const dir = scope.tempDir();
  new EscrowDatabase(path.join(dir, 'bidpark.db')).close();
  expect(snapshots(dir)).toEqual([]);
});

it('rolls a failed migration back completely and keeps a consistent pre-migration snapshot', () => {
  const { dir, file } = populated();
  const db = new DatabaseSync(file);
  // Already-applied migrations are skipped; the next one creates a table, then fails part-way.
  const migrations = [...Array(SCHEMA_VERSION)].map(() => () => {});
  migrations.push((raw) => {
    raw.exec('CREATE TABLE half_done (id INTEGER)');
    raw.exec('DELETE FROM listings');
    throw new Error('disk full');
  });

  let failure;
  try { applyMigrations(db, { chainId: 31337, dbPath: file, migrations }); } catch (error) { failure = error; }
  expect(failure.message).toContain(`failed and was rolled back; the database is still at schema ${SCHEMA_VERSION}`);
  expect(failure.cause.message).toBe('disk full');
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(db.prepare('SELECT COUNT(*) AS n FROM listings').get().n).toBe(1);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
  db.close();

  expect(snapshots(dir)).toHaveLength(1);
  expect(failure.snapshot).toBe(path.join(dir, snapshots(dir)[0]));
  const copy = new DatabaseSync(failure.snapshot, { readOnly: true });
  expect(version(copy)).toBe(SCHEMA_VERSION);
  expect(copy.prepare('SELECT title FROM listings').all().map((r) => r.title)).toEqual(['Garage']);
  copy.close();

  // The untouched file still opens normally with the real migrations.
  const reopened = new EscrowDatabase(file);
  expect(reopened.countListings(CONTRACT)).toBe(1);
  reopened.close();
});

it('snapshots a legacy database before upgrading it', () => {
  const dir = scope.tempDir();
  const file = path.join(dir, 'bidpark.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE listings_metadata (auction_id TEXT PRIMARY KEY, contract_address TEXT NOT NULL,
    metadata_hash TEXT NOT NULL, title TEXT NOT NULL, address TEXT NOT NULL, neighborhood TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, description TEXT NOT NULL, image TEXT NOT NULL,
    kind TEXT NOT NULL, amenities TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  legacy.close();
  const db = new EscrowDatabase(file);
  expect(db.migration).toMatchObject({ from: 0, to: SCHEMA_VERSION, snapshot: expect.stringContaining('.pre-v') });
  db.close();
  const copy = new DatabaseSync(snapshots(dir).map((name) => path.join(dir, name))[0], { readOnly: true });
  expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'listings_metadata'").get()).toBeTruthy();
  copy.close();
});
