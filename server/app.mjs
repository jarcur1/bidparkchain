import fs from 'node:fs';
import express from 'express';
import { ethers } from 'ethers';
import { EscrowDatabase } from './db.mjs';
import { validateSpotMetadata } from '../shared/validation.js';
import { assertProfileDirectory, resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';
import { verifyPersistentDeployment } from '../scripts/helpers/persistent-deployment.mjs';
import { compileEscrowContract } from '../scripts/helpers/compiler.mjs';
import { getNetworkProfile } from '../shared/network-profiles.mjs';
import { mountAuth, readSession } from './auth.mjs';
import { syncIndex } from './indexer.mjs';
import { deriveInbox } from './inbox.mjs';
import { PRICE_NOTE, QueryError, encodeCursor, filterAndSort, matchesMetadata, parseSearchQuery } from './search.mjs';

let sepoliaArtifact;

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

/**
 * Settings for a public deployment. Setting BIDPARK_ALLOWED_ORIGINS (exact origins, comma-separated)
 * turns on hosted mode: only those origins get CORS, cross-origin writes are refused, and writes are
 * rate-limited per client. Local development keeps its loopback defaults when it is unset.
 */
export function publicSettings(options = {}, env = process.env) {
  const configured = options.allowedOrigins ??
    (env.BIDPARK_ALLOWED_ORIGINS ? env.BIDPARK_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : null);
  for (const origin of configured ?? []) {
    let url;
    try { url = new URL(origin); } catch { throw new Error(`Invalid allowed origin: ${origin}`); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
      throw new Error(`Allowed origins must be exact https:// origins (or loopback http://): ${origin}`);
    }
  }
  const hosted = Boolean(configured);
  return {
    hosted,
    allowedOrigins: hosted ? new Set(configured) : ALLOWED_ORIGINS,
    writesPerMinute: options.writesPerMinute ?? Number(env.BIDPARK_WRITES_PER_MINUTE ?? (hosted ? 60 : 0)),
    trustProxy: options.trustProxy ?? env.BIDPARK_TRUST_PROXY ?? false,
    rpcTimeoutMs: options.rpcTimeoutMs ?? Number(env.BIDPARK_RPC_TIMEOUT_MS ?? 10_000),
    // Listing search: at most this many candidates are read from the chain per request, within this deadline.
    searchScanLimit: options.searchScanLimit ?? Number(env.BIDPARK_SEARCH_SCAN_LIMIT ?? 500),
    searchDeadlineMs: options.searchDeadlineMs ?? Number(env.BIDPARK_SEARCH_DEADLINE_MS ?? 20_000),
  };
}

const MAX_URL_LENGTH = 2048;
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
/** Policy for the built web app: its own scripts only, OSM tiles and listing photos over https, Google Fonts. */
export const WEB_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: https:", "connect-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const MAX_UINT256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

/**
 * Validates and canonicalizes a positive bounded uint256 auction ID.
 * Rejects 0, negatives, floats, non-numeric strings, and numbers > 2^256 - 1.
 * Normalizes leading zeros ('01' -> '1') to prevent duplicate registrations.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function canonicalizeAuctionId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  try {
    const val = BigInt(trimmed);
    if (val <= 0n || val > MAX_UINT256) return null;
    return val.toString();
  } catch {
    return null;
  }
}

function listingFromRow(id, onchain, row, [spaceId, timeZone]) {
  return {
    id, spaceId: spaceId.toString(), timeZone, owner: onchain.owner,
    minBid: ethers.formatEther(onchain.minBid),
    highestBid: ethers.formatEther(onchain.highestBid),
    highestBidder: onchain.highestBidder,
    bidEnd: Number(onchain.bidEnd),
    parkingStart: Number(onchain.parkingStart),
    parkingEnd: Number(onchain.parkingEnd),
    settled: Boolean(onchain.settled),
    cancelled: Boolean(onchain.cancelled),
    payoutClaimed: Boolean(onchain.payoutClaimed),
    metadataHash: onchain.metadataHash,
    title: row.title, address: row.address, neighborhood: row.neighborhood,
    latitude: Number(row.latitude), longitude: Number(row.longitude),
    description: row.description, image: row.image, kind: row.kind,
    amenities: JSON.parse(row.amenities),
  };
}

/** Stored metadata of a listing row, or null when the row is malformed (it is skipped, not a 503). */
function rowMetadata(row) {
  try {
    const amenities = JSON.parse(row.amenities);
    const meta = { ...row, latitude: Number(row.latitude), longitude: Number(row.longitude), amenities };
    const strings = [row.title, row.address, row.neighborhood, row.description, row.kind];
    if (!Array.isArray(amenities) || !amenities.every((a) => typeof a === 'string') ||
        !strings.every((v) => typeof v === 'string') ||
        !Number.isFinite(meta.latitude) || !Number.isFinite(meta.longitude)) return null;
    return meta;
  } catch {
    return null;
  }
}

/** A failure that is the chain's, not the query's: the route answers 503 with its message. */
class Unavailable extends Error {}

/**
 * Creates and configures the Express API application.
 * Communicates with SQLite metadata database and local Ethereum node.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {string} [options.deploymentPath]
 * @param {string} [options.rpcUrl]
 */
export function createApp(options = {}) {
  const supplied = options.runtime;
  const runtime = supplied
    ? resolveRuntimeProfile({
        BIDPARK_PROFILE: supplied.profile?.id,
        BIDPARK_DATA_DIR: supplied.dataDir,
        ...(supplied.profile?.id === 'sepolia'
          ? { BIDPARK_SEPOLIA_RPC_URL: supplied.rpcUrl }
          : { RPC_URL: supplied.rpcUrl }),
      })
    : resolveRuntimeProfile({ RPC_URL: options.rpcUrl ?? process.env.RPC_URL });
  if (supplied && (
    supplied.profile !== getNetworkProfile(supplied.profile?.id) &&
    (supplied.profile?.chainId !== runtime.profile.chainId || supplied.profile?.id !== runtime.profile.id)
  )) throw new Error('Invalid runtime profile');
  if (supplied && (supplied.dbPath !== runtime.dbPath || supplied.deploymentPath !== runtime.deploymentPath)) {
    throw new Error('Invalid runtime paths');
  }
  if (runtime.profile.id === 'sepolia' && (options.dbPath || options.deploymentPath || options.rpcUrl)) {
    throw new Error('Sepolia runtime overrides are not allowed');
  }
  const deploymentPath = options.deploymentPath ?? runtime.deploymentPath;
  const rpcUrl = options.rpcUrl ?? runtime.rpcUrl;
  const profile = runtime.profile;
  if (supplied || !options.dbPath) assertProfileDirectory(runtime);
  const db = new EscrowDatabase(options.dbPath ?? runtime.dbPath, { chainId: profile.chainId });

  const settings = publicSettings(options);
  // Every RPC call is bounded, so a stalled node cannot hold requests open indefinitely.
  const rpcRequest = new ethers.FetchRequest(rpcUrl);
  rpcRequest.timeout = settings.rpcTimeoutMs;
  const provider = new ethers.JsonRpcProvider(rpcRequest, {
    chainId: profile.chainId,
    name: profile.id,
  }, { cacheTimeout: -1 });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  // Behind a TLS-terminating reverse proxy, this makes req.protocol/req.ip reflect the real client,
  // so the session cookie is marked Secure and write limits apply per client.
  if (settings.trustProxy) app.set('trust proxy', settings.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', req.path.startsWith('/api') ? API_CSP : WEB_CSP);
    if (req.originalUrl.length > MAX_URL_LENGTH) {
      res.status(414).json({ error: 'Request URL is too long' });
      return;
    }
    next();
  });

  // Hosted mode: browsers always send Origin on writes, so a write from another site is refused.
  const isWrite = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  app.use((req, res, next) => {
    if (settings.hosted && isWrite(req) && req.headers.origin && !settings.allowedOrigins.has(req.headers.origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });

  // ponytail: in-memory fixed-window write limit per client IP; use a shared store if the API is scaled out.
  const writeWindows = new Map();
  app.use((req, res, next) => {
    if (!settings.writesPerMinute || !isWrite(req)) return next();
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const window = writeWindows.get(key);
    if (!window || window.resetAt <= now) {
      if (writeWindows.size > 10_000) writeWindows.clear();
      writeWindows.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    if (++window.count > settings.writesPerMinute) {
      res.setHeader('Retry-After', String(Math.ceil((window.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Too many requests; try again shortly' });
      return;
    }
    next();
  });

  // JSON body parser with bounded payload size
  app.use(express.json({ limit: '100kb' }));

  // Exact-origin CORS headers (no wildcards)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && settings.allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Helper to load current deployment info
  function loadDeployment() {
    if (!fs.existsSync(deploymentPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(deploymentPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function getContract(deployment, abi = deployment?.abi) {
    if (!deployment || !deployment.contractAddress || !abi) return null;
    return new ethers.Contract(deployment.contractAddress, abi, provider);
  }

  // Verify the deployment against the same finalized block used for all contract reads.
  async function readFinalizedDeployment(deployment) {
    if (!deployment) throw new Error('Deployment unavailable');
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== profile.chainId) throw new Error('Wrong chain');
    const finalized = await provider.getBlock('finalized');
    if (!finalized?.hash) throw new Error('Finalized block unavailable');
    sepoliaArtifact ??= compileEscrowContract();
    await verifyPersistentDeployment(provider, deployment, sepoliaArtifact, finalized);
    return { finalized, iface: new ethers.Interface(sepoliaArtifact.abi) };
  }

  async function readFinalized(deployment, iface, finalized, method, args) {
    const result = await provider.send('eth_call', [
      { to: deployment.contractAddress, data: iface.encodeFunctionData(method, args) },
      { blockHash: finalized.hash, requireCanonical: true },
    ]);
    return iface.decodeFunctionResult(method, result);
  }

  async function readFinalizedAuction(deployment, iface, finalized, id) {
    return readFinalized(deployment, iface, finalized, 'auctions', [id]);
  }

  /** [spaceId, IANA time zone] of the space an auction belongs to. */
  async function readFinalizedSpace(deployment, iface, finalized, id) {
    const [spaceId] = await readFinalized(deployment, iface, finalized, 'auctionSpace', [id]);
    const [timeZone] = await readFinalized(deployment, iface, finalized, 'spaceTimeZone', [spaceId]);
    return [spaceId, timeZone];
  }

  async function readLocalSpace(contract, id, at = {}) {
    const spaceId = await contract.auctionSpace(id, at);
    return [spaceId, await contract.spaceTimeZone(spaceId, at)];
  }

  async function readFinalizedNextId(deployment, iface, finalized) {
    const result = await provider.send('eth_call', [
      { to: deployment.contractAddress, data: iface.encodeFunctionData('nextAuctionId', []) },
      { blockHash: finalized.hash, requireCanonical: true },
    ]);
    return iface.decodeFunctionResult('nextAuctionId', result)[0];
  }

  /**
   * Joins stored metadata with on-chain state. Every on-chain auction without matching stored
   * metadata is either recovered from metadata staged under its hash or reported as unindexed,
   * so an auction never silently disappears. RPC errors propagate to the caller.
   */
  async function buildListings(contractAddress, readAuction, readSpace, nextId) {
    const listings = [];
    const unindexed = [];
    const indexed = new Set();
    for (const row of db.getAllListings(contractAddress)) {
      const id = canonicalizeAuctionId(row.auction_id);
      if (!id) continue;
      const onchain = await readAuction(id);
      // A stored hash that no longer matches (e.g. after a chain rollback reused the id) is not shown.
      if (!onchain || onchain.owner === ethers.ZeroAddress ||
          row.metadata_hash.toLowerCase() !== onchain.metadataHash.toLowerCase()) continue;
      indexed.add(id);
      listings.push(listingFromRow(id, onchain, row, await readSpace(id)));
    }
    // ponytail: reads every auction id per request; the event indexer (#15) replaces this scan.
    for (let n = 1n; n < BigInt(nextId); n++) {
      const id = n.toString();
      if (indexed.has(id)) continue;
      const onchain = await readAuction(id);
      if (!onchain || onchain.owner === ethers.ZeroAddress) continue;
      const staged = db.getStagedMetadata(contractAddress, onchain.metadataHash);
      if (staged) {
        db.upsertListing({ ...staged, auctionId: id, contractAddress, metadataHash: onchain.metadataHash });
        listings.push(listingFromRow(id, onchain, { ...staged, amenities: JSON.stringify(staged.amenities) }, await readSpace(id)));
      } else {
        unindexed.push({
          id, owner: onchain.owner, metadataHash: onchain.metadataHash,
          highestBid: ethers.formatEther(onchain.highestBid), bidEnd: Number(onchain.bidEnd),
          settled: Boolean(onchain.settled), cancelled: Boolean(onchain.cancelled),
        });
      }
    }
    listings.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return { listings, unindexed };
  }

  /** The signed-in session, or null after answering 401: listing details are an off-chain write. */
  function requireSession(req, res) {
    const session = readSession(db, req);
    if (!session) res.status(401).json({ error: 'Sign in with your wallet to save listing details' });
    return session;
  }

  /** Only the auction's on-chain owner may register its details. */
  function ownsAuction(session, onchain, res) {
    if (onchain.owner.toLowerCase() === session.address.toLowerCase()) return true;
    res.status(403).json({ error: "Only the auction's owner can register its details" });
    return false;
  }

  /** True when a client-supplied deployment identity names the deployment this API serves. */
  function matchesDeployment(expected, deployment) {
    return Boolean(expected) && expected.chainId === profile.chainId &&
      expected.deploymentBlock === deployment.deploymentBlock &&
      typeof expected.contractAddress === 'string' &&
      expected.contractAddress.toLowerCase() === deployment.contractAddress.toLowerCase() &&
      typeof expected.deploymentBlockHash === 'string' &&
      expected.deploymentBlockHash.toLowerCase() === deployment.deploymentBlockHash.toLowerCase();
  }

  function isLocalDeployment(deployment) {
    return Number(deployment.chainId) === profile.chainId &&
      (!deployment.profile || deployment.profile === profile.id);
  }

  async function assertCanonicalFinalized(finalized) {
    const block = await provider.getBlock(finalized.number);
    if (!block?.hash || block.hash.toLowerCase() !== finalized.hash.toLowerCase()) {
      throw new Error('Finalized block changed');
    }
  }

  /**
   * Reads the deployment identity and chain clock the listing state is judged against.
   * Throws if the node is unreachable.
   */
  async function readChainSnapshot(deployment, finalized) {
    const latest = await provider.getBlock('latest');
    if (!latest) throw new Error('Latest block unavailable');
    const deploymentBlock = Number(deployment.deploymentBlock ?? 0);
    const deployBlock = await provider.getBlock(deploymentBlock);
    return {
      chainId: Number(deployment.chainId),
      contractAddress: deployment.contractAddress,
      deploymentBlock,
      deploymentBlockHash: deployBlock?.hash ?? '',
      blockNumber: finalized?.number ?? latest.number,
      blockTimestamp: finalized ? finalized.timestamp : latest.timestamp,
      // The next block is stamped no earlier than the latest block or the node's wall clock.
      chainTime: Math.max(latest.timestamp, Math.floor(Date.now() / 1000)),
    };
  }

  /**
   * GET /api/config
   * Returns runtime chain config, contract address, and ABI.
   */
  mountAuth(app, db, profile.chainId);

  app.get('/api/config', async (req, res) => {
    const deployment = loadDeployment();
    if (profile.id === 'sepolia') {
      try {
        const { finalized } = await readFinalizedDeployment(deployment);
        await assertCanonicalFinalized(finalized);
        db.recordDeployment({ ...deployment, profile: profile.id });
        res.json({
          profile: profile.id,
          confirmation: profile.confirmation,
          explorerUrl: profile.explorerUrl,
          chainId: profile.chainId,
          contractAddress: deployment.contractAddress,
          abi: sepoliaArtifact.abi,
          currency: profile.currency,
          networkName: profile.networkName,
          deploymentBlock: deployment.deploymentBlock,
          deploymentBlockHash: deployment.deploymentBlockHash,
        });
      } catch {
        res.status(503).json({ error: 'Blockchain service unavailable' });
      }
      return;
    }
    if (!deployment) {
      res.status(503).json({ error: 'Smart contract not yet deployed' });
      return;
    }
    if (!isLocalDeployment(deployment)) {
      res.status(503).json({ error: 'Blockchain service unavailable' });
      return;
    }

    // The hash of the deployment block distinguishes a reset chain that reuses the same address.
    let deploymentBlockHash;
    try {
      const block = await provider.getBlock(deployment.deploymentBlock ?? 0);
      deploymentBlockHash = block?.hash;
    } catch {
      deploymentBlockHash = null;
    }
    if (!deploymentBlockHash) {
      res.status(503).json({ error: 'Deployment block unavailable from the local chain' });
      return;
    }

    db.recordDeployment({ ...deployment, profile: profile.id });
    res.json({
      profile: profile.id,
      confirmation: profile.confirmation,
      explorerUrl: profile.explorerUrl,
      deploymentBlockHash,
      chainId: deployment.chainId,
      contractAddress: deployment.contractAddress,
      abi: deployment.abi,
      currency: deployment.currency || 'ETH',
      networkName: deployment.networkName || 'Hardhat Local',
      demoMnemonic: deployment.demoMnemonic,
      demoAccountIndex: deployment.demoAccountIndex ?? 1,
      deploymentBlock: deployment.deploymentBlock ?? 0,
      seedScenario: deployment.seedScenario ?? 'austin',
    });
  });

  /**
   * GET /api/listings
   * Returns all active parking listings merged with live onchain state.
   * Includes the deployment identity and chain clock (`chain`) the state was read at.
   * Compares stored metadata_hash with onchain.metadataHash and skips stale rows.
   * Fails with 503 if chain is unreachable.
   */
  app.get('/api/listings', async (req, res, next) => {
    try {
      const deployment = loadDeployment();
      if (profile.id === 'sepolia') {
        try {
          const { finalized, iface } = await readFinalizedDeployment(deployment);
          const { listings, unindexed } = await buildListings(
            deployment.contractAddress,
            (id) => readFinalizedAuction(deployment, iface, finalized, id),
            (id) => readFinalizedSpace(deployment, iface, finalized, id),
            await readFinalizedNextId(deployment, iface, finalized),
          );
          const chain = { ...(await readChainSnapshot(deployment, finalized)), blockHash: finalized.hash };
          await assertCanonicalFinalized(finalized);
          res.json({ listings, unindexed, chain });
        } catch {
          res.status(503).json({ error: 'Blockchain service unavailable' });
        }
        return;
      }
      if (!deployment) {
        res.json({ listings: [], chain: null });
        return;
      }
      if (!isLocalDeployment(deployment)) {
        res.status(503).json({ error: 'Blockchain service unavailable' });
        return;
      }

      const contract = getContract(deployment);
      if (!contract) {
        res.json({ listings: [], chain: null });
        return;
      }

      // Verify node connectivity upfront; fail whole request with 503 if node is down
      let pinned;
      try {
        pinned = await provider.getBlock('latest');
        if (!pinned) throw new Error('Latest block unavailable');
      } catch {
        res.status(503).json({ error: 'Local blockchain node is unavailable' });
        return;
      }

      // Do not suppress network RPC errors; a failed read is a 503, never an empty marketplace.
      // Every contract read uses the same block, which is returned as chain.blockNumber.
      const at = { blockTag: pinned.number };
      let built;
      let chain;
      try {
        built = await buildListings(
          deployment.contractAddress,
          (id) => contract.auctions(id, at),
          (id) => readLocalSpace(contract, id, at),
          await contract.nextAuctionId(at),
        );
        // Read the clock after the auction state so the clock is never older than the state it judges.
        chain = { ...(await readChainSnapshot(deployment, pinned)), blockHash: pinned.hash };
        await assertCanonicalFinalized(pinned);
      } catch (rpcErr) {
        res.status(503).json({ error: 'Failed to read listing state from blockchain node' });
        return;
      }

      res.json({ listings: built.listings, unindexed: built.unindexed, chain });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/listings/search
   * Bounded, validated discovery query (docs/listing-search.md). Every chain read of one response, and of
   * every later page of the same cursor, is pinned to one block whose number and hash are returned.
   * 400 malformed query, 409 the cursor's block is no longer canonical, 422 too many candidates, 503 outage.
   */
  app.get('/api/listings/search', async (req, res, next) => {
    let params;
    try {
      params = parseSearchQuery(req.query);
    } catch (err) {
      if (err instanceof QueryError) return res.status(400).json({ error: err.message });
      return next(err);
    }
    const deployment = loadDeployment();
    if (profile.id !== 'sepolia' && (!deployment || !deployment.abi)) {
      return res.json({ listings: [], total: 0, nextCursor: null, chain: null, skipped: 0, pricing: PRICE_NOTE });
    }
    if (profile.id !== 'sepolia' && !isLocalDeployment(deployment)) {
      return res.status(503).json({ error: 'Blockchain service unavailable' });
    }
    const deadline = Date.now() + settings.searchDeadlineMs;
    try {
      let iface;
      let head;
      if (profile.id === 'sepolia') {
        ({ finalized: head, iface } = await readFinalizedDeployment(deployment));
      } else {
        iface = new ethers.Interface(deployment.abi);
        head = await provider.getBlock('latest');
      }
      let pinned = head;
      if (params.cursor) {
        pinned = params.cursor.blockNumber > head?.number ? null : await provider.getBlock(params.cursor.blockNumber);
        if (pinned?.hash?.toLowerCase() !== params.cursor.blockHash.toLowerCase()) {
          return res.status(409).json({ error: 'Listings changed since this cursor was issued; start the search again' });
        }
      }
      if (!pinned?.hash) throw new Unavailable('Chain head unavailable');

      let skipped = 0;
      const candidates = [];
      for (const row of db.getAllListings(deployment.contractAddress)) {
        const id = canonicalizeAuctionId(row.auction_id);
        const meta = id && rowMetadata(row);
        if (!meta) { skipped++; continue; }
        if (matchesMetadata(meta, params)) candidates.push({ id, row, meta });
      }
      if (candidates.length > settings.searchScanLimit) {
        return res.status(422).json({ error: 'Too many listings match; narrow the area, time or filters' });
      }

      // ponytail: candidates are read from the chain per request; serve them from the event index once it
      // tracks auction state, not only events.
      const call = async (method, args) => iface.decodeFunctionResult(method, await provider.send('eth_call', [
        { to: deployment.contractAddress, data: iface.encodeFunctionData(method, args) },
        { blockHash: pinned.hash, requireCanonical: true },
      ]));
      const listings = [];
      for (let i = 0; i < candidates.length; i += 16) {
        if (Date.now() > deadline) throw new Unavailable('Listing search timed out');
        const read = await Promise.all(candidates.slice(i, i + 16).map(async ({ id, row, meta }) => {
          const onchain = await call('auctions', [id]);
          if (onchain.owner === ethers.ZeroAddress || row.metadata_hash.toLowerCase() !== onchain.metadataHash.toLowerCase()) return null;
          const [spaceId] = await call('auctionSpace', [id]);
          return listingFromRow(id, onchain, { ...meta, amenities: JSON.stringify(meta.amenities) }, spaceId);
        }));
        listings.push(...read.filter(Boolean));
      }

      const snapshot = await readChainSnapshot(deployment, pinned);
      const chain = { ...snapshot, blockHash: pinned.hash, chainTime: params.cursor?.chainTime ?? snapshot.chainTime };
      const matched = filterAndSort(listings, params, chain.chainTime);
      const offset = params.cursor?.offset ?? 0;
      const end = offset + params.limit;
      const block = await provider.getBlock(pinned.number);
      if (block?.hash !== pinned.hash) throw new Unavailable('Chain reorganized during the read; retry');
      res.json({
        listings: matched.slice(offset, end),
        total: matched.length,
        nextCursor: end < matched.length
          ? encodeCursor({ blockNumber: pinned.number, blockHash: pinned.hash, chainTime: chain.chainTime, offset: end, key: params.key })
          : null,
        chain,
        skipped,
        pricing: PRICE_NOTE,
      });
    } catch (err) {
      res.status(503).json({ error: err instanceof Unavailable ? err.message : 'Blockchain service unavailable' });
    }
  });

  /**
   * POST /api/listings/stage
   * Stores validated metadata under its canonical hash before the auction is created, so a
   * registration lost after the transaction can be recovered from the chain alone.
   */
  app.post('/api/listings/stage', async (req, res, next) => {
    try {
      if (!requireSession(req, res)) return;
      const validation = validateSpotMetadata(req.body?.metadata);
      if (!validation.valid || !validation.normalized) {
        res.status(400).json({ error: validation.error || 'Invalid listing metadata' });
        return;
      }
      const deployment = loadDeployment();
      if (!deployment || (profile.id === 'sepolia' ? !matchesDeployment(req.body?.deployment, deployment) : !isLocalDeployment(deployment))) {
        res.status(409).json({ error: 'Deployment identity does not match' });
        return;
      }
      const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(validation.normalized)));
      db.stageMetadata(deployment.contractAddress, metadataHash, validation.normalized);
      res.json({ metadataHash });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/listings
   * Registers metadata for a newly created onchain auction.
   * Canonicalizes auctionId, verifies metadata against onchain hash,
   * and safely reconciles stale registrations if chain rollback reused an auctionId.
   */
  app.post('/api/listings', async (req, res, next) => {
    try {
      const session = requireSession(req, res);
      if (!session) return;
      const { auctionId, metadata } = req.body || {};

      const canonicalId = canonicalizeAuctionId(auctionId);
      if (!canonicalId) {
        res.status(400).json({ error: 'Valid positive uint256 auctionId is required' });
        return;
      }

      const validation = validateSpotMetadata(metadata);
      if (!validation.valid || !validation.normalized) {
        res.status(400).json({ error: validation.error || 'Invalid listing metadata' });
        return;
      }

      const normalized = validation.normalized;
      const canonicalHash = ethers.keccak256(
        ethers.toUtf8Bytes(JSON.stringify(normalized))
      );

      const deployment = loadDeployment();
      if (profile.id === 'sepolia') {
        try {
          const { finalized, iface } = await readFinalizedDeployment(deployment);
          if (!matchesDeployment(req.body?.deployment, deployment)) {
            res.status(409).json({ error: 'Deployment identity does not match' });
            return;
          }
          const onchain = await readFinalizedAuction(deployment, iface, finalized, canonicalId);
          const space = await readFinalizedSpace(deployment, iface, finalized, canonicalId);
          await assertCanonicalFinalized(finalized);
          if (!onchain || onchain.owner === ethers.ZeroAddress) {
            res.status(404).json({ error: `Auction ID ${canonicalId} does not exist onchain` });
            return;
          }
          if (!ownsAuction(session, onchain, res)) return;
          if (onchain.metadataHash.toLowerCase() !== canonicalHash.toLowerCase()) {
            res.status(400).json({ error: 'Metadata canonical hash does not match onchain auction metadataHash' });
            return;
          }
          const existing = db.getListing(canonicalId, deployment.contractAddress);
          const isReconciliation = existing && existing.metadata_hash.toLowerCase() !== canonicalHash.toLowerCase();
          db.upsertListing({ auctionId: canonicalId, contractAddress: deployment.contractAddress,
            metadataHash: canonicalHash, ...normalized });
          res.status(existing && !isReconciliation ? 200 : 201).json({
            listing: listingFromRow(canonicalId, onchain, { ...normalized, amenities: JSON.stringify(normalized.amenities) }, space),
          });
        } catch {
          res.status(503).json({ error: 'Blockchain service unavailable' });
        }
        return;
      }
      if (!deployment) {
        res.status(503).json({ error: 'Smart contract not deployed' });
        return;
      }

      if (!isLocalDeployment(deployment)) {
        res.status(503).json({ error: 'Blockchain service unavailable' });
        return;
      }

      const contract = getContract(deployment);
      if (!contract) {
        res.status(503).json({ error: 'Blockchain service unavailable' });
        return;
      }

      // Verify node connectivity
      try {
        await provider.getBlockNumber();
      } catch {
        res.status(503).json({ error: 'Local blockchain node is unavailable' });
        return;
      }

      // Verify auction onchain using canonical ID
      let onchain, space;
      try {
        [onchain, space] = await Promise.all([contract.auctions(canonicalId), readLocalSpace(contract, canonicalId)]);
      } catch (err) {
        res.status(503).json({ error: 'Failed to query auction from smart contract' });
        return;
      }

      if (!onchain || onchain.owner === ethers.ZeroAddress) {
        res.status(404).json({ error: `Auction ID ${canonicalId} does not exist onchain` });
        return;
      }
      if (!ownsAuction(session, onchain, res)) return;

      if (onchain.metadataHash.toLowerCase() !== canonicalHash.toLowerCase()) {
        res.status(400).json({
          error: 'Metadata canonical hash does not match onchain auction metadataHash',
        });
        return;
      }

      // Upsert record: if row already existed for canonicalId with differing hash (e.g. from rollback),
      // reconcile safely because the current onchain auction matches canonicalHash
      const existing = db.getListing(canonicalId, deployment.contractAddress);
      const isReconciliation = existing && existing.metadata_hash.toLowerCase() !== canonicalHash.toLowerCase();

      db.upsertListing({
        auctionId: canonicalId,
        contractAddress: deployment.contractAddress,
        metadataHash: canonicalHash,
        title: normalized.title,
        address: normalized.address,
        neighborhood: normalized.neighborhood,
        latitude: normalized.latitude,
        longitude: normalized.longitude,
        description: normalized.description,
        image: normalized.image,
        kind: normalized.kind,
        amenities: normalized.amenities,
      });

      const listing = listingFromRow(canonicalId, onchain, {
        ...normalized, amenities: JSON.stringify(normalized.amenities),
      }, space);

      res.status(existing && !isReconciliation ? 200 : 201).json({ listing });
    } catch (err) {
      next(err);
    }
  });

  /**
   * One indexer pass for the deployment this API serves. Concurrent callers share the pass in flight,
   * so the background job and a manual refresh never index the same range twice at once.
   */
  let indexing = null;
  let lastSync = null;
  function syncIndexOnce() {
    indexing ??= (async () => {
      const deployment = loadDeployment();
      if (!deployment?.contractAddress) return null;
      const abi = deployment.abi ?? (sepoliaArtifact ??= compileEscrowContract()).abi;
      lastSync = { ...await syncIndex({
        db, provider, address: deployment.contractAddress, abi,
        fromBlock: Number(deployment.deploymentBlock ?? 0), confirmation: profile.confirmation,
      }), at: Date.now(), error: null };
      return lastSync;
    })().catch((error) => {
      lastSync = { ...lastSync, at: Date.now(), error: 'Index sync failed' };
      console.warn('[BidPark Index] Sync failed:', error?.message ?? error);
      return lastSync;
    }).finally(() => { indexing = null; });
    return indexing;
  }

  /** GET /api/index: how current the event index is. Never reports a failed sync as fresh. */
  app.get('/api/index', (req, res) => {
    const deployment = loadDeployment();
    const checkpoint = deployment?.contractAddress ? db.getCheckpoint(deployment.contractAddress) : null;
    res.json({
      confirmation: profile.confirmation,
      indexedBlock: checkpoint?.block_number ?? null,
      indexedAt: checkpoint?.updated_at ?? null,
      headBlock: lastSync?.headBlock ?? null,
      lagBlocks: lastSync?.lagBlocks ?? null,
      lastSyncAt: lastSync?.at ?? null,
      lastSyncError: lastSync?.error ?? null,
    });
  });

  /**
   * GET /api/auctions/:id/events: canonical public event history for one auction, with the index
   * checkpoint and last sync error so a client can tell "no events" from "not indexed yet" or stale.
   */
  app.get('/api/auctions/:id/events', (req, res) => {
    const id = canonicalizeAuctionId(req.params.id);
    const deployment = loadDeployment();
    if (!id || !deployment?.contractAddress) {
      res.status(id ? 503 : 400).json({ error: id ? 'Smart contract not deployed' : 'Valid auction id is required' });
      return;
    }
    res.json({
      indexedBlock: db.getCheckpoint(deployment.contractAddress)?.block_number ?? null,
      syncError: lastSync?.error ?? null,
      events: db.getAuctionEvents(deployment.contractAddress, id).map((e) => ({
        event: e.event, account: e.account, amount: e.amount === null ? null : ethers.formatEther(e.amount),
        blockNumber: e.block_number, blockHash: e.block_hash, txHash: e.tx_hash, logIndex: e.log_index,
      })),
    });
  });

  /**
   * The signed-in wallet's inbox on the deployment this API serves, built from canonical indexed events
   * only, with its read state and the index freshness so the client can say when it may be behind.
   */
  function inboxFor(session, contractAddress) {
    const read = db.getInboxReads(contractAddress, session.address);
    const items = deriveInbox(db.getInboxEvents(contractAddress, session.address), session.address).map((item) => ({
      ...item,
      amount: item.amount === null ? null : ethers.formatEther(item.amount),
      title: item.auctionId ? db.getListing(item.auctionId, contractAddress)?.title ?? null : null,
      read: read.has(item.id),
    }));
    const checkpoint = db.getCheckpoint(contractAddress);
    return {
      items,
      unread: items.filter((item) => !item.read).length,
      index: {
        indexedBlock: checkpoint?.block_number ?? null,
        headBlock: lastSync?.headBlock ?? null,
        lagBlocks: lastSync?.lagBlocks ?? null,
        lastSyncAt: lastSync?.at ?? null,
        lastSyncError: lastSync?.error ?? null,
      },
    };
  }

  function inboxDeployment(req, res) {
    const session = readSession(db, req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your wallet to see your inbox' });
      return null;
    }
    const deployment = loadDeployment();
    if (!deployment?.contractAddress) {
      res.status(503).json({ error: 'Smart contract not deployed' });
      return null;
    }
    return { session, contractAddress: deployment.contractAddress };
  }

  /** GET /api/inbox: outbid, win, refund and payout entries for the signed-in wallet. */
  app.get('/api/inbox', (req, res) => {
    const scope = inboxDeployment(req, res);
    if (scope) res.json(inboxFor(scope.session, scope.contractAddress));
  });

  /** POST /api/inbox/read { ids }: marks the signed-in wallet's entries read and returns the inbox. */
  app.post('/api/inbox/read', (req, res) => {
    const scope = inboxDeployment(req, res);
    if (!scope) return;
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === 'string' && /^0x[0-9a-f]{64}:\d{1,6}$/.test(id))) {
      res.status(400).json({ error: 'ids must be a list of at most 500 inbox entry ids' });
      return;
    }
    db.markInboxRead(scope.contractAddress, scope.session.address, ids);
    res.json(inboxFor(scope.session, scope.contractAddress));
  });

  /** GET /api/health/live: the process is up and answering. Checks no dependencies. */
  app.get('/api/health/live', (req, res) => res.json({ live: true }));

  /**
   * GET /api/health/ready: the dependencies a request needs are usable. Each check is 'ok' or a fixed,
   * redacted reason (never an upstream error, which could contain an RPC URL or token). 503 until all
   * pass. Index freshness is only checked when a maximum lag is configured.
   */
  const maxIndexLag = options.maxIndexLag ?? (process.env.BIDPARK_MAX_INDEX_LAG === undefined
    ? undefined : Number(process.env.BIDPARK_MAX_INDEX_LAG));
  app.get('/api/health/ready', async (req, res) => {
    const checks = {};
    const unready = (reason) => Object.assign(new Error(reason), { reason });
    const check = async (name, probe) => {
      let timer;
      try {
        await Promise.race([probe(), new Promise((_, reject) => { timer = setTimeout(() => reject(unready('timed out')), 5000); })]);
        checks[name] = 'ok';
      } catch (error) {
        checks[name] = error?.reason ?? 'failed';
      } finally {
        clearTimeout(timer);
      }
    };
    const deployment = loadDeployment();
    await check('database', async () => db.db.prepare('SELECT 1').get());
    await check('chain', async () => {
      if (Number(await provider.send('eth_chainId', [])) !== profile.chainId) throw unready('unexpected chain');
    });
    await check('contract', async () => {
      if (!deployment?.contractAddress) throw unready('no deployment configured');
      if ((await provider.getCode(deployment.contractAddress)) === '0x') throw unready('no contract code at the deployment address');
    });
    if (maxIndexLag !== undefined) {
      await check('index', async () => {
        if (!lastSync || lastSync.lagBlocks === null || lastSync.lagBlocks === undefined) throw unready('not indexed yet');
        if (lastSync.error) throw unready('last index sync failed');
        if (lastSync.lagBlocks > maxIndexLag) throw unready(`index is ${lastSync.lagBlocks} blocks behind`);
      });
    }
    const ready = Object.values(checks).every((value) => value === 'ok');
    res.status(ready ? 200 : 503).json({
      ready, profile: profile.id, chainId: profile.chainId, contractAddress: deployment?.contractAddress ?? null, checks,
    });
  });

  // Catch-all 404 for unknown API routes
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route ${req.method} ${req.path} not found` });
  });

  // Centralized JSON error handler - no internal stack leak
  app.use((err, req, res, next) => {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    const message = status === 500 ? 'Internal server error' : err.message || 'Request failed';
    res.status(status).json({ error: message });
  });

  return { app, db, provider, syncIndexOnce, indexingDone: () => indexing ?? Promise.resolve() };
}
