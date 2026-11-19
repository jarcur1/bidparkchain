// Off-chain data backup and verified restore (#24). The chain only holds metadata hashes, so the
// SQLite database is the only copy of listing details, sessions and profiles: back it up.
//   npm run backup                          snapshot BIDPARK_DATA_DIR (default ./data) into <data>/backups/<time>/
//   npm run backup -- restore <backup> <dir>  restore into an empty, separate directory and verify it
// Deleting the database and reseeding is never a recovery: it only recreates demo listings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { EscrowDatabase } from '../server/db.mjs';
import { normalizeMetadata } from '../shared/metadata.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAMES = ['bidpark.db', 'bidpark-sepolia.db'];
const STAMP = /^\d{8}T\d{6}\d{3}Z$/;
export const DEFAULT_KEEP = 14;

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function liveDatabase(dataDir) {
  const name = DB_NAMES.find((candidate) => fs.existsSync(path.join(dataDir, candidate)));
  if (!name) throw new Error(`No BidPark database in ${dataDir}.`);
  return name;
}

/**
 * Takes a consistent snapshot (SQLite VACUUM INTO, safe while the API is running) plus the
 * deployment descriptor and a manifest, then prunes all but the newest `keep` backups.
 */
export function createBackup({ dataDir, backupRoot = path.join(dataDir, 'backups'), keep = DEFAULT_KEEP, now = new Date() }) {
  const dbName = liveDatabase(dataDir);
  const deployment = readJson(path.join(dataDir, 'deployment.json'));
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const dir = path.join(backupRoot, stamp);
  // Owner-only permissions; Windows ignores modes, so keep backups in a protected location there.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const live = new DatabaseSync(path.join(dataDir, dbName), { readOnly: true });
  let schemaVersion;
  let listingCount;
  try {
    live.prepare('VACUUM INTO ?').run(path.join(dir, dbName));
    schemaVersion = Number(live.prepare('PRAGMA user_version').get().user_version);
    listingCount = Number(live.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'listings'").get().n)
      ? Number(live.prepare('SELECT COUNT(*) AS n FROM listings').get().n) : 0;
  } finally {
    live.close();
  }
  fs.copyFileSync(path.join(dataDir, 'deployment.json'), path.join(dir, 'deployment.json'));
  const manifest = {
    createdAt: now.toISOString(),
    database: dbName,
    databaseSha256: sha256File(path.join(dir, dbName)),
    schemaVersion,
    listingCount,
    deployment: {
      profile: deployment.profile ?? 'local',
      chainId: Number(deployment.chainId),
      contractAddress: deployment.contractAddress,
      deploymentTxHash: deployment.deploymentTxHash ?? null,
      deploymentBlock: deployment.deploymentBlock ?? null,
    },
    // No event indexer exists yet (#15); its checkpoint will be recorded here.
    indexCheckpoint: null,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  for (const file of [dbName, 'deployment.json']) fs.chmodSync(path.join(dir, file), 0o600);

  const backups = fs.readdirSync(backupRoot).filter((name) => STAMP.test(name) &&
    fs.existsSync(path.join(backupRoot, name, 'manifest.json'))).sort();
  const pruned = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of pruned) fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
  return { dir, manifest, pruned };
}

/**
 * Restores a backup into an empty directory that is not the live data directory, then verifies it:
 * the file checksum, deployment identity, schema compatibility (migrating older schemas forward)
 * and that every listing's stored metadata still hashes to its recorded on-chain hash.
 */
export function restoreBackup({ backupDir, targetDir, liveDataDir }) {
  const manifest = readJson(path.join(backupDir, 'manifest.json'));
  const target = path.resolve(targetDir);
  if (liveDataDir && target === path.resolve(liveDataDir)) {
    throw new Error('Refusing to restore over the live data directory; restore into a separate directory and verify it first.');
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`Restore target ${target} is not empty.`);
  if (sha256File(path.join(backupDir, manifest.database)) !== manifest.databaseSha256) {
    throw new Error('Backup database checksum does not match its manifest; the backup is damaged.');
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of [manifest.database, 'deployment.json']) fs.copyFileSync(path.join(backupDir, file), path.join(target, file));

  const deployment = readJson(path.join(target, 'deployment.json'));
  if (Number(deployment.chainId) !== manifest.deployment.chainId ||
      deployment.contractAddress?.toLowerCase() !== manifest.deployment.contractAddress?.toLowerCase()) {
    throw new Error('Restored deployment descriptor does not match the backup manifest.');
  }
  const db = new EscrowDatabase(path.join(target, manifest.database), { chainId: manifest.deployment.chainId });
  try {
    const rows = db.getAllListings(manifest.deployment.contractAddress);
    const mismatched = rows.filter((row) => {
      const json = row.metadata_json ?? JSON.stringify(normalizeMetadata({ ...row, amenities: JSON.parse(row.amenities) }));
      return ethers.keccak256(ethers.toUtf8Bytes(json)) !== row.metadata_hash.toLowerCase();
    }).map((row) => row.auction_id);
    if (mismatched.length) throw new Error(`Metadata hash mismatch for auction ${mismatched.map((id) => `#${id}`).join(', ')}.`);
    if (rows.length !== manifest.listingCount) {
      throw new Error(`Expected ${manifest.listingCount} listings for the deployment, found ${rows.length}.`);
    }
    return { ready: true, targetDir: target, listings: rows.length, schemaVersion: db.migration.to, deployment: manifest.deployment };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = path.resolve(process.env.BIDPARK_DATA_DIR || path.join(ROOT_DIR, 'data'));
  const [command = 'backup', backupDir, targetDir] = process.argv.slice(2);
  try {
    if (command === 'backup') {
      const keep = Number(process.env.BIDPARK_BACKUP_KEEP || DEFAULT_KEEP);
      const { dir, manifest, pruned } = createBackup({ dataDir, backupRoot: process.env.BIDPARK_BACKUP_DIR || undefined, keep });
      console.log(`[BidPark Backup] ${manifest.listingCount} listings, schema ${manifest.schemaVersion}, chain ${manifest.deployment.chainId} -> ${dir}`);
      if (pruned.length) console.log(`[BidPark Backup] Pruned ${pruned.length} old backup(s), keeping ${keep}.`);
    } else if (command === 'restore' && backupDir && targetDir) {
      const result = restoreBackup({ backupDir, targetDir, liveDataDir: dataDir });
      console.log(`[BidPark Restore] Verified ${result.listings} listings (schema ${result.schemaVersion}, chain ${result.deployment.chainId}) in ${result.targetDir}. Ready.`);
    } else {
      throw new Error('Usage: npm run backup  |  npm run backup -- restore <backup-dir> <empty-target-dir>');
    }
  } catch (error) {
    console.error(`[BidPark Backup] ${error.message}`);
    process.exit(1);
  }
}
