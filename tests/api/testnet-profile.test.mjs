import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { resolveRuntimeProfile } from '../../scripts/helpers/runtime-profile.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';
import { createSepoliaFixture, runProfileDeploy } from '../support/sepolia-fixture.mjs';

const metadata = {
  title: 'Downtown garage', address: '123 Main Street', neighborhood: 'Downtown',
  latitude: 30.2672, longitude: -97.7431, description: 'A secure covered parking space.',
  image: 'https://example.test/parking.jpg', kind: 'garage', amenities: ['Covered', 'Lighting'],
};
let fixture;
let server;
let appRuntime;
let url;

async function startApi(env) {
  appRuntime = createApp({ runtime: resolveRuntimeProfile(env) });
  server = appRuntime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
}
async function stopApi() {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  appRuntime?.db.close();
  appRuntime?.provider.destroy();
  appRuntime = undefined;
}
async function request(route, body) {
  const response = await fetch(`${url}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
const descriptorAt = (dataDir) => path.join(dataDir, 'deployment.json');

beforeAll(async () => { fixture = await createSepoliaFixture(); }, 60_000);
afterAll(async () => { await stopApi(); await fixture?.close(); });

it('rejects invalid profiles, missing isolated state, and unsafe RPC configuration', () => {
  expect(() => resolveRuntimeProfile({ BIDPARK_PROFILE: '' })).toThrow();
  expect(() => resolveRuntimeProfile({ BIDPARK_PROFILE: 'unknown' })).toThrow();
  expect(() => resolveRuntimeProfile({ BIDPARK_PROFILE: 'sepolia', BIDPARK_SEPOLIA_RPC_URL: fixture.rpcUrl })).toThrow();
  expect(() => resolveRuntimeProfile({ BIDPARK_PROFILE: 'sepolia', BIDPARK_DATA_DIR: fixture.scope.tempDir(), BIDPARK_SEPOLIA_RPC_URL: 'http://example.com' })).toThrow();
  expect(() => resolveRuntimeProfile({ BIDPARK_PROFILE: 'local', RPC_URL: 'https://example.com' })).toThrow();
});

it('persists a verified deployment and finalized listings across CLI and API restarts without exposing secrets', async () => {
  const dataDir = fixture.scope.tempDir();
  const env = fixture.env(dataDir);
  const missing = await runProfileDeploy(env);
  expect(missing.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(dataDir))).toBe(false);
  const created = await runProfileDeploy({ ...env, BIDPARK_SEPOLIA_DEPLOYER_KEY: fixture.key }, ['--create']);
  expect(created.code, created.output).toBe(0);
  const descriptorText = fs.readFileSync(descriptorAt(dataDir), 'utf8');
  const descriptor = JSON.parse(descriptorText);
  expect(descriptor.chainId).toBe(11155111);
  expect(ethers.isAddress(descriptor.contractAddress)).toBe(true);
  expect(descriptor.deploymentTxHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(descriptorText).not.toContain(fixture.key);
  expect(descriptorText).not.toContain(fixture.rpcUrl);
  expect(descriptorText).not.toMatch(/demoMnemonic|test test test test/);
  const contract = new ethers.Contract(descriptor.contractAddress, descriptor.abi, fixture.wallet);
  expect(await contract.nextAuctionId()).toBe(1n);
  const before = await fixture.provider.getBlockNumber();
  const reused = await runProfileDeploy(env);
  expect(reused.code, reused.output).toBe(0);
  expect(fs.readFileSync(descriptorAt(dataDir), 'utf8')).toBe(descriptorText);
  expect(await fixture.provider.getBlockNumber()).toBe(before);

  await startApi(env);
  const config = await request('/api/config');
  const deployment = {
    chainId: config.json.chainId,
    contractAddress: config.json.contractAddress,
    deploymentBlock: config.json.deploymentBlock,
    deploymentBlockHash: config.json.deploymentBlockHash,
  };
  expect((await request('/api/listings', { auctionId: '1', metadata, deployment: { ...deployment, chainId: 31337 } })).status).toBe(409);
  expect(config.status).toBe(200);
  expect(config.json).toMatchObject({ profile: 'sepolia', chainId: 11155111, confirmation: 'finalized', contractAddress: descriptor.contractAddress });
  const publicText = JSON.stringify(config.json);
  for (const secret of [fixture.key, fixture.rpcUrl, 'private-operator-token', 'demoMnemonic', 'demoAccountIndex']) expect(publicText).not.toContain(secret);
  expect((await request('/api/listings')).json.listings).toEqual([]);

  const normalized = validateSpotMetadata(metadata).normalized;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(normalized)));
  const timestamp = (await fixture.provider.getBlock('latest')).timestamp;
  const finalizedBefore = await fixture.provider.getBlockNumber();
  fixture.setFinalized(finalizedBefore);
  await (await contract.createAuction(hash, ethers.parseEther('0.01'), timestamp + 3600, timestamp + 7200, timestamp + 10800)).wait();
  const pending = await request('/api/listings', { auctionId: '1', metadata, deployment });
  expect(pending.status).not.toBe(200);
  expect(pending.status).not.toBe(201);
  expect((await request('/api/listings')).json.listings).toEqual([]);
  fixture.setFinalized(null);
  const registered = await request('/api/listings', { auctionId: '1', metadata, deployment });
  expect(registered.status).toBe(201);
  expect(registered.json.listing.id).toBe('1');
  const stableBlock = await fixture.provider.getBlockNumber();
  fixture.setFinalized(stableBlock);
  await (await contract.cancel(1)).wait();
  const finalizedListing = await request('/api/listings');
  expect(finalizedListing.status).toBe(200);
  expect(finalizedListing.json.listings).toHaveLength(1);
  expect(finalizedListing.json.listings[0].cancelled).toBe(false);
  fixture.setFinalized(null);
  expect((await request('/api/listings')).json.listings[0].cancelled).toBe(true);
  await stopApi();
  const restarted = await runProfileDeploy(env);
  expect(restarted.code, restarted.output).toBe(0);
  const local = await fixture.scope.startChain();
  const localRestart = await runProfileDeploy({ BIDPARK_PROFILE: 'local', BIDPARK_DATA_DIR: dataDir, RPC_URL: local.rpcUrl });
  expect(localRestart.code).not.toBe(0);
  expect(fs.readFileSync(descriptorAt(dataDir), 'utf8')).toBe(descriptorText);
  const dbPath = path.join(dataDir, 'bidpark-sepolia.db');
  const dbBefore = fs.readFileSync(dbPath);
  const savedDescriptor = path.join(dataDir, 'saved-deployment.json');
  fs.renameSync(descriptorAt(dataDir), savedDescriptor);
  const localHead = await local.provider.getBlockNumber();
  const missingDescriptor = await runProfileDeploy({ BIDPARK_PROFILE: 'local', BIDPARK_DATA_DIR: dataDir, RPC_URL: local.rpcUrl });
  expect(missingDescriptor.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(dataDir))).toBe(false);
  expect(fs.existsSync(path.join(dataDir, 'bidpark.db'))).toBe(false);
  expect(fs.readFileSync(dbPath)).toEqual(dbBefore);
  expect(fs.readFileSync(savedDescriptor, 'utf8')).toBe(descriptorText);
  expect(await local.provider.getBlockNumber()).toBe(localHead);
  fs.renameSync(savedDescriptor, descriptorAt(dataDir));
  await local.stop();
  await startApi(env);
  const persisted = await request('/api/listings');
  expect(persisted.status).toBe(200);
  expect(persisted.json.listings).toHaveLength(1);
  expect(persisted.json.listings[0]).toMatchObject({ id: '1', title: metadata.title, cancelled: true });
  fixture.setRejectHashPins(true);
  try {
    expect((await request('/api/config')).status).toBe(503);
    expect((await request('/api/listings')).status).toBe(503);
  } finally {
    fixture.setRejectHashPins(false);
  }
  fixture.setFailure(true);
  expect((await request('/api/config')).status).toBe(503);
  expect((await request('/api/listings')).status).toBe(503);
  const offline = await runProfileDeploy(env);
  expect(offline.code).not.toBe(0);
  expect(fs.readFileSync(descriptorAt(dataDir), 'utf8')).toBe(descriptorText);
  fixture.setFailure(false);
  await stopApi();
}, 180_000);

it('resumes the same signed creation transaction after a pre-broadcast interruption without a key', async () => {
  const dataDir = fixture.scope.tempDir();
  const env = fixture.env(dataDir);
  const pendingPath = `${descriptorAt(dataDir)}.pending`;
  const startBroadcasts = fixture.broadcasts.length;
  const nonce = await fixture.provider.getTransactionCount(fixture.wallet.address);
  fixture.declineNextBroadcast();
  const interrupted = await runProfileDeploy({ ...env, BIDPARK_SEPOLIA_DEPLOYER_KEY: fixture.key }, ['--create']);
  expect(interrupted.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(dataDir))).toBe(false);
  const journalText = fs.readFileSync(pendingPath, 'utf8');
  const journal = JSON.parse(journalText);
  expect(ethers.keccak256(journal.signedTransaction)).toBe(journal.deploymentTxHash);
  expect(fixture.broadcasts.slice(startBroadcasts)).toEqual([journal.signedTransaction]);
  expect(await fixture.provider.getTransactionCount(fixture.wallet.address)).toBe(nonce);
  expect(await fixture.provider.getTransaction(journal.deploymentTxHash)).toBeNull();

  const resumed = await runProfileDeploy(env, ['--resume']);
  expect(resumed.code, resumed.output).toBe(0);
  expect(fixture.broadcasts.slice(startBroadcasts)).toEqual([journal.signedTransaction, journal.signedTransaction]);
  const descriptor = JSON.parse(fs.readFileSync(descriptorAt(dataDir), 'utf8'));
  expect(descriptor.deploymentTxHash).toBe(journal.deploymentTxHash);
  const receipt = await fixture.provider.getTransactionReceipt(journal.deploymentTxHash);
  expect(receipt.status).toBe(1);
  expect(receipt.contractAddress.toLowerCase()).toBe(descriptor.contractAddress.toLowerCase());
  expect(await fixture.provider.getTransactionCount(fixture.wallet.address)).toBe(nonce + 1);
  const reused = await runProfileDeploy(env);
  expect(reused.code, reused.output).toBe(0);
  expect(fixture.broadcasts.slice(startBroadcasts)).toEqual([journal.signedTransaction, journal.signedTransaction]);
  for (const output of [interrupted.output, resumed.output, reused.output]) {
    for (const secret of [fixture.key, fixture.rpcUrl, 'private-operator-token', journal.signedTransaction]) expect(output).not.toContain(secret);
  }
}, 180_000);

it('fails closed for wrong-chain and malformed deployment metadata without sending transactions or replacing it', async () => {
  const dataDir = fixture.scope.tempDir();
  const env = fixture.env(dataDir);
  const local = await fixture.scope.startChain();
  const wrongChain = await runProfileDeploy({ ...env, BIDPARK_SEPOLIA_RPC_URL: local.rpcUrl, BIDPARK_SEPOLIA_DEPLOYER_KEY: fixture.key }, ['--create']);
  expect(wrongChain.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(dataDir))).toBe(false);
  const demoKey = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').privateKey;
  const demo = await runProfileDeploy({ ...env, BIDPARK_SEPOLIA_DEPLOYER_KEY: demoKey }, ['--create']);
  expect(demo.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(dataDir))).toBe(false);
  const invalid = '{"chainId":31337,"contractAddress":"0x0000000000000000000000000000000000000001"}';
  fs.writeFileSync(descriptorAt(dataDir), invalid);
  const before = await fixture.provider.getBlockNumber();
  for (const args of [[], ['--create']]) {
    const result = await runProfileDeploy({ ...env, BIDPARK_SEPOLIA_DEPLOYER_KEY: fixture.key }, args);
    expect(result.code).not.toBe(0);
    expect(fs.readFileSync(descriptorAt(dataDir), 'utf8')).toBe(invalid);
    expect(await fixture.provider.getBlockNumber()).toBe(before);
  }
  await expect(startApi(env)).rejects.toThrow();
  expect(fs.existsSync(path.join(dataDir, 'bidpark-sepolia.db'))).toBe(false);
}, 120_000);

it('imports a finalized owned deployment by transaction hash and then reuses it without a key', async () => {
  const sourceDir = fixture.scope.tempDir();
  const targetDir = fixture.scope.tempDir();
  const source = fixture.env(sourceDir);
  const create = await runProfileDeploy({ ...source, BIDPARK_SEPOLIA_DEPLOYER_KEY: fixture.key }, ['--create']);
  expect(create.code, create.output).toBe(0);
  const original = JSON.parse(fs.readFileSync(descriptorAt(sourceDir), 'utf8'));
  const target = fixture.env(targetDir);
  fixture.setFinalized(original.deploymentBlock - 1);
  const unfinalized = await runProfileDeploy(target, ['--adopt', original.deploymentTxHash]);
  expect(unfinalized.code).not.toBe(0);
  expect(fs.existsSync(descriptorAt(targetDir))).toBe(false);
  fixture.setFinalized(null);
  const adopted = await runProfileDeploy(target, ['--adopt', original.deploymentTxHash]);
  expect(adopted.code, adopted.output).toBe(0);
  const imported = JSON.parse(fs.readFileSync(descriptorAt(targetDir), 'utf8'));
  expect(imported.contractAddress).toBe(original.contractAddress);
  expect(imported.deploymentTxHash).toBe(original.deploymentTxHash);
  const reuse = await runProfileDeploy(target);
  expect(reuse.code, reuse.output).toBe(0);
  const forged = { ...imported, deploymentBlockHash: `0x${'11'.repeat(32)}` };
  const forgedText = JSON.stringify(forged);
  fs.writeFileSync(descriptorAt(targetDir), forgedText);
  const mismatch = await runProfileDeploy(target);
  expect(mismatch.code).not.toBe(0);
  expect(fs.readFileSync(descriptorAt(targetDir), 'utf8')).toBe(forgedText);
  await startApi(target);
  expect((await request('/api/config')).status).toBe(503);
  await stopApi();
}, 180_000);
