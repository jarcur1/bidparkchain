import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

// Wallet 1 owns a space and lists for wallet 3; wallet 2 has neither a space nor a draft; wallet 4 only a draft.
const OWNER = 1;
const NEWCOMER = 2;
const LISTER = 3;
const DRAFTER = 4;
const photo = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, n)]);
const draft = {
  kind: 'draft', name: 'Photo draft', title: 'Elm St driveway', address: '12 Elm Street', description: 'Driveway.',
  minBidEth: '0.05', spaceId: '1', cutoff: '2030-03-01T22:30', start: '2030-03-02T00:00', end: '2030-03-02T08:00',
};

let scope, chain, deployment, runtime, server, url, photoDir;
const cookies = {};
const upload = (n, who = OWNER) => fetch(`${url}/api/photos`, {
  method: 'POST', body: photo(n), headers: { 'Content-Type': 'application/octet-stream', cookie: cookies[who] },
});
const stored = () => (fs.existsSync(photoDir) ? fs.readdirSync(photoDir).sort() : []);
const saveDraft = (who, image) => fetch(`${url}/api/drafts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookies[who] }, body: JSON.stringify({ ...draft, image }),
});

beforeAll(async () => {
  scope = await createScope('api-photos-limits');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  const space = (await (await deployment.contract.connect(chain.wallet(OWNER)).registerSpace()).wait());
  expect(space.status).toBe(1);
  await (await deployment.contract.connect(chain.wallet(OWNER)).setSpaceLister(1, chain.wallet(LISTER).address, true)).wait();
  const dataDir = scope.tempDir();
  photoDir = path.join(dataDir, 'photos');
  // Three photos per wallet; 314 bytes of storage holds four 68-byte photos.
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
    photoDir, photos: { perWallet: 3, storageMb: 0.0003, graceHours: 24 },
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  for (const who of [OWNER, NEWCOMER, LISTER, DRAFTER]) cookies[who] = await signInCookie(url, chain.wallet(who));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await runtime?.photos.done();
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('refuses wallets with no space and no draft, and allows a lister or a saved draft', async () => {
  const refused = await upload(10, NEWCOMER);
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toContain('Save a draft first');
  expect(stored()).toEqual([]);

  expect((await upload(11, LISTER)).status).toBe(201);

  expect((await upload(12, DRAFTER)).status).toBe(403);
  expect((await saveDraft(DRAFTER, '')).status).toBe(201);
  expect((await upload(12, DRAFTER)).status).toBe(201);
});

it('caps photos per wallet and total storage, and counts identical bytes once', async () => {
  // Owner: 13, 14, 15 fill the quota of 3; repeating one of them is not a new photo.
  for (const n of [13, 14, 15]) expect((await upload(n)).status).toBe(201);
  expect((await upload(13)).status).toBe(201);
  const over = await upload(16);
  expect(over.status).toBe(429);
  expect((await over.json()).error).toContain('3 uploaded photos');
  expect(stored()).toHaveLength(5);

  // 5 photos (340 bytes) already exceed 314, so the store is full for anyone adding bytes.
  const full = await upload(17, DRAFTER);
  expect(full.status).toBe(413);
  expect((await full.json()).error).toContain('storage is full');
  // Bytes already stored cost nothing.
  expect((await upload(13, DRAFTER)).status).toBe(201);
});

it('reclaims unreferenced photos after the grace period and never a referenced one', async () => {
  const kept = await (await upload(13)).json();
  expect((await saveDraft(OWNER, kept.path)).status).toBe(201);
  const before = stored();

  // Inside the grace period nothing is removed.
  expect(await runtime.photos.sweep(Date.now() + 23 * 3_600_000)).toBe(0);
  expect(stored()).toEqual(before);

  const later = Date.now() + 25 * 3_600_000;
  expect(await runtime.photos.sweep(later)).toBeGreaterThan(0);
  expect(stored()).toEqual([kept.path.split('/').pop()]);
  expect((await fetch(`${url}${kept.path}`)).status).toBe(200);

  // Space is free again for new uploads.
  expect((await upload(16)).status).toBe(201);
});
