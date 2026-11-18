import fs from 'node:fs';
import express from 'express';
import { ethers } from 'ethers';
import { EscrowDatabase } from './db.mjs';
import { validateSpotMetadata } from '../shared/validation.js';
import { assertProfileDirectory, resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';
import { verifyPersistentDeployment } from '../scripts/helpers/persistent-deployment.mjs';
import { compileEscrowContract } from '../scripts/helpers/compiler.mjs';
import { getNetworkProfile } from '../shared/network-profiles.mjs';

let sepoliaArtifact;

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

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

function listingFromRow(id, onchain, row) {
  return {
    id, owner: onchain.owner,
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
  const db = new EscrowDatabase(options.dbPath ?? runtime.dbPath);

  const provider = new ethers.JsonRpcProvider(rpcUrl, {
    chainId: profile.chainId,
    name: profile.id,
  }, { cacheTimeout: -1 });

  const app = express();

  // Local JSON body parser with bounded payload size
  app.use(express.json({ limit: '100kb' }));

  // Strict loopback CORS headers (no wildcards)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
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

  async function readFinalizedAuction(deployment, iface, finalized, id) {
    const data = iface.encodeFunctionData('auctions', [id]);
    const result = await provider.send('eth_call', [
      { to: deployment.contractAddress, data },
      { blockHash: finalized.hash, requireCanonical: true },
    ]);
    return iface.decodeFunctionResult('auctions', result);
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
  app.get('/api/config', async (req, res) => {
    const deployment = loadDeployment();
    if (profile.id === 'sepolia') {
      try {
        const { finalized } = await readFinalizedDeployment(deployment);
        await assertCanonicalFinalized(finalized);
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
          const rows = db.getAllListings(deployment.contractAddress);
          const listings = [];
          for (const row of rows) {
            const id = canonicalizeAuctionId(row.auction_id);
            if (!id) continue;
            const onchain = await readFinalizedAuction(deployment, iface, finalized, id);
            if (!onchain || onchain.owner === ethers.ZeroAddress ||
                row.metadata_hash.toLowerCase() !== onchain.metadataHash.toLowerCase()) continue;
            listings.push(listingFromRow(id, onchain, row));
          }
          const chain = await readChainSnapshot(deployment, finalized);
          await assertCanonicalFinalized(finalized);
          res.json({ listings, chain });
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
      try {
        await provider.getBlockNumber();
      } catch {
        res.status(503).json({ error: 'Local blockchain node is unavailable' });
        return;
      }

      const metadataRows = db.getAllListings(deployment.contractAddress);
      const listings = [];

      // Query onchain state for each stored listing.
      // Do not suppress network RPC errors; allow them to throw 503.
      let chain;
      try {
        for (const row of metadataRows) {
          const canonicalId = canonicalizeAuctionId(row.auction_id);
          if (!canonicalId) {
            continue;
          }

          const onchain = await contract.auctions(canonicalId);
          // If auction does not exist onchain, skip row
          if (!onchain || onchain.owner === ethers.ZeroAddress) {
            continue;
          }

          // Strict verification: stored metadata hash MUST match current onchain hash
          // Prevents associating stale metadata if chain rollback reused an auction ID
          if (row.metadata_hash.toLowerCase() !== onchain.metadataHash.toLowerCase()) {
            continue;
          }

          listings.push(listingFromRow(canonicalId, onchain, row));
        }
        // Read the clock after the auction state so the clock is never older than the state it judges.
        chain = await readChainSnapshot(deployment);
      } catch (rpcErr) {
        res.status(503).json({ error: 'Failed to read listing state from blockchain node' });
        return;
      }

      res.json({ listings, chain });
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
          const expected = req.body?.deployment;
          if (!expected || expected.chainId !== profile.chainId ||
              expected.deploymentBlock !== deployment.deploymentBlock ||
              typeof expected.contractAddress !== 'string' ||
              expected.contractAddress.toLowerCase() !== deployment.contractAddress.toLowerCase() ||
              typeof expected.deploymentBlockHash !== 'string' ||
              expected.deploymentBlockHash.toLowerCase() !== deployment.deploymentBlockHash.toLowerCase()) {
            res.status(409).json({ error: 'Deployment identity does not match' });
            return;
          }
          const onchain = await readFinalizedAuction(deployment, iface, finalized, canonicalId);
          await assertCanonicalFinalized(finalized);
          if (!onchain || onchain.owner === ethers.ZeroAddress) {
            res.status(404).json({ error: `Auction ID ${canonicalId} does not exist onchain` });
            return;
          }
          if (onchain.metadataHash.toLowerCase() !== canonicalHash.toLowerCase()) {
            res.status(400).json({ error: 'Metadata canonical hash does not match onchain auction metadataHash' });
            return;
          }
          const existing = db.getListing(canonicalId, deployment.contractAddress);
          const isReconciliation = existing && existing.metadata_hash.toLowerCase() !== canonicalHash.toLowerCase();
          db.upsertListing({ auctionId: canonicalId, contractAddress: deployment.contractAddress,
            metadataHash: canonicalHash, ...normalized });
          res.status(existing && !isReconciliation ? 200 : 201).json({
            listing: listingFromRow(canonicalId, onchain, { ...normalized, amenities: JSON.stringify(normalized.amenities) }),
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
      let onchain;
      try {
        onchain = await contract.auctions(canonicalId);
      } catch (err) {
        res.status(503).json({ error: 'Failed to query auction from smart contract' });
        return;
      }

      if (!onchain || onchain.owner === ethers.ZeroAddress) {
        res.status(404).json({ error: `Auction ID ${canonicalId} does not exist onchain` });
        return;
      }

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
      });

      res.status(existing && !isReconciliation ? 200 : 201).json({ listing });
    } catch (err) {
      next(err);
    }
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

  return { app, db, provider };
}
