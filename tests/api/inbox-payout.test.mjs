import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const OWNER = 1, LISTER = 2, WINNER = 3, STRANGER = 4;
let scope, chain, deployment, runtime, server, url;
const cookies = {};
const parse = (eth) => ethers.parseEther(eth);
const escrow = (index) => deployment.contract.connect(chain.wallet(index));
const send = async (tx) => (await tx).wait();
const inbox = async (index) => {
  await runtime.syncIndexOnce();
  const res = await fetch(`${url}/api/inbox`, { headers: { cookie: cookies[index] } });
  expect(res.status).toBe(200);
  return res.json();
};
const feed = (body, id) => body.items.filter((item) => item.auctionId === id).map((item) => (item.change ? `booking:${item.change}` : item.kind));

beforeAll(async () => {
  scope = await createScope('api-inbox-payout');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  const dataDir = scope.tempDir();
  runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const index of [OWNER, LISTER, WINNER, STRANGER]) cookies[index] = await signInCookie(url, chain.wallet(index));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

const protect = async (host, tag, spaceId = 0) => {
  const now = await chain.latestTimestamp();
  const id = (await deployment.contract.nextAuctionId()).toString();
  const start = now + 600 + 3600;
  await send(escrow(host).createProtectedAuction(spaceId, ethers.id(tag), parse('0.01'), now + 600, start, start + 3600));
  await send(escrow(WINNER).bid(id, { value: parse('0.04') }));
  await chain.increaseTime(700);
  await send(escrow(STRANGER).settle(id));
  return id;
};

it('tells a host its payout is ready only once it can be claimed, then shows the claim', async () => {
  const id = await protect(OWNER, 'payout-ready');
  expect(feed(await inbox(OWNER), id)).toEqual([]);

  // Parking is over but a protected booking's payout is held for the report window.
  await chain.increaseTime(3600 + 3600 + 60);
  expect(feed(await inbox(OWNER), id)).toEqual([]);
  await chain.increaseTime(24 * 3600);
  const ready = await inbox(OWNER);
  expect(feed(ready, id)).toEqual(['payout-ready']);
  expect(ready.items.find((item) => item.kind === 'payout-ready')).toMatchObject({
    id: `payout-ready:${id}`, category: 'funds', amount: '0.04', read: false,
  });
  expect(feed(await inbox(WINNER), id)).toEqual(['won']);
  expect(feed(await inbox(STRANGER), id)).toEqual([]);

  // Dismissal works on it like any other entry; claiming replaces it with the claimed entry.
  await send(escrow(OWNER).claimPayout(id));
  expect(feed(await inbox(OWNER), id)).toEqual(['payout']);
});

it('keeps the payout back while a report is open and offers it once the report is denied', async () => {
  const resolver = 5;
  await send(deployment.contract.setResolver(chain.wallet(resolver).address, true));
  const id = await protect(OWNER, 'payout-disputed');
  await chain.increaseTime(3600 + 3600 + 60);
  await send(escrow(WINNER).reportSellerFailure(id, ethers.id('evidence')));
  await chain.increaseTime(24 * 3600);
  expect(feed(await inbox(OWNER), id)).toEqual(['booking:dispute-opened']);
  await send(escrow(resolver).resolveDispute(id, false, ethers.id('denied')));
  expect(feed(await inbox(OWNER), id)).toEqual(['payout-ready', 'booking:dispute-denied', 'booking:dispute-opened']);
});

it('tells a space owner about booking changes on an auction another lister created', async () => {
  await send(escrow(OWNER).registerSpace());
  const space = ((await deployment.contract.nextSpaceId()) - 1n).toString();
  await send(escrow(OWNER).setSpaceLister(space, chain.wallet(LISTER).address, true));
  const now = await chain.latestTimestamp();
  const id = (await deployment.contract.nextAuctionId()).toString();
  const start = now + 600 + 3 * 86400;
  await send(escrow(LISTER).createProtectedAuction(space, ethers.id('by-lister'), parse('0.01'), now + 600, start, start + 3600));
  await send(escrow(WINNER).bid(id, { value: parse('0.03') }));
  await chain.increaseTime(700);
  await send(escrow(STRANGER).settle(id));
  expect(feed(await inbox(OWNER), id)).toEqual([]);
  await send(escrow(WINNER).cancelBooking(id)); // more than a day ahead: refunded in full
  const owner = await inbox(OWNER);
  expect(feed(owner, id)).toEqual(['booking:refunded']);
  expect(owner.items[0]).toMatchObject({ role: 'host', byMe: false, category: 'bookings' });
  expect(feed(await inbox(LISTER), id)).toEqual(['booking:refunded']);
  expect(feed(await inbox(STRANGER), id)).toEqual([]);
  // After the space moves, the new owner hears of changes and the old one does not.
  await send(escrow(OWNER).transferSpace(space, chain.wallet(STRANGER).address));
  expect(feed(await inbox(STRANGER), id)).toEqual(['booking:refunded']);
  expect(feed(await inbox(OWNER), id)).toEqual([]);
});
