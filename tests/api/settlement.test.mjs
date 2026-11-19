import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { EscrowDatabase } from '../../server/db.mjs';
import { syncIndex } from '../../server/indexer.mjs';
import { createSettlementJob, settlementSettings } from '../../server/settlement.mjs';
import { serve } from '../../server/index.mjs';
import { NETWORK_PROFILES } from '../../shared/network-profiles.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';

let scope, chain, deployment;
const local = NETWORK_PROFILES.local;
const parse = (eth) => ethers.parseEther(eth);
const loadDeployment = () => ({ contractAddress: deployment.address, abi: deployment.abi });

async function createAuction({ bidEndIn = 600 } = {}) {
  const now = await chain.latestTimestamp();
  const id = await deployment.contract.nextAuctionId();
  await (await deployment.contract.createAuction(ethers.id(`spot-${id}`), parse('0.01'), now + bidEndIn, now + bidEndIn + 600, now + bidEndIn + 1200)).wait();
  return id.toString();
}
const bid = async (index, id, eth) => (await deployment.contract.connect(chain.wallet(index)).bid(id, { value: parse(eth) })).wait();
const onChain = (id) => deployment.contract.auctions(id);

/** A fresh database, indexed to the head, and a keeper over it. */
async function keeper({ db, wallet = chain.wallet(9), ...settings } = {}) {
  db ??= new EscrowDatabase(path.join(scope.tempDir(), 'bidpark.db'));
  await syncIndex({ db, provider: chain.provider, address: deployment.address, abi: deployment.abi, fromBlock: deployment.deploymentBlock });
  const job = createSettlementJob({
    db, provider: chain.provider, profile: local, loadDeployment, abiFor: (d) => d.abi,
    settings: { wallet, intervalMs: 1000, retryBaseMs: 0, retryMaxMs: 0, dropAfterMs: 0, now: Date.now, ...settings },
  });
  return { db, job, run: () => job.runOnce(), get: (id) => db.getSettlementJob(deployment.address, id) };
}
const automine = (on) => chain.provider.send('evm_setAutomine', [on]);
const mine = () => chain.provider.send('evm_mine', []);

beforeAll(async () => {
  scope = await createScope('api-settlement');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
});
afterAll(async () => {
  chain?.provider.destroy();
  await scope?.close();
});

it('settles due auctions with bids, skips the rest, and confirms on the next pass', async () => {
  const due = await createAuction();
  await bid(1, due, '0.02');
  const noBids = await createAuction();
  const later = await createAuction({ bidEndIn: 500_000 });
  await bid(2, later, '0.02');
  await chain.increaseTime(700);
  const k = await keeper();

  expect(await k.run()).toMatchObject({ error: null, pending: 1 });
  expect(k.get(due)).toMatchObject({ status: 'sent', attempts: 1, tx_hash: expect.stringMatching(/^0x/) });
  expect((await onChain(due)).settled).toBe(true);
  expect(await k.run()).toMatchObject({ pending: 0 });
  expect(k.get(due).status).toBe('confirmed');
  expect([k.get(noBids), k.get(later)]).toEqual([null, null]);
  expect((await onChain(noBids)).settled).toBe(false);
  expect((await onChain(later)).settled).toBe(false);
  expect(k.job.status()).toMatchObject({ enabled: true, keeper: chain.wallet(9).address, pending: 0, jobs: { confirmed: 1, failed: 0 }, recentFailures: [] });
  k.db.close();
});

it('treats a manual settlement that lands first, or alongside, as success', async () => {
  const first = await createAuction();
  await bid(1, first, '0.02');
  const race = await createAuction();
  await bid(1, race, '0.02');
  await chain.increaseTime(700);
  const k = await keeper();
  await (await deployment.contract.connect(chain.wallet(5)).settle(first)).wait();

  await automine(false);
  try {
    await deployment.contract.connect(chain.wallet(5)).settle(race);
    await k.run();
    await mine();
  } finally {
    await automine(true);
  }
  expect((await onChain(race)).settled).toBe(true);
  expect(await k.run()).toMatchObject({ error: null, pending: 0 });
  expect(k.get(first)).toBeNull();
  expect(k.db.getSettlementSummary(deployment.address)).toMatchObject({ recentFailures: [] });
  k.db.close();
});

