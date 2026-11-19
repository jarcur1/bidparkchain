import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../../scripts/backup.mjs';
import { createScope, ROOT_DIR, runDeployScript } from '../support/owned-env.mjs';

let scope;
beforeAll(async () => { scope = await createScope('api-backup'); });
afterAll(async () => { await scope?.close(); });

const sha = (file) => JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'manifest.json'), 'utf8')).databaseSha256;

it('restore drill: back up a live stack, restore into a separate directory, verify it and serve the same listings', async () => {
  const chain = await scope.startChain();
  const dataDir = scope.tempDir();
  const deployed = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: 'campus-baseline' } });
  expect(deployed.code, deployed.output).toBe(0);
  let original, restoredApi;
  const api = await scope.startApi({ rpcUrl: chain.rpcUrl, dataDir });
  try {
    original = (await (await fetch(`${api.url}/api/listings`)).json()).listings;
    expect(original).toHaveLength(7);
    // Let the API's background indexer record a checkpoint so the manifest carries it.
    await expect.poll(async () => (await (await fetch(`${api.url}/api/index`)).json()).indexedBlock, { timeout: 30_000 }).not.toBeNull();

    // Backed up through the CLI while the API keeps running.
    const cli = spawnSync(process.execPath, ['scripts/backup.mjs'], { cwd: ROOT_DIR, env: { ...process.env, BIDPARK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toMatch(/7 listings, schema \d+, chain 31337/);
    const [stamp] = fs.readdirSync(path.join(dataDir, 'backups'));
    const backupDir = path.join(dataDir, 'backups', stamp);
    expect(JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'))).toMatchObject({
      database: 'bidpark.db', listingCount: 7,
      indexCheckpoint: { blockNumber: expect.any(Number), blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
      deployment: { profile: 'local', chainId: 31337, contractAddress: expect.any(String) },
    });

    const restoredDir = path.join(scope.tempDir(), 'restored');
    const restore = spawnSync(process.execPath, ['scripts/backup.mjs', 'restore', backupDir, restoredDir],
      { cwd: ROOT_DIR, env: { ...process.env, BIDPARK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true });
    expect(restore.status, restore.stderr).toBe(0);
    expect(restore.stdout).toContain('Verified 7 listings');

    restoredApi = await scope.startApi({ rpcUrl: chain.rpcUrl, dataDir: restoredDir });
    const restored = (await (await fetch(`${restoredApi.url}/api/listings`)).json()).listings;
    expect(restored).toEqual(original);
  } finally {
    await restoredApi?.stop();
    await api.stop();
    chain.provider.destroy();
  }
}, 180_000);

it('refuses damaged backups, tampered metadata, non-empty targets and the live directory', async () => {
  const chain = await scope.startChain();
  const dataDir = scope.tempDir();
  try {
    expect((await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: 'campus-expansion' } })).code).toBe(0);
  } finally {
    chain.provider.destroy();
  }
  const { dir } = createBackup({ dataDir });
  const db = path.join(dir, 'bidpark.db');

  expect(() => restoreBackup({ backupDir: dir, targetDir: dataDir, liveDataDir: dataDir })).toThrow(/live data directory/);
  const busy = scope.tempDir();
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'x');
  expect(() => restoreBackup({ backupDir: dir, targetDir: busy })).toThrow(/not empty/);

  fs.appendFileSync(db, 'corruption');
  expect(() => restoreBackup({ backupDir: dir, targetDir: path.join(scope.tempDir(), 'a') })).toThrow(/checksum does not match/);

  // A consistent-looking backup whose stored details no longer match their on-chain hash.
  const { dir: second } = createBackup({ dataDir, now: new Date(Date.now() + 1000) });
  const edit = new DatabaseSync(path.join(second, 'bidpark.db'));
  edit.prepare("UPDATE listings SET metadata_json = REPLACE(metadata_json, 'Quad Edge', 'Swapped') WHERE auction_id = '1'").run();
  edit.close();
  const manifestFile = path.join(second, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.databaseSha256 = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(second, 'bidpark.db'))).digest('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(sha(path.join(second, 'bidpark.db'))).toBe(manifest.databaseSha256);
  expect(() => restoreBackup({ backupDir: second, targetDir: path.join(scope.tempDir(), 'b') })).toThrow(/Metadata hash mismatch for auction #1/);
});

it('keeps only the newest backups', async () => {
  const dataDir = scope.tempDir();
  new DatabaseSync(path.join(dataDir, 'bidpark.db')).close();
  fs.writeFileSync(path.join(dataDir, 'deployment.json'), JSON.stringify({ chainId: 31337, contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }));
  const start = Date.parse('2026-01-01T00:00:00Z');
  let last;
  for (let i = 0; i < 4; i++) last = createBackup({ dataDir, keep: 2, now: new Date(start + i * 60_000) });
  expect(fs.readdirSync(path.join(dataDir, 'backups'))).toEqual(['20260101T000200000Z', '20260101T000300000Z']);
  expect(last.pruned).toEqual(['20260101T000100000Z']);
});
