import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createApp } from '../../server/app.mjs';
import { validateSpotMetadata } from '../../shared/validation.js';
import { createScope, deployEscrow, findFreePort, writeDeployment } from '../support/owned-env.mjs';
import { signInCookie } from '../support/auth.mjs';

const base = {
  address: '123 Main Street', neighborhood: 'Downtown', description: 'A secure parking space.', image: '/images/garage.jpg',
};
const SPOTS = {
  garage: { ...base, title: 'Downtown garage', latitude: 30.2672, longitude: -97.7431, kind: 'garage', amenities: ['Covered', 'Lighting'] },
  driveway: { ...base, title: 'Rainey driveway', latitude: 30.2600, longitude: -97.7400, kind: 'driveway', amenities: ['EV charging'] },
  overnight: { ...base, title: 'North covered lot', latitude: 30.4000, longitude: -97.9000, kind: 'covered', amenities: ['Covered'] },
  cancelled: { ...base, title: 'Closed garage', latitude: 30.2680, longitude: -97.7430, kind: 'garage', amenities: ['Covered'] },
  broken: { ...base, title: 'Broken row', latitude: 30.2690, longitude: -97.7420, kind: 'garage', amenities: [] },
};
const hash = (value) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validateSpotMetadata(value).normalized)));
const H = 3600;