it('never sends twice for an auction across a restart, and resends only after a drop', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await chain.increaseTime(700);
  const keeperAddress = chain.wallet(9).address;
  const first = await keeper();
  await automine(false);
  let sent;
  try {
    expect(await first.run()).toMatchObject({ pending: 1 });
    sent = first.get(id).tx_hash;
    const nonce = await chain.provider.getTransactionCount(keeperAddress, 'pending');
    // A restarted process over the same database sees the transaction in flight and waits.
    const restarted = await keeper({ db: first.db });
    expect(await restarted.run()).toMatchObject({ pending: 1 });
    expect(await chain.provider.getTransactionCount(keeperAddress, 'pending')).toBe(nonce);

    // Dropped from the mempool: recorded, then sent again on the next pass.
    await chain.provider.send('hardhat_dropTransaction', [sent]);
    await restarted.run();
    expect(first.get(id)).toMatchObject({ status: 'failed', last_error: 'DROPPED', attempts: 1 });
    await restarted.run();
    expect(first.get(id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await chain.provider.getTransaction(first.get(id).tx_hash)).not.toBeNull();
    await mine();
  } finally {
    await automine(true);
  }
  expect(await first.run()).toMatchObject({ pending: 0 });
  expect(first.get(id).status).toBe('confirmed');
  first.db.close();
});

it('keeps a broadcast whose RPC response was lost as sent instead of sending again', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await chain.increaseTime(700);
  const k = await keeper();
  const keeperAddress = chain.wallet(9).address;
  const nonce = await chain.provider.getTransactionCount(keeperAddress);
  chain.provider.broadcastTransaction = async function (signed) {
    delete this.broadcastTransaction;
    await this.broadcastTransaction(signed);
    throw Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' });
  };
  expect(await k.run()).toMatchObject({ pending: 1 });
  expect(k.get(id)).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
  expect(await k.run()).toMatchObject({ pending: 0 });
  expect(k.get(id).status).toBe('confirmed');
  expect(await chain.provider.getTransactionCount(keeperAddress)).toBe(nonce + 1);
  k.db.close();
});

it('backs off with a redacted reason while the keeper cannot pay, then recovers once funded', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await chain.increaseTime(700);
  let clock = Date.now();
  const wallet = ethers.Wallet.createRandom();
  const k = await keeper({ wallet, retryBaseMs: 60_000, retryMaxMs: 600_000, now: () => clock });

  await k.run();
  expect(k.get(id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'INSUFFICIENT_FUNDS', next_attempt_at: clock + 60_000 });
  await k.run();
  expect(k.get(id).attempts).toBe(1);
  clock += 60_000;
  await k.run();
  expect(k.get(id)).toMatchObject({ attempts: 2, next_attempt_at: clock + 120_000 });
  expect(k.job.status().recentFailures).toEqual([{ auctionId: id, attempts: 2, error: 'INSUFFICIENT_FUNDS', nextAttemptAt: clock + 120_000, updatedAt: clock }]);

  await (await chain.wallet(0).sendTransaction({ to: wallet.address, value: parse('1') })).wait();
  clock += 120_000;
  await k.run();
  expect(k.get(id)).toMatchObject({ status: 'sent', attempts: 3, last_error: null });
  await k.run();
  expect(k.get(id).status).toBe('confirmed');
  k.db.close();
});

it('settles again when a reorg undoes its settlement', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await chain.increaseTime(700);
  const k = await keeper();
  const snapshot = await chain.provider.send('evm_snapshot', []);
  await k.run();
  await syncIndex({ db: k.db, provider: chain.provider, address: deployment.address, abi: deployment.abi, fromBlock: deployment.deploymentBlock });
  await k.run();
  expect(k.get(id).status).toBe('confirmed');

  await chain.provider.send('evm_revert', [snapshot]);
  await mine();
  await syncIndex({ db: k.db, provider: chain.provider, address: deployment.address, abi: deployment.abi, fromBlock: deployment.deploymentBlock });
  expect((await onChain(id)).settled).toBe(false);
  expect(await k.run()).toMatchObject({ pending: 1 });
  expect(k.get(id)).toMatchObject({ status: 'sent', attempts: 2 });
  await k.run();
  expect(k.get(id).status).toBe('confirmed');
  k.db.close();
});

