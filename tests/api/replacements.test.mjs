import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

let scope, chain, deployment, runtime, server, url;
const cookies = {};
const parse = ethers.parseEther;
let identity;
// Every link request names the deployment the host created the replacement on.
const post = (index, route, body) => fetch(`${url}${route}`, {
  method: 'POST', headers: { cookie: cookies[index], 'Content-Type': 'application/json' }, body: JSON.stringify({ deployment: identity, ...body }),
});

async function createAuction(signerIndex = 0) {
  const now = await chain.latestTimestamp();
  const id = await deployment.contract.nextAuctionId();
  await (await deployment.contract.connect(chain.wallet(signerIndex))
    .createAuction(ethers.id(`replace-${id}`), parse('0.01'), now + 600, now + 1200, now + 1800)).wait();
  return id.toString();
}

beforeAll(async () => {
  scope = await createScope('api-replacements');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  const dataDir = scope.tempDir();
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${url}/api/config`)).json();
  identity = { chainId: config.chainId, contractAddress: config.contractAddress, deploymentBlock: config.deploymentBlock, deploymentBlockHash: config.deploymentBlockHash };
  for (const index of [0, 1, 2]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('links a replacement for the host only, accepts a repeat of the same link, and tells the original bidders once', async () => {
  const original = await createAuction();
  const replacement = await createAuction();
  const unbid = await createAuction();
  await (await deployment.contract.connect(chain.wallet(1)).bid(original, { value: parse('0.02') })).wait();
  await (await deployment.contract.connect(chain.wallet(2)).bid(original, { value: parse('0.03') })).wait();
  await runtime.syncIndexOnce();
  const route = `/api/auctions/${original}/replacement`;

  expect((await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  expect((await post(0, route, { replacementId: original })).status).toBe(400);
  // A request naming another deployment (a reset chain, a different contract, or none) is refused before anything is recorded.
  for (const deployment of [{ ...identity, deploymentBlockHash: `0x${'11'.repeat(32)}` }, { ...identity, contractAddress: ethers.ZeroAddress }, undefined]) {
    expect((await post(0, route, { replacementId: replacement, deployment })).status).toBe(409);
  }
  expect((await post(1, route, { replacementId: replacement })).status).toBe(403);
  expect((await post(0, `/api/auctions/${unbid}/replacement`, { replacementId: String(Number(unbid) + 50) })).status).toBe(404);
  const noBids = await createAuction();
  expect((await post(0, `/api/auctions/${unbid}/replacement`, { replacementId: noBids })).status).toBe(409);

  expect((await post(0, route, { replacementId: replacement })).status).toBe(201);
  expect((await post(0, route, { replacementId: replacement })).status).toBe(200);
  // A different replacement for the same original is refused, and the recorded link is kept.
  expect((await post(0, route, { replacementId: await createAuction() })).status).toBe(409);
  expect(await (await fetch(`${url}${route}`)).json()).toEqual({ replacementId: replacement });

  const replaced = async (index) => (await (await fetch(`${url}/api/inbox`, { headers: { cookie: cookies[index] } })).json())
    .items.filter((item) => item.kind === 'replaced');
  // Both the outbid and the current high bidder are told, once each; the host (who never bid) is not.
  for (const index of [1, 2]) {
    await expect.poll(async () => (await replaced(index))[0], { timeout: 15000 }).toMatchObject({ auctionId: original, replacementId: replacement, category: 'bids' });
    expect(await replaced(index)).toHaveLength(1);
  }
  expect(await replaced(0)).toEqual([]);
});
