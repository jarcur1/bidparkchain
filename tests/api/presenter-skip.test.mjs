import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { resolveRuntimeProfile } from '../../scripts/helpers/runtime-profile.mjs';
import { createScope, runDeployScript } from '../support/owned-env.mjs';
import { createSepoliaFixture } from '../support/sepolia-fixture.mjs';

const ABSENT = { error: 'API route POST /presenter/skip not found' };

let scope;
let chain;
let deployment;
let dataDir;
let fixture;
let server;
let appRuntime;
let url;

async function startApi(runtime, options = {}) {
  appRuntime = createApp({ runtime, ...options });
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
async function postSkip(body) {
  const response = await fetch(`${url}/api/presenter/skip`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
const chainTimestamp = async () => (await chain.provider.getBlock('latest')).timestamp;

// Latest `field` deadline among the auctions that a skip to that deadline has to pass, read from the chain.
async function latestDeadline(field, inPlay) {
  const contract = new ethers.Contract(deployment.contractAddress, deployment.abi, chain.provider);
  let latest = 0n;
  for (let id = 1n; id < (await contract.nextAuctionId()); id++) {
    const auction = await contract.auctions(id);
    if (inPlay(auction) && auction[field] > latest) latest = auction[field];
  }
  return Number(latest);
}
const localRuntime = (overrides = {}) => resolveRuntimeProfile({ BIDPARK_DATA_DIR: dataDir, RPC_URL: chain.rpcUrl, ...overrides });

beforeAll(async () => {
  scope = await createScope('api-presenter-skip');
  dataDir = scope.tempDir();
  chain = await scope.startChain();
  const deployed = await runDeployScript({ rpcUrl: chain.rpcUrl, dataDir, env: { BIDPARK_SCENARIO: 'campus-baseline' } });
  expect(deployed.code, deployed.output).toBe(0);
  deployment = JSON.parse(fs.readFileSync(path.join(dataDir, 'deployment.json'), 'utf8'));
}, 180_000);
beforeAll(async () => { fixture = await createSepoliaFixture(); }, 120_000);
afterEach(stopApi);
afterAll(async () => {
  await fixture?.close();
  chain?.provider.destroy();
  await scope?.close();
});

it('moves chain time past the latest open bidding close, then has nothing left to skip', async () => {
  await startApi(localRuntime());
  const bidEnd = await latestDeadline('bidEnd', (a) => !a.settled && !a.cancelled);
  expect(await chainTimestamp()).toBeLessThan(bidEnd);

  const first = await postSkip({ target: 'bidding' });
  expect(first.status).toBe(200);
  expect(first.json.advancedSeconds).toBeGreaterThan(0);
  expect(await chainTimestamp()).toBeGreaterThan(bidEnd);

  const second = await postSkip({ target: 'bidding' });
  expect(second.status).toBe(200);
  expect(second.json.advancedSeconds).toBe(0);
}, 180_000);

it('moves chain time past the latest parking end that is not cancelled', async () => {
  await startApi(localRuntime());
  const parkingEnd = await latestDeadline('parkingEnd', (a) => !a.cancelled);

  const skipped = await postSkip({ target: 'parking' });
  expect(skipped.status).toBe(200);
  expect(skipped.json.advancedSeconds).toBeGreaterThan(0);
  expect(await chainTimestamp()).toBeGreaterThan(parkingEnd);
}, 180_000);

it('rejects an unknown target', async () => {
  await startApi(localRuntime());
  const response = await postSkip({ target: 'settle' });
  expect(response.status).toBe(400);
  expect(response.json).toEqual({ error: 'target must be "bidding" or "parking"' });
}, 120_000);

it('is absent when the RPC host is not loopback', async () => {
  await startApi(localRuntime(), { rpcUrl: 'http://example.com:8545' });
  const response = await postSkip({ target: 'bidding' });
  expect(response.status).toBe(404);
  expect(response.json).toEqual(ABSENT);
}, 120_000);

it('is absent when the chain is not the local Hardhat chain', async () => {
  await startApi(resolveRuntimeProfile({ BIDPARK_DATA_DIR: scope.tempDir(), RPC_URL: fixture.rpcUrl }));
  const response = await postSkip({ target: 'bidding' });
  expect(response.status).toBe(404);
  expect(response.json).toEqual(ABSENT);
}, 120_000);

it('is absent under the sepolia profile', async () => {
  await startApi(resolveRuntimeProfile(fixture.env(scope.tempDir())));
  const response = await postSkip({ target: 'bidding' });
  expect(response.status).toBe(404);
  expect(response.json).toEqual(ABSENT);
}, 120_000);