describe('GET /api/listings/search', () => {
  let scope, chain, deployment, deploymentPath, runtime, server, url, cookie, t0, dbPath;
  const ids = {};
  const close = async (srv, rt) => {
    if (srv) await new Promise((resolve) => srv.close(resolve));
    rt?.db.close();
    rt?.provider.destroy();
  };
  async function listen(app) {
    const srv = app.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    return { srv, url: `http://127.0.0.1:${srv.address().port}` };
  }
  async function search(query = '', at = url) {
    const response = await fetch(`${at}/api/listings/search${query ? `?${query}` : ''}`);
    const json = await response.json();
    if (response.status >= 400) expect(json).toEqual({ error: expect.any(String) });
    return { status: response.status, json };
  }
  const idsOf = (json) => json.listings.map((l) => l.id);
  async function list(name, minBid, bidEnd, start, end) {
    const id = (await deployment.contract.nextAuctionId()).toString();
    await (await deployment.contract.createAuction(hash(SPOTS[name]), ethers.parseEther(minBid), t0 + bidEnd, t0 + start, t0 + end)).wait();
    const res = await fetch(`${url}/api/listings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ auctionId: id, metadata: SPOTS[name] }),
    });
    expect(res.status).toBe(201);
    ids[name] = id;
  }

  beforeAll(async () => {
    scope = await createScope('api-search');
    chain = await scope.startChain();
    deployment = await deployEscrow(chain);
    const dataDir = scope.tempDir();
    deploymentPath = writeDeployment(dataDir, deployment);
    dbPath = path.join(dataDir, 'bidpark.db');
    runtime = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl });
    ({ srv: server, url } = await listen(runtime.app));
    cookie = await signInCookie(url, chain.wallet(0));
    t0 = await chain.latestTimestamp();
    await list('garage', '0.01', H, H, 3 * H);
    await list('driveway', '0.02', H / 3, 2 * H, 4 * H);
    await list('overnight', '0.005', 2 * H, 20 * H, 32 * H);
    await list('cancelled', '0.01', H, H, 3 * H);
    await list('broken', '0.01', H, H, 3 * H);
    await (await deployment.contract.cancel(ids.cancelled)).wait();
    runtime.db.db.prepare("UPDATE listings SET amenities = 'not json' WHERE auction_id = ?").run(ids.broken);
  });
  afterAll(async () => {
    try {
      await close(server, runtime);
    } finally {
      chain?.provider.destroy();
      await scope?.close();
    }
  });

  it('rejects malformed queries with 400 before touching the chain', async () => {
    const bad = [
      'color=red', 'kind=garage&kind=covered', 'kind=boat', 'arrive=abc', 'arrive=200&depart=100', 'arrive=100&depart=100',
      'radiusKm=2', 'near=30.2', 'near=91,0&radiusKm=1', 'near=30,-97&radiusKm=0', 'near=30,-97&radiusKm=101',
      'bbox=1,2,3', 'bbox=30.3,-97,30.2,-96', 'maxPrice=-1', 'maxPrice=1e3', 'minPrice=2&maxPrice=1',
      'sort=distance', 'sort=random', 'status=open', 'limit=0', 'limit=51', 'limit=2.5', 'cursor=!!', 'cursor=e30',
      `q=${'x'.repeat(101)}`, `amenity=${'y'.repeat(41)}`, Array.from({ length: 11 }, (_, i) => `amenity=a${i}`).join('&'),
    ];
    for (const query of bad) expect((await search(query)).status, query).toBe(400);
  });

  it('answers 503 for an outage and still 400 for a malformed query', async () => {
    const dead = createApp({ dbPath: path.join(scope.tempDir(), 'dead.db'), deploymentPath, rpcUrl: `http://127.0.0.1:${await findFreePort()}`, rpcTimeoutMs: 2000 });
    const { srv, url: deadUrl } = await listen(dead.app);
    try {
      expect(await search('', deadUrl)).toEqual({ status: 503, json: { error: expect.any(String) } });
      expect((await search('limit=0', deadUrl)).status).toBe(400);
    } finally {
      await close(srv, dead);
    }
  });

  it('pins the response to one block, states price semantics and skips malformed stored rows', async () => {
    const { status, json } = await search();
    expect(status).toBe(200);
    const head = await chain.provider.getBlock('latest');
    expect(json.chain).toMatchObject({ blockNumber: head.number, blockHash: head.hash, contractAddress: deployment.address });
    expect(json.pricing).toMatch(/neither is a final booking price/i);
    expect(json.skipped).toBe(1);
    expect(idsOf(json)).not.toContain(ids.broken);
    expect(json.total).toBe(4);
  });

  it('only returns windows that cover the whole visit, including edges and overnight', async () => {
    const q = (a, d) => search(`arrive=${t0 + a}&depart=${t0 + d}`).then((r) => idsOf(r.json));
    expect(await q(1.5 * H, 2.5 * H)).toEqual(expect.arrayContaining([ids.garage, ids.cancelled]));
    expect(await q(1.5 * H, 2.5 * H)).not.toContain(ids.driveway);
    // Ending exactly at the window end is covered; starting exactly at it is the next window's.
    expect(await q(2.5 * H, 3 * H)).toContain(ids.garage);
    expect(await q(3 * H, 3.5 * H)).toEqual([ids.driveway]);
    expect(await q(22 * H, 31 * H)).toEqual([ids.overnight]);
    expect(await q(19 * H, 21 * H)).toEqual([]);
    expect(await search(`arrive=${t0 + 2 * H}`).then((r) => idsOf(r.json).sort())).toEqual([ids.cancelled, ids.driveway, ids.garage].sort());
  });

  it('filters by area, kind, amenities, budget and availability, with distance sort', async () => {
    const near = `near=${SPOTS.garage.latitude},${SPOTS.garage.longitude}`;
    const within = await search(`${near}&radiusKm=2&sort=distance`);
    expect(idsOf(within.json)).toEqual([ids.garage, ids.cancelled, ids.driveway]);
    expect(within.json.listings[0].distanceKm).toBe(0);
    expect(idsOf((await search('bbox=30.39,-97.91,30.41,-97.89')).json)).toEqual([ids.overnight]);
    expect(idsOf((await search('kind=driveway')).json)).toEqual([ids.driveway]);
    expect(idsOf((await search('amenity=Covered&amenity=Lighting')).json)).toEqual([ids.garage]);
    expect(idsOf((await search('maxPrice=0.01&sort=price-asc')).json)).toEqual([ids.overnight, ids.garage, ids.cancelled]);
    expect(idsOf((await search('status=active&kind=garage')).json)).toEqual([ids.garage]);
    expect(idsOf((await search('q=rainey')).json)).toEqual([ids.driveway]);
  });

  it('keeps cursor pages on the first page\'s block while listings change, then expires the cursor on a reorg', async () => {
    const first = await search('limit=2&sort=price-asc');
    expect(first.json.total).toBe(4);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    // A bid moves the cheapest listing to the top price and a new listing appears.
    await (await deployment.contract.connect(chain.wallet(1)).bid(ids.overnight, { value: ethers.parseEther('1') })).wait();
    const snap = await chain.provider.send('evm_snapshot', []);
    await list('garage', '0.001', H, H, 3 * H);
    const second = await search(`limit=2&sort=price-asc&cursor=${first.json.nextCursor}`);
    expect(second.status).toBe(200);
    expect(second.json.chain).toEqual(first.json.chain);
    expect(second.json.nextCursor).toBeNull();
    const pages = [...idsOf(first.json), ...idsOf(second.json)];
    expect(new Set(pages).size).toBe(4);
    expect(pages[0]).toBe(ids.overnight);

    expect((await search(`limit=2&sort=price-desc&cursor=${first.json.nextCursor}`)).status).toBe(400);
    const fresh = await search('sort=price-asc');
    expect(fresh.json.listings.at(-1).id).toBe(ids.overnight);
    expect(fresh.json.listings[0].id).toBe(ids.garage);

    // Replacing the pinned block with a different one makes the cursor stale, not silently wrong.
    const pinned = await search('limit=1&sort=newest');
    await chain.provider.send('evm_revert', [snap]);
    await chain.provider.send('evm_mine', []);
    await chain.provider.send('evm_mine', []);
    expect((await search(`limit=1&sort=newest&cursor=${pinned.json.nextCursor}`)).status).toBe(409);
  });

  it('refuses queries that would read more candidates than the scan limit', async () => {
    const small = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl, searchScanLimit: 1 });
    const { srv, url: smallUrl } = await listen(small.app);
    try {
      expect((await search('', smallUrl)).status).toBe(422);
      expect((await search('kind=driveway', smallUrl)).status).toBe(200);
    } finally {
      await close(srv, small);
    }
  });

  it('pages GET /api/listings by auction id so a scan is bounded and unindexed auctions stay discoverable', async () => {
    runtime.db.db.prepare("UPDATE listings SET amenities = '[]' WHERE auction_id = ?").run(ids.broken);
    // On chain, never registered with the API: reported as unindexed.
    await (await deployment.contract.createAuction(ethers.id('unregistered'), ethers.parseEther('0.01'), t0 + H, t0 + H, t0 + 3 * H)).wait();
    const total = Number(await deployment.contract.nextAuctionId()) - 1;
    const get = async (query, at = url) => {
      const response = await fetch(`${at}/api/listings${query}`);
      return { status: response.status, json: await response.json() };
    };
    // Existing clients: no parameters, everything, no further page.
    const all = await get('');
    expect(all.json.nextCursor).toBeUndefined();
    expect(all.json.listings.length + all.json.unindexed.length).toBe(total);

    const small = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl, listingsScanLimit: 2 });
    const { srv, url: smallUrl } = await listen(small.app);
    try {
      const seen = [];
      const blocks = new Set();
      let cursor = '';
      let pages = 0;
      do {
        const { status, json } = await get(cursor ? `?cursor=${cursor}` : '', smallUrl);
        expect(status).toBe(200);
        expect(json.listings.length + json.unindexed.length).toBeLessThanOrEqual(2);
        seen.push(...json.listings.map((l) => l.id), ...json.unindexed.map((u) => u.id));
        blocks.add(json.chain.chainId);
        cursor = json.nextCursor ?? '';
        pages++;
      } while (cursor && pages < 20);
      expect(pages).toBe(Math.ceil(total / 2));
      expect(seen.sort((a, b) => a - b)).toEqual([...all.json.listings.map((l) => l.id), ...all.json.unindexed.map((u) => u.id)].sort((a, b) => a - b));
      expect(all.json.unindexed.map((u) => u.id)).toEqual([String(total)]);
      expect((await get('?limit=1', smallUrl)).json.nextCursor).toBe('2');
      for (const bad of ['limit=0', 'limit=3', 'limit=x', 'cursor=0', 'cursor=-1', 'cursor=1.5', 'cursor=a', 'skip=1', 'limit=1&limit=2']) {
        expect((await get(`?${bad}`, smallUrl)).status, bad).toBe(400);
      }
      expect((await get('?cursor=999', smallUrl)).json).toEqual(expect.objectContaining({ listings: [], unindexed: [] }));
    } finally {
      await close(srv, small);
    }
  });

  it('serves candidates from the event index, reads only the page on chain and falls back when the index lags', async () => {
    const idx = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl });
    const direct = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl, searchIndexMaxLag: -1 });
    const strict = createApp({ dbPath, deploymentPath, rpcUrl: chain.rpcUrl, searchIndexMaxLag: 0 });
    const servers = await Promise.all([idx, direct, strict].map((rt) => listen(rt.app)));
    const [idxUrl, directUrl, strictUrl] = servers.map((s) => s.url);
    let calls = 0;
    const send = idx.provider.send.bind(idx.provider);
    idx.provider.send = (method, params) => { calls++; return send(method, params); };
    try {
      await idx.syncIndexOnce();
      // ids.garage was reassigned by a reverted listing above; find the original by its title.
      const garageQuery = 'q=downtown%20garage';
      const [{ id: garage }] = (await search(garageQuery, directUrl)).json.listings;
      await (await deployment.contract.connect(chain.wallet(2)).bid(garage, { value: ethers.parseEther('0.05') })).wait();
      const near = `near=${SPOTS.garage.latitude},${SPOTS.garage.longitude}`;
      const queries = ['', 'sort=price-asc', 'sort=price-desc&limit=2', 'status=active', 'status=ended', 'sort=newest',
        `arrive=${t0 + 1.5 * H}&depart=${t0 + 2.5 * H}`, `${near}&radiusKm=2&sort=distance`, 'maxPrice=0.03&sort=starts-soon'];
      for (const query of queries) {
        const fromIndex = await search(query, idxUrl);
        const fromChain = await search(query, directUrl);
        expect(fromIndex.json.source, query).toBe('index');
        expect(fromChain.json.source, query).toBe('chain');
        expect(fromIndex.json.listings, query).toEqual(fromChain.json.listings);
        expect(fromIndex.json.total, query).toBe(fromChain.json.total);
        expect(fromIndex.json.chain.blockHash, query).toBe((await chain.provider.getBlock('latest')).hash);
      }

      // The index path reads the page (three calls a listing), not every candidate.
      calls = 0;
      expect((await search('limit=1', idxUrl)).json.listings).toHaveLength(1);
      const indexCalls = calls;
      const send2 = direct.provider.send.bind(direct.provider);
      calls = 0;
      direct.provider.send = (method, params) => { calls++; return send2(method, params); };
      const all = await search('limit=1', directUrl);
      expect(indexCalls).toBeLessThan(calls);
      expect(calls - indexCalls).toBeGreaterThanOrEqual(3 * (all.json.total - 1));

      // Within the lag threshold the index catches up first; beyond it search reads the chain.
      await chain.provider.send('evm_mine', []);
      expect((await search('', strictUrl)).json.source).toBe('chain');
      const caughtUp = await search('', idxUrl);
      expect(caughtUp.json).toMatchObject({ source: 'index', chain: { blockNumber: (await chain.provider.getBlock('latest')).number } });

      // A reorg replaces a bid: the index rewinds and serves the replacement.
      const snap = await chain.provider.send('evm_snapshot', []);
      await (await deployment.contract.connect(chain.wallet(3)).bid(garage, { value: ethers.parseEther('0.4') })).wait();
      expect((await search(garageQuery, idxUrl)).json.listings[0].highestBid).toBe('0.4');
      await chain.provider.send('evm_revert', [snap]);
      await (await deployment.contract.connect(chain.wallet(3)).bid(garage, { value: ethers.parseEther('0.3') })).wait();
      await chain.provider.send('evm_mine', []);
      const replaced = await search(garageQuery, idxUrl);
      expect(replaced.json.source).toBe('index');
      expect(replaced.json.listings[0].highestBid).toBe('0.3');

      // State the index cannot vouch for is read from the chain instead.
      const garageCreated = "event = 'AuctionCreated' AND auction_id = ? AND canonical = 1";
      runtime.db.db.prepare(`UPDATE auction_events SET detail = json_set(detail, '$.bidEnd', 1) WHERE ${garageCreated}`).run(garage);
      const disagreed = await search(garageQuery, idxUrl);
      expect(disagreed.json).toMatchObject({ source: 'chain', listings: [{ id: garage, highestBid: '0.3' }] });
      runtime.db.db.prepare(`UPDATE auction_events SET detail = NULL WHERE ${garageCreated}`).run(garage);
      expect((await search(garageQuery, idxUrl)).json.source).toBe('chain');
      await chain.provider.send('evm_mine', []);
      expect((await search(garageQuery, idxUrl)).json.source).toBe('index');
    } finally {
      for (const [i, rt] of [idx, direct, strict].entries()) await close(servers[i].srv, rt);
    }
  });

  it('keeps unavailable inventory out of active results, reading the chain when verification is required', async () => {
    const verified = await deployEscrow(chain, true);
    const dir = scope.tempDir();
    const rt = createApp({ dbPath: path.join(dir, 'bidpark.db'), deploymentPath: writeDeployment(dir, verified), rpcUrl: chain.rpcUrl });
    const { srv, url: vUrl } = await listen(rt.app);
    try {
      const host = verified.contract;
      const verifier = host.connect(chain.wallet(1));
      await (await host.setSpaceVerifier(chain.wallet(1).address, true)).wait();
      const now = await chain.latestTimestamp();
      const listVerified = async (name) => {
        const space = await host.nextSpaceId();
        await (await host.registerSpace()).wait();
        await (await verifier.setSpaceVerification(space, chain.wallet(0).address, 0, ethers.id(`stall-${name}`), hash(SPOTS[name]))).wait();
        const id = (await host.nextAuctionId()).toString();
        await (await host.createSpaceAuction(space, hash(SPOTS[name]), ethers.parseEther('0.01'), now + H, now + H, now + 3 * H)).wait();
        rt.db.upsertListing({ ...validateSpotMetadata(SPOTS[name]).normalized, auctionId: id, contractAddress: verified.address, metadataHash: hash(SPOTS[name]) });
        return { id, space };
      };
      const open = await listVerified('garage');
      const blocked = await listVerified('driveway');
      // Suspending the space's approval makes its auction unavailable.
      await (await verifier.setSpaceVerification(blocked.space, chain.wallet(0).address, 0, ethers.ZeroHash, ethers.ZeroHash)).wait();
      await rt.syncIndexOnce();
      const all = await search('sort=newest', vUrl);
      expect(all.json).toMatchObject({ source: 'index', total: 2 });
      expect(all.json.listings.map((l) => [l.id, l.inventoryBlocked])).toEqual([[blocked.id, true], [open.id, false]]);
      expect((await search('status=active', vUrl)).json).toMatchObject({ source: 'chain', total: 1, listings: [{ id: open.id }] });
    } finally {
      await close(srv, rt);
    }
  });
});