it('is off by default and never signs with a demo or deployer key on Sepolia', () => {
  const sepolia = NETWORK_PROFILES.sepolia;
  const demoKey = chain.wallet(0).privateKey;
  const own = ethers.Wallet.createRandom();
  expect(settlementSettings({}, {}, local)).toBeNull();
  expect(settlementSettings({}, { BIDPARK_SETTLEMENT: 'off' }, sepolia)).toBeNull();
  expect(settlementSettings({}, { BIDPARK_SETTLEMENT: '1' }, local).wallet.address).toBe(chain.wallet(0).address);
  expect(() => settlementSettings({}, { BIDPARK_SETTLEMENT: '1' }, sepolia)).toThrow('BIDPARK_KEEPER_KEY is required');
  expect(() => settlementSettings({}, { BIDPARK_SETTLEMENT: '1', BIDPARK_KEEPER_KEY: demoKey }, sepolia)).toThrow('dedicated keeper key');
  expect(() => settlementSettings({}, { BIDPARK_SETTLEMENT: '1', BIDPARK_KEEPER_KEY: own.privateKey, BIDPARK_SEPOLIA_DEPLOYER_KEY: own.privateKey }, sepolia))
    .toThrow('dedicated keeper key');
  expect(() => settlementSettings({}, { BIDPARK_SETTLEMENT: '1', BIDPARK_KEEPER_KEY: '0xnot-a-key' }, sepolia)).toThrow(/^Invalid BIDPARK_KEEPER_KEY$/);
  expect(() => settlementSettings({}, { BIDPARK_SETTLEMENT: '1', BIDPARK_SETTLEMENT_INTERVAL_MS: '10' }, local)).toThrow('at least 1000');
  const settings = settlementSettings({}, { BIDPARK_SETTLEMENT: 'true', BIDPARK_KEEPER_KEY: own.privateKey }, sepolia);
  expect(settings).toMatchObject({ intervalMs: 30_000 });
  expect(settings.wallet.address).toBe(own.address);
});

it('runs on a timer in the API, reports status and readiness, and drains on shutdown', async () => {
  const id = await createAuction();
  await bid(1, id, '0.02');
  await chain.increaseTime(700);
  const dataDir = scope.tempDir();
  const common = { port: 0, dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl };

  const off = serve({ ...common, indexIntervalMs: 0 });
  await new Promise((resolve) => off.server.once('listening', resolve));
  const offUrl = `http://127.0.0.1:${off.server.address().port}`;
  expect(await (await fetch(`${offUrl}/api/settlement`)).json()).toEqual({ enabled: false });
  expect((await (await fetch(`${offUrl}/api/health/ready`)).json()).checks).not.toHaveProperty('settlement');
  await off.close();

  const api = serve({ ...common, indexIntervalMs: 200, settlement: { enabled: true, keeperKey: chain.wallet(8).privateKey, intervalMs: 1000 } });
  await new Promise((resolve) => api.server.once('listening', resolve));
  const url = `http://127.0.0.1:${api.server.address().port}`;
  try {
    await expect.poll(async () => (await (await fetch(`${url}/api/settlement`)).json()).jobs?.confirmed, { timeout: 20_000 }).toBeGreaterThan(0);
    const status = await (await fetch(`${url}/api/settlement`)).json();
    expect(status).toMatchObject({ enabled: true, keeper: chain.wallet(8).address, confirmation: 'mined', lastRunError: null, recentFailures: [] });
    expect(JSON.stringify(status)).not.toContain(chain.wallet(8).privateKey.slice(2));
    expect((await onChain(id)).settled).toBe(true);
    const ready = await (await fetch(`${url}/api/health/ready`)).json();
    expect(ready.checks.settlement).toBe('ok');
  } finally {
    await api.close();
  }
  expect(api.db.db.isOpen).toBe(false);
});

it('settles a protected booking only before parking starts and leaves an expired one to expire()', async () => {
  const c = deployment.contract;
  const now = await chain.latestTimestamp();
  const settleable = (await c.nextAuctionId()).toString();
  await (await c.createProtectedAuction(0, ethers.id('protected-a'), parse('0.01'), now + 600, now + 2400, now + 4000)).wait();
  const expired = (await c.nextAuctionId()).toString();
  await (await c.createProtectedAuction(0, ethers.id('protected-b'), parse('0.01'), now + 300, now + 2100, now + 4000)).wait();
  await bid(1, settleable, '0.02');
  await bid(2, expired, '0.02');
  await chain.increaseTime(2200);
  const k = await keeper();
  await k.run();
  expect((await onChain(settleable)).settled).toBe(true);
  expect(k.get(expired)).toBe(null);
  expect((await onChain(expired)).settled).toBe(false);
  k.db.close();
});
