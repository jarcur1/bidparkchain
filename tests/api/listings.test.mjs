import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { canonicalizeAuctionId, createApp } from '../../server/app.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';
import { createScope, deployEscrow, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const metadata = {
  title: 'Downtown garage', address: '123 Main Street', neighborhood: 'Downtown',
  latitude: 30.2672, longitude: -97.7431, description: 'A secure covered parking space.',
  image: '/images/garage.jpg', kind: 'garage', amenities: ['Covered', 'Lighting'],
};
const hash = (value) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(value).normalized)));

// Every request uses an ephemeral listener, database, deployment and owned chain.
describe('listing API with real SQLite and onchain auctions', () => {
  let scope, chain, deployment, deploymentPath, runtime, server, url, snapshot, cookie;
  async function request(route, body, options = {}) {
    const response = await fetch(`${url}${route}`, {
      ...options,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      // Signed in as the deployer, which owns every auction these tests create.
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    const json = await response.json();
    if (response.status >= 400) {
      expect(json).toEqual({ error: expect.any(String) });
      expect(json.error).not.toMatch(/\n\s*at |node_modules|server\/app\.mjs/);
    }
    return { status: response.status, json, headers: response.headers };
  }
  const register = (auctionId = '1', value = metadata) => request('/api/listings', { auctionId, metadata: value });
  async function createAuction(value) {
    const now = await chain.latestTimestamp();
    const id = await deployment.contract.nextAuctionId();
    await (await deployment.contract.createAuction(hash(value), ethers.parseEther('0.01'), now + 3600, now + 7200, now + 10800)).wait();
    return id.toString();
  }
  beforeAll(async () => {
    scope = await createScope('api-listings');
    chain = await scope.startChain();
    snapshot = await chain.provider.send('evm_snapshot', []);
    deployment = await deployEscrow(chain);
    const dataDir = scope.tempDir();
    deploymentPath = writeDeployment(dataDir, deployment);
    runtime = createApp({ dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath, rpcUrl: chain.rpcUrl });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
    cookie = await signInCookie(url, chain.wallet(0));
    await createAuction(metadata);
  });
  afterAll(async () => {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      runtime?.db.close();
      runtime?.provider.destroy();
      chain?.provider.destroy();
      await scope?.close();
    }
  });

  it('requires a signed-in session, and only the auction owner may register details', async () => {
    expect((await request('/api/listings', { auctionId: '1', metadata }, { headers: { Cookie: '' } })).status).toBe(401);
    expect((await request('/api/listings/stage', { metadata }, { headers: { Cookie: '' } })).status).toBe(401);
    const stranger = await signInCookie(url, chain.wallet(5));
    const denied = await request('/api/listings', { auctionId: '1', metadata }, { headers: { Cookie: stranger } });
    expect(denied).toMatchObject({ status: 403, json: { error: "Only the auction's owner can register its details" } });
    expect(runtime.db.getListing('1', deployment.address)).toBeNull();
  });

  it('recovers delayed registration using canonical normalized metadata and is idempotent', async () => {
    const { json } = await request('/api/listings');
    const { json: config } = await request('/api/config');
    expect(json).toEqual({
      listings: [],
      // The auction exists on-chain before its metadata is registered: reported, not hidden.
      unindexed: [expect.objectContaining({ id: '1', metadataHash: hash(metadata), owner: chain.wallet(0).address })],
      chain: expect.objectContaining({
        contractAddress: deployment.address,
        deploymentBlockHash: config.deploymentBlockHash,
        chainTime: expect.any(Number),
      }),
    });
    const variant = Object.fromEntries(Object.entries(metadata).reverse().map(([key, value]) => [
      key, typeof value === 'string' && key !== 'kind' ? `  ${value}  ` : key === 'amenities' ? value.map((item) => ` ${item} `) : value,
    ]));
    expect(hash(variant)).toBe(hash(metadata));
    const created = await register('1', variant);
    expect(created.status).toBe(201);
    expect(created.json.listing).toMatchObject({ id: '1', spaceId: '1', timeZone: '', ...metadata, metadataHash: hash(metadata) });
    expect((await register(' 01 ')).status).toBe(200);
    expect(runtime.db.countListings(deployment.address)).toBe(1);
    expect((await request('/api/listings')).json.listings).toEqual([created.json.listing]);
    // The space's time zone is read from the chain with the listing.
    await (await deployment.contract.setSpaceTimeZone(1, 'America/Chicago')).wait();
    expect((await request('/api/listings')).json.listings).toEqual([{ ...created.json.listing, timeZone: 'America/Chicago' }]);
  });

  it.each([
    ['title', 'A different garage'], ['address', '456 Other Street'], ['neighborhood', 'Eastside'],
    ['latitude', 31], ['longitude', -98], ['description', 'A different parking description.'],
    ['image', '/images/other.jpg'], ['kind', 'driveway'], ['amenities', ['Lighting']],
  ])('rejects changing canonical field %s without changing the onchain hash', async (field, value) => {
    const result = await register('1', { ...metadata, [field]: value });
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/hash.*does not match/i);
    expect(runtime.db.getListing('1').metadata_hash).toBe(hash(metadata));
  });

  it.each(['0', '-1', '1.5', '0x1', '', '1e2', (2n ** 256n).toString(), 1, null, {}, []])('rejects invalid auction ID %j', async (id) => {
    expect(canonicalizeAuctionId(id)).toBeNull();
    expect((await register(id)).status).toBe(400);
  });
  it('accepts canonical positive uint256 shapes but rejects nonexistent auctions', async () => {
    expect(canonicalizeAuctionId(' 01 ')).toBe('1');
    const max = (2n ** 256n - 1n).toString();
    expect(canonicalizeAuctionId(max)).toBe(max);
    for (const id of ['999', max]) {
      const result = await register(id);
      expect(result.status).toBe(404);
      expect(result.json.error).toContain('does not exist onchain');
    }
  });

  it('serializes concurrent duplicate registrations into one consistent row', async () => {
    const value = { ...metadata, title: 'Concurrent garage' };
    const id = await createAuction(value);
    const results = await Promise.all(Array.from({ length: 8 }, () => register(id, value)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    for (const result of results) expect(result.json).toEqual(results[0].json);
    expect(runtime.db.getAllListings(deployment.address).filter((row) => row.auction_id === id)).toHaveLength(1);
  });

  const invalidMetadata = [
    ['object', null], ['array', []], ['primitive', 'metadata'],
    ...['title', 'address', 'neighborhood', 'description', 'image'].map((field) => [`${field} type`, { ...metadata, [field]: 7 }]),
    ...[['title', 3, 120], ['address', 5, 200], ['neighborhood', 2, 100], ['description', 10, 2000], ['image', 5, 1000]]
      .flatMap(([field, min, max]) => [[`${field} short`, { ...metadata, [field]: 'x'.repeat(min - 1) }], [`${field} long`, { ...metadata, [field]: 'x'.repeat(max + 1) }]]),
    ...['latitude', 'longitude'].flatMap((field) => [null, '', '30', true].map((value) => [`${field} ${JSON.stringify(value)}`, { ...metadata, [field]: value }])),
    ...[['latitude', -90.01], ['latitude', 90.01], ['longitude', -180.01], ['longitude', 180.01]].map(([field, value]) => [`${field} ${value}`, { ...metadata, [field]: value }]),
    ...['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///tmp/image.jpg', 'http://example.com/a.jpg', '//example.com/a.jpg', '/image with space.jpg', '/image<bad>.jpg', 'https://', 'http://localhost:bad/a.jpg', 'http://localhost:3000@evil.example/a.jpg'].map((image) => [`unsafe image ${image}`, { ...metadata, image }]),
    ...['parking', ' Garage ', null].map((kind) => [`kind ${kind}`, { ...metadata, kind }]),
    ...[null, 'Covered', Array(21).fill('Light'), [''], ['  '], [7], ['x'.repeat(61)]].map((amenities) => [`amenities ${JSON.stringify(amenities)}`, { ...metadata, amenities }]),
  ];
  it.each(invalidMetadata)('rejects invalid metadata: %s', async (_label, value) => {
    const validation = validateSpotMetadata(value);
    expect(validation.valid).toBe(false);
    const result = await register('1', value);
    expect(result.status).toBe(400);
    expect(result.json.error).toBe(validation.error);
  });
  it('rejects nonfinite coordinates before JSON serialization', () => {
    for (const field of ['latitude', 'longitude']) {
      for (const value of [NaN, Infinity, -Infinity]) expect(validateSpotMetadata({ ...metadata, [field]: value }).valid).toBe(false);
    }
  });
  it('accepts inclusive bounds, supported kinds, and safe image URL forms', async () => {
    const extremes = [
      { ...metadata, title: 'x'.repeat(3), address: 'x'.repeat(5), neighborhood: 'xx', description: 'x'.repeat(10), latitude: -90, longitude: -180, image: '/abcd', amenities: [] },
      { ...metadata, title: 'x'.repeat(120), address: 'x'.repeat(200), neighborhood: 'x'.repeat(100), description: 'x'.repeat(2000), latitude: 90, longitude: 180, image: `/${'x'.repeat(999)}`, amenities: Array(20).fill('x'.repeat(60)) },
      ...['https://example.com/image.jpg', 'http://127.0.0.1:9999/a.jpg', 'http://localhost:9999/a.jpg'].map((image, i) => ({ ...metadata, image, kind: ['garage', 'driveway', 'covered'][i] })),
    ];
    for (const value of extremes) {
      expect(validateSpotMetadata(value).valid).toBe(true);
      // A 404 proves API validation succeeded and reached the real contract lookup.
      expect((await register('999', value)).status).toBe(404);
    }
  });

  it('returns JSON for oversized/malformed bodies and unknown routes without leaking stacks', async () => {
    expect((await request('/api/listings', { padding: 'x'.repeat(103_000) })).status).toBe(413);
    expect((await request('/api/listings', undefined, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await request('/api/not-a-route')).status).toBe(404);
  });
  it('echoes only explicitly allowed loopback origins, including preflight', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:3001', 'http://localhost:3001']) {
      expect((await request('/api/config', undefined, { headers: { Origin: origin } })).headers.get('access-control-allow-origin')).toBe(origin);
      const preflight = await fetch(`${url}/api/listings`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
      expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    }
    for (const origin of ['https://evil.example', 'http://localhost:9999', 'http://localhost:5173.evil.example']) {
      expect((await request('/api/config', undefined, { headers: { Origin: origin } })).headers.get('access-control-allow-origin')).toBeNull();
    }
  });
  it('handles absent and malformed deployment files without exposing internals', async () => {
    const contents = fs.readFileSync(deploymentPath);
    try {
      for (const malformed of [false, true]) {
        if (malformed) fs.writeFileSync(deploymentPath, '{not json');
        else fs.unlinkSync(deploymentPath);
        expect((await request('/api/config')).status).toBe(503);
        expect((await request('/api/listings')).json).toEqual({ listings: [], chain: null });
        expect((await register()).status).toBe(503);
      }
    } finally { fs.writeFileSync(deploymentPath, contents); }
  });
  it('hides stale rows after an owned-chain reset and reconciles reused IDs', async () => {
    expect(await chain.provider.send('evm_revert', [snapshot])).toBe(true);
    const oldAddress = deployment.address;
    deployment = await deployEscrow(chain);
    expect(deployment.address).toBe(oldAddress);
    writeDeployment(path.dirname(deploymentPath), deployment);
    const replacement = { ...metadata, title: 'Replacement garage' };
    expect(await createAuction(replacement)).toBe('1');
    expect((await request('/api/listings')).json.listings).toEqual([]);
    expect((await register()).status).toBe(400);
    const result = await register('1', replacement);
    expect(result.status).toBe(201);
    // Space state rolled back with the chain: the reused space id has no time zone set.
    expect(result.json.listing).toMatchObject({ spaceId: '1', timeZone: '' });
    expect((await register('01', replacement)).status).toBe(200);
    expect((await request('/api/listings')).json.listings).toEqual([result.json.listing]);
    expect(runtime.db.getListing('1').title).toBe(replacement.title);
  });
  it('adds bidCount only while the event index is at the block the listings were read at', async () => {
    const id = await createAuction(metadata);
    expect((await register(id)).status).toBe(201);
    const read = async () => (await request('/api/listings')).json.listings.find((listing) => listing.id === id);
    expect(await read()).not.toHaveProperty('bidCount');
    await runtime.syncIndexOnce();
    expect((await read()).bidCount).toBe(0);
    await (await deployment.contract.connect(chain.wallet(1)).bid(id, { value: ethers.parseEther('0.02') })).wait();
    await (await deployment.contract.connect(chain.wallet(2)).bid(id, { value: ethers.parseEther('0.03') })).wait();
    // Two blocks past the checkpoint: the read brings the index up to the head first.
    expect((await read()).bidCount).toBe(2);
    // 51 blocks is past the default BIDPARK_SEARCH_INDEX_MAX_LAG of 50, so the count is left off.
    for (let i = 0; i < 51; i++) await chain.provider.send('evm_mine', []);
    expect(await read()).not.toHaveProperty('bidCount');
    await runtime.syncIndexOnce();
    expect((await read()).bidCount).toBe(2);
  });
  it('returns listing and configuration outage errors when its chain stops', async () => {
    await chain.stop();
    for (const result of [await request('/api/listings'), await register()]) {
      expect(result.status).toBe(503);
      expect(result.json.error).toMatch(/node is unavailable/);
    }
    const config = await request('/api/config');
    expect(config.status).toBe(503);
    expect(config.json.error).toMatch(/deployment block unavailable/i);
  });
});
