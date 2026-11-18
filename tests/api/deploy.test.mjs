import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EscrowDatabase } from '../../server/db.mjs';
import { createScope, ROOT_DIR, runDeployScript } from '../support/owned-env.mjs';

// Read-only fingerprint: deployment must never create or change files in the checkout's data/.
function dataFingerprint(dir) {
  if (!fs.existsSync(dir)) return null;
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? dataFingerprint(file) : createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}

let scope;
beforeAll(async () => { scope = await createScope('api-deploy'); });
afterAll(async () => { await scope?.close(); });

it('deploys, resumes and reseeds only the owned chain and temp data directory', async () => {
  const repoData = path.join(ROOT_DIR, 'data');
  const before = dataFingerprint(repoData);
  const dataDir = scope.tempDir();
  const firstChain = await scope.startChain();
  let secondChain, api, db;
  const descriptor = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'deployment.json'), 'utf8'));
  const deploy = async (chain) => {
    const result = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir });
    expect(result.code, result.output).toBe(0);
    return result.output;
  };
  const listings = async () => {
    const response = await fetch(`${api.url}/api/listings`);
    expect(response.status).toBe(200);
    return (await response.json()).listings;
  };
  try {
    await deploy(firstChain);
    const first = descriptor();
    const contract = new ethers.Contract(first.contractAddress, first.abi, firstChain.provider);
    expect(await contract.nextAuctionId()).toBe(8n);
    api = await scope.startApi({ rpcUrl: firstChain.rpcUrl, dataDir });
    const initial = await listings();
    expect(initial).toHaveLength(7);
    expect(new Set(initial.map((listing) => listing.id)).size).toBe(7);
    expect(new Set(initial.map((listing) => listing.metadataHash)).size).toBe(7);
    const config = await (await fetch(`${api.url}/api/config`)).json();
    expect(config.contractAddress).toBe(first.contractAddress);

    const block = await firstChain.provider.getBlockNumber();
    expect(await deploy(firstChain)).toContain('Skipping');
    expect(descriptor()).toEqual(first);
    expect(await contract.nextAuctionId()).toBe(8n);
    expect(await firstChain.provider.getBlockNumber()).toBe(block);
    expect(await listings()).toEqual(initial);

    // Model an interrupted seed after auctions were mined but metadata commits were lost.
    db = new EscrowDatabase(path.join(dataDir, 'bidpark.db'));
    db.db.prepare("DELETE FROM listings_metadata WHERE auction_id IN ('2', '4', '7')").run();
    db.setMeta(`seed_status_${first.contractAddress}`, 'pending');
    expect(db.countListings(first.contractAddress)).toBe(4);
    db.close();
    db = undefined;
    expect(await deploy(firstChain)).toContain('Resuming existing seed auction');
    expect(descriptor()).toEqual(first);
    expect(await contract.nextAuctionId()).toBe(8n);
    expect(await firstChain.provider.getBlockNumber()).toBe(block);
    expect(await listings()).toEqual(initial);
    db = new EscrowDatabase(path.join(dataDir, 'bidpark.db'));
    expect(db.getMeta(`seed_status_${first.contractAddress}`)).toBe('completed');
    expect(db.countListings(first.contractAddress)).toBe(7);

    // A stale same-address row must be purged even when deterministic deployment reuses an address.
    const row = db.getListing('1');
    db.upsertListing({
      auctionId: '999', contractAddress: first.contractAddress, metadataHash: row.metadata_hash,
      title: 'STALE OLD CHAIN', address: row.address, neighborhood: row.neighborhood,
      latitude: row.latitude, longitude: row.longitude, description: row.description,
      image: row.image, kind: row.kind, amenities: JSON.parse(row.amenities),
    });
    db.close();
    db = undefined;
    await api.stop();
    api = undefined;
    await firstChain.stop();
    secondChain = await scope.startChain();
    expect(await secondChain.provider.getCode(first.contractAddress)).toBe('0x');
    expect(await deploy(secondChain)).toContain('Deploying new ParkingAuctionEscrow');
    const fresh = descriptor();
    expect(fresh.contractAddress).toBe(first.contractAddress);
    expect(await secondChain.provider.getCode(fresh.contractAddress)).not.toBe('0x');
    const freshContract = new ethers.Contract(fresh.contractAddress, fresh.abi, secondChain.provider);
    expect(await freshContract.nextAuctionId()).toBe(8n);
    api = await scope.startApi({ rpcUrl: secondChain.rpcUrl, dataDir });
    expect(await listings()).toHaveLength(7);
    db = new EscrowDatabase(path.join(dataDir, 'bidpark.db'));
    expect(db.getListing('999')).toBeNull();
    expect(db.countListings(fresh.contractAddress)).toBe(7);
    expect(db.getMeta(`seed_status_${fresh.contractAddress}`)).toBe('completed');
  } finally {
    db?.close();
    await api?.stop();
    firstChain.provider.destroy();
    secondChain?.provider.destroy();
    expect(dataFingerprint(repoData)).toEqual(before);
  }
}, 180_000);
