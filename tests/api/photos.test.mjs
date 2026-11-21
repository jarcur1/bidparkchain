import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../server/app.mjs';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

// Wallet 1 hosts. Requests sent without its cookie are signed out.
const HOST = 1;
const LIMIT = 2 * 1024 * 1024;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const draft = {
  kind: 'draft', name: 'Uploaded photo', title: 'Elm St driveway', address: '12 Elm Street', description: 'Driveway.',
  minBidEth: '0.05', spaceId: '1', cutoff: '2030-03-01T22:30', start: '2030-03-02T00:00', end: '2030-03-02T08:00',
};

let scope, chain, deployment, runtime, server, url, cookie, dataDir, photoDir;

/** POSTs raw image bytes. `session: null` sends no cookie. */
const upload = (body, { session = cookie, type = 'application/octet-stream', query = '' } = {}) => fetch(`${url}/api/photos${query}`, {
  method: 'POST', body,
  headers: { 'Content-Type': type, ...(session ? { cookie: session } : {}) },
});
/** File names in the photo directory; none before the first upload creates it. */
const stored = () => (fs.existsSync(photoDir) ? fs.readdirSync(photoDir).sort() : []);

beforeAll(async () => {
  scope = await createScope('api-photos');
  chain = await scope.startChain();
  deployment = await deployEscrow(chain);
  for (let i = 0; i < 3; i++) await (await deployment.contract.connect(chain.wallet(HOST)).registerSpace()).wait();
  dataDir = scope.tempDir();
  photoDir = path.join(dataDir, 'photos');
  runtime = createApp({
    dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath: writeDeployment(dataDir, deployment), rpcUrl: chain.rpcUrl,
    photoDir,
  });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  cookie = await signInCookie(url, chain.wallet(HOST));
});
afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  runtime?.db.close();
  runtime?.provider.destroy();
  chain?.provider.destroy();
  await scope?.close();
});

it('requires a signed-in wallet to upload', async () => {
  const bytes = Buffer.concat([JPEG, Buffer.from('signed out')]);
  const res = await upload(bytes, { session: null });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('Sign in with your wallet first');
  expect(stored()).not.toContain(`${sha256(bytes)}.jpg`);
});

it('stores JPEG, PNG and WebP under their content hash and serves them publicly', async () => {
  for (const [bytes, ext, mime] of [[JPEG, 'jpg', 'image/jpeg'], [PNG, 'png', 'image/png'], [WEBP, 'webp', 'image/webp']]) {
    const res = await upload(bytes);
    expect(res.status, ext).toBe(201);
    const { path: photoPath } = await res.json();
    expect(photoPath).toBe(`/api/photos/${sha256(bytes)}.${ext}`);
    // No cookie: the photo is served to anyone who has its URL.
    const served = await fetch(`${url}${photoPath}`);
    expect(served.status, ext).toBe(200);
    expect(served.headers.get('content-type')).toBe(mime);
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  }
});

it('judges the bytes, not the declared type or a name in the query', async () => {
  for (const type of ['text/plain', 'application/json', 'image/gif']) {
    expect((await upload(JPEG, { type })).status, type).toBe(201);
  }
  expect((await upload(PNG, { query: '?name=../../escape.png' })).status).toBe(201);
  expect(fs.existsSync(path.join(dataDir, 'escape.png'))).toBe(false);
  expect(stored().every((name) => /^[0-9a-f]{64}\.(jpg|png|webp)$/.test(name))).toBe(true);
});

it('stores identical bytes once, with no temporary file and owner-only permissions', async () => {
  const first = await (await upload(WEBP)).json();
  expect(await (await upload(WEBP)).json()).toEqual(first);
  const name = first.path.replace('/api/photos/', '');
  expect(stored()).toContain(name);
  expect(stored().some((file) => file.endsWith('.tmp'))).toBe(false);
  expect(fs.statSync(path.join(photoDir, name)).mode & 0o077).toBe(0);
  expect(fs.statSync(photoDir).mode & 0o077).toBe(0);
});

it('accepts exactly 2 MB, refuses more with 413, and stores nothing for the refused upload', async () => {
  expect((await upload(Buffer.concat([JPEG, Buffer.alloc(LIMIT - JPEG.length)]))).status).toBe(201);
  const before = stored();
  const res = await upload(Buffer.concat([JPEG, Buffer.alloc(LIMIT + 1 - JPEG.length, 7)]));
  expect(res.status).toBe(413);
  expect((await res.json()).error).toBe('Photo must be 2 MB or smaller');
  expect(stored()).toEqual(before);
});

it('refuses bytes that are not a JPEG, PNG or WebP, whatever type they declare', async () => {
  const before = stored();
  const impostors = {
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    gif: Buffer.from('GIF89a' + '\0'.repeat(16)),
    pdf: Buffer.from('%PDF-1.4 not a photo'),
    json: Buffer.from('{"photo":true}'),
    truncatedJpeg: Buffer.from([0xff, 0xd8]),
    wave: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt ')]),
  };
  for (const [label, bytes] of Object.entries(impostors)) {
    const res = await upload(bytes, { type: 'image/jpeg' });
    expect(res.status, label).toBe(415);
    expect((await res.json()).error, label).toBe('Photo must be a JPEG, PNG or WebP image');
  }
  expect(stored()).toEqual(before);
});

it('asks for a file when the body is empty', async () => {
  const res = await upload(Buffer.alloc(0));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('Choose a photo to upload');
});

it('serves only names it stored', async () => {
  const name = `${sha256(JPEG)}.jpg`;
  for (const route of [
    `/api/photos/${'0'.repeat(64)}.jpg`, // well-formed, never stored
    `/api/photos/${name.toUpperCase()}`, // uppercase hex and extension
    `/api/photos/${sha256(JPEG)}.gif`, // extension never written
    '/api/photos/abc.jpg',
    '/api/photos/..%2F..%2Fbidpark.db', // decodes to a path outside the directory
  ]) {
    const res = await fetch(`${url}${route}`);
    expect(res.status, route).toBe(404);
  }
});

it('keeps the returned path in a draft, so the photo reloads with it', async () => {
  const { path: photoPath } = await (await upload(PNG)).json();
  const saved = await fetch(`${url}/api/drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ ...draft, image: photoPath }),
  });
  expect(saved.status).toBe(201);
  const listed = await (await fetch(`${url}/api/drafts`, { headers: { cookie } })).json();
  expect(listed.drafts).toEqual([expect.objectContaining({ name: 'Uploaded photo', image: photoPath })]);
});
