import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { EscrowDatabase, SCHEMA_VERSION } from '../../server/db.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const SEPOLIA = 11155111;
const A = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const B = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const spot = (title) => ({
  title, address: '123 Main Street', neighborhood: 'Downtown', latitude: 30.2672, longitude: -97.7431,
  description: 'A secure covered parking space.', image: '/images/garage.jpg', kind: 'garage', amenities: ['Covered'],
});
const canonical = (value) => JSON.stringify(validateSpotMetadata(value).normalized);
const hash = (value) => ethers.keccak256(ethers.toUtf8Bytes(canonical(value)));
const row = (auctionId, contractAddress, value) => ({ ...value, auctionId, contractAddress, metadataHash: hash(value) });

let scope;
beforeAll(async () => { scope = await createScope('api-durable'); });
afterAll(async () => { await scope?.close(); });

describe('schema migrations and composite identity', () => {
  it('migrates a pre-versioned database without losing rows, and refuses a newer schema', () => {
    const file = path.join(scope.tempDir(), 'bidpark.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE deployment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE listings_metadata (auction_id TEXT PRIMARY KEY, contract_address TEXT NOT NULL,
        metadata_hash TEXT NOT NULL, title TEXT NOT NULL, address TEXT NOT NULL, neighborhood TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, description TEXT NOT NULL, image TEXT NOT NULL,
        kind TEXT NOT NULL, amenities TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    const insert = legacy.prepare('INSERT INTO listings_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [id, title] of [['1', 'First'], ['2', 'Second']]) {
      const v = spot(title);
      insert.run(id, A, hash(v), v.title, v.address, v.neighborhood, v.latitude, v.longitude, v.description, v.image, v.kind, JSON.stringify(v.amenities), 1700000000);
    }
    legacy.prepare("INSERT INTO deployment_meta VALUES ('seed_status_x', 'completed')").run();
    legacy.close();

    const db = new EscrowDatabase(file, { chainId: SEPOLIA });
    expect(Number(db.db.prepare('PRAGMA user_version').get().user_version)).toBe(SCHEMA_VERSION);
    expect(db.getAllListings(A).map((r) => [r.chain_id, r.auction_id, r.title, r.created_at]))
      .toEqual([[SEPOLIA, '1', 'First', 1700000000], [SEPOLIA, '2', 'Second', 1700000000]]);
    expect(db.getMeta('seed_status_x')).toBe('completed');
    db.close();

    const reopened = new EscrowDatabase(file, { chainId: SEPOLIA });
    expect(reopened.countListings(A)).toBe(2);
    reopened.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    reopened.close();
    expect(() => new EscrowDatabase(file, { chainId: SEPOLIA })).toThrow(/newer than this code supports/);
  });

  it('keeps equal auction ids apart across contracts and chains; only the local chain can be reset', () => {
    const file = path.join(scope.tempDir(), 'bidpark.db');
    const local = new EscrowDatabase(file);
    const sepolia = new EscrowDatabase(file, { chainId: SEPOLIA });
    local.upsertListing(row('1', A, spot('Local A')));
    local.upsertListing(row('1', B.toLowerCase(), spot('Local B')));
    sepolia.upsertListing(row('1', A, spot('Sepolia A')));
    local.recordDeployment({ contractAddress: A, deploymentTxHash: '0x01', deploymentBlock: 1, profile: 'local' });
    local.recordDeployment({ contractAddress: A, deploymentTxHash: '0x01', deploymentBlock: 1, profile: 'local' });

    expect(local.getListing('1', A).title).toBe('Local A');
    expect(local.getListing('1', B).title).toBe('Local B');
    expect(sepolia.getListing('1', A).title).toBe('Sepolia A');
    expect(local.getListing('1', A).metadata_json).toBe(canonical(spot('Local A')));
    expect(local.getDeployments()).toHaveLength(1);

    expect(local.resetLocalDemo()).toBe(2);
    expect(local.countListings(A) + local.countListings(B)).toBe(0);
    expect(local.getDeployments()).toHaveLength(1);
    expect(sepolia.getListing('1', A).title).toBe('Sepolia A');
    expect(() => sepolia.resetLocalDemo()).toThrow(/only allowed on the local chain/);
    local.close();
    sepolia.close();
  });
});

describe('registration recovery against an owned chain', () => {
  let chain, deployment, runtime, server, url, cookie;
  const call = async (route, body) => {
    const response = await fetch(`${url}${route}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };
  const createAuction = async (value) => {
    const now = await chain.latestTimestamp();
    const id = await deployment.contract.nextAuctionId();
    await (await deployment.contract.createAuction(hash(value), ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
    return id.toString();
  };
  beforeAll(async () => {
    chain = await scope.startChain();
    deployment = await deployEscrow(chain);
    const dataDir = scope.tempDir();
    runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
    cookie = await signInCookie(url, chain.wallet(0));
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    runtime?.db.close();
    runtime?.provider.destroy();
    chain?.provider.destroy();
  });

  it('records the served deployment', async () => {
    expect((await call('/api/config')).status).toBe(200);
    expect(runtime.db.getDeployments()).toEqual([
      expect.objectContaining({ contract_address: deployment.address.toLowerCase(), deployment_tx_hash: deployment.deploymentTxHash }),
    ]);
  });

  it('recovers an interrupted registration from metadata staged before the transaction', async () => {
    const value = spot('Staged before signing');
    expect((await call('/api/listings/stage', { metadata: { ...value, title: `  ${value.title}  ` } })).json)
      .toEqual({ metadataHash: hash(value) });
    expect((await call('/api/listings/stage', { metadata: value })).status).toBe(200);
    const id = await createAuction(value);
    // No POST /api/listings: the browser was closed after the transaction.
    const { json } = await call('/api/listings');
    expect(json.listings.map((l) => [l.id, l.title])).toContainEqual([id, value.title]);
    expect(json.unindexed.map((a) => a.id)).not.toContain(id);
    expect(runtime.db.getListing(id, deployment.address).metadata_json).toBe(canonical(value));

    // Replaying the registration afterwards is idempotent.
    expect((await call('/api/listings', { auctionId: id, metadata: value })).status).toBe(200);
    expect(runtime.db.getAllListings(deployment.address).filter((r) => r.auction_id === id)).toHaveLength(1);
  });

  it('rejects invalid staged metadata', async () => {
    expect((await call('/api/listings/stage', { metadata: { ...spot('x'), kind: 'boat' } })).status).toBe(400);
  });

  it('reports an auction without metadata, and one whose stored metadata no longer matches after a rollback', async () => {
    const unknown = await createAuction(spot('Never registered'));
    let { json } = await call('/api/listings');
    expect(json.unindexed).toContainEqual(expect.objectContaining({ id: unknown, metadataHash: hash(spot('Never registered')), parkingStart: expect.any(Number), parkingEnd: expect.any(Number), settled: false, cancelled: false, booking: expect.anything(), timeZone: expect.any(String) }));

    const snapshot = await chain.provider.send('evm_snapshot', []);
    const original = spot('Before rollback');
    const id = await createAuction(original);
    expect((await call('/api/listings', { auctionId: id, metadata: original })).status).toBe(201);
    await chain.provider.send('evm_revert', [snapshot]);
    const replacement = spot('After rollback');
    expect(await createAuction(replacement)).toBe(id);

    ({ json } = await call('/api/listings'));
    expect(json.listings.map((l) => l.id)).not.toContain(id);
    expect(json.unindexed).toContainEqual(expect.objectContaining({ id, metadataHash: hash(replacement) }));
    // Registering the replacement reconciles the reused id.
    expect((await call('/api/listings', { auctionId: id, metadata: replacement })).status).toBe(201);
    ({ json } = await call('/api/listings'));
    expect(json.listings.find((l) => l.id === id).title).toBe('After rollback');
  });
});
