import { ethers } from 'ethers';
import { HARDHAT_MNEMONIC } from '../scripts/helpers/chain.mjs';

const DEFAULT_MNEMONIC = 'test test test test test test test test test test test junk';
const ON = new Set(['1', 'true', 'on']);

/** Addresses of the public demo accounts (first 20 of each demo mnemonic), which must never sign on Sepolia. */
function demoAddresses() {
  const addresses = new Set();
  for (const phrase of new Set([DEFAULT_MNEMONIC, HARDHAT_MNEMONIC])) {
    for (let i = 0; i < 20; i++) addresses.add(ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`).address);
  }
  return addresses;
}

/**
 * Settlement keeper settings. Off unless BIDPARK_SETTLEMENT is on. Sepolia needs a dedicated
 * BIDPARK_KEEPER_KEY that is neither a demo account nor the deployer key; the local profile falls
 * back to the demo deployer (account 0). Returns null when off. Never echoes the key.
 */
export function settlementSettings(options = {}, env = process.env, profile) {
  if (!(options.enabled ?? ON.has(String(env.BIDPARK_SETTLEMENT ?? '').toLowerCase()))) return null;
  const key = options.keeperKey ?? env.BIDPARK_KEEPER_KEY;
  let wallet;
  if (key) {
    try { wallet = new ethers.Wallet(key); } catch { throw new Error('Invalid BIDPARK_KEEPER_KEY'); }
  } else if (profile.id === 'local') {
    wallet = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
  } else {
    throw new Error('BIDPARK_KEEPER_KEY is required for automatic settlement on this profile');
  }
  if (profile.id !== 'local') {
    let deployer = null;
    try { deployer = env.BIDPARK_SEPOLIA_DEPLOYER_KEY ? new ethers.Wallet(env.BIDPARK_SEPOLIA_DEPLOYER_KEY).address : null; } catch { /* not ours to validate */ }
    if (demoAddresses().has(wallet.address) || wallet.address === deployer) {
      throw new Error('BIDPARK_KEEPER_KEY must be a dedicated keeper key, not a demo or deployer key');
    }
  }
  const intervalMs = options.intervalMs ?? Number(env.BIDPARK_SETTLEMENT_INTERVAL_MS ?? 30_000);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('BIDPARK_SETTLEMENT_INTERVAL_MS must be at least 1000');
  return { wallet, intervalMs, retryBaseMs: options.retryBaseMs ?? 30_000, retryMaxMs: options.retryMaxMs ?? 15 * 60_000,
    dropAfterMs: options.dropAfterMs ?? 5 * 60_000, now: options.now ?? Date.now };
}

/** A fixed, secret-free reason: the contract error name, or the ethers error code. Never a message. */
function reasonOf(contract, error) {
  if (error?.revert?.name) return error.revert.name;
  try {
    const parsed = error?.data && contract.interface.parseError(error.data);
    if (parsed) return parsed.name;
  } catch { /* not a contract error */ }
  // Some nodes (Hardhat) report an unfunded sender only in the message; match it, never echo it.
  if (/insufficient funds|enough funds/i.test(`${error?.error?.message ?? ''} ${error?.message ?? ''}`)) return 'INSUFFICIENT_FUNDS';
  return /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'UNKNOWN_ERROR';
}

const log = (fields) => console.log(JSON.stringify({ component: 'settlement', ...fields }));

/**
 * Settles due auctions with the keeper wallet. One pass at a time (concurrent callers share it), one
 * auction at a time. Per auction it reads the live state, so a manual settlement, a cancellation or a
 * reorg is always seen before anything is sent, and it sends only when no earlier transaction for that
 * auction may still land. A failed attempt backs off exponentially (retryBaseMs doubling, capped at
 * retryMaxMs). A job is confirmed once the auction is settled at the profile's confirmation depth.
 */
export function createSettlementJob({ db, provider, profile, loadDeployment, abiFor, settings }) {
  const { wallet, retryBaseMs, retryMaxMs, dropAfterMs, now } = settings;
  const signer = wallet.connect(provider);
  let running = null;
  let lastRun = null;

  async function step(contract, address, id, head, confirmedTag) {
    const job = db.getSettlementJob(address, id);
    const save = (fields) => db.saveSettlementJob(address, id, {
      status: job?.status, txHash: job?.tx_hash, attempts: job?.attempts ?? 0, updatedAt: now(), ...fields,
    });
    const auction = await contract.auctions(id);
    if (auction.cancelled) {
      if (job) save({ status: 'cancelled', error: null, nextAttemptAt: null });
      return false;
    }
    if (auction.settled) {
      const confirmed = confirmedTag === 'latest' || (await contract.auctions(id, { blockTag: confirmedTag })).settled;
      if (confirmed && job && job.status !== 'confirmed') {
        save({ status: 'confirmed', error: null, nextAttemptAt: null });
        log({ event: 'confirmed', auctionId: id, txHash: job.tx_hash });
      }
      return !confirmed;
    }
    // Not due, or nothing to settle (no bids: the host may still cancel).
    if (Number(auction.bidEnd) > head.timestamp || auction.highestBidder === ethers.ZeroAddress) return false;

    let attempts = job?.attempts ?? 0;
    if (job?.status === 'sent' && job.tx_hash) {
      const receipt = await provider.getTransactionReceipt(job.tx_hash);
      // Still pending, or too recent to call dropped: never send a second transaction.
      if (!receipt && (await provider.getTransaction(job.tx_hash) || now() - job.updated_at < dropAfterMs)) return true;
      const error = !receipt ? 'DROPPED' : receipt.status === 0 ? 'REVERTED' : 'REORGED';
      save({ status: 'failed', error, nextAttemptAt: now() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs) });
      log({ event: 'failed', auctionId: id, attempts, reason: error, txHash: job.tx_hash });
      return true;
    }
    if (job?.status === 'failed' && job.next_attempt_at > now()) return true;

    try {
      const tx = await contract.settle(id);
      save({ status: 'sent', txHash: tx.hash, attempts: attempts + 1, error: null, nextAttemptAt: null });
      log({ event: 'sent', auctionId: id, attempts: attempts + 1, txHash: tx.hash });
    } catch (error) {
      const reason = reasonOf(contract, error);
      // Someone settled it first (or our clock is ahead of the chain's): not a failure.
      if (reason === 'AlreadySettled' || reason === 'AuctionNotEnded') return reason === 'AlreadySettled';
      attempts += 1;
      save({ status: 'failed', attempts, error: reason, nextAttemptAt: now() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs) });
      log({ event: 'failed', auctionId: id, attempts, reason });
    }
    return true;
  }

  function runOnce() {
    running ??= (async () => {
      const deployment = loadDeployment();
      if (!deployment?.contractAddress) {
        lastRun = { at: now(), error: null, pending: 0 };
        return lastRun;
      }
      const address = deployment.contractAddress;
      const contract = new ethers.Contract(address, abiFor(deployment), signer);
      const head = await provider.getBlock('latest');
      if (!head) throw new Error('Chain head unavailable');
      const confirmedTag = profile.confirmation === 'finalized' ? 'finalized' : 'latest';
      let pending = 0;
      // ponytail: one live read per open auction with bids per pass; batch with multicall if that grows large.
      for (const id of db.getSettlementCandidates(address)) {
        if (await step(contract, address, id, head, confirmedTag)) pending += 1;
      }
      lastRun = { at: now(), error: null, pending };
      return lastRun;
    })().catch((error) => {
      lastRun = { at: now(), error: reasonOf(null, error), pending: lastRun?.pending ?? null };
      log({ event: 'run_failed', reason: lastRun.error });
      return lastRun;
    }).finally(() => { running = null; });
    return running;
  }

  function status() {
    const deployment = loadDeployment();
    const summary = deployment?.contractAddress ? db.getSettlementSummary(deployment.contractAddress) : { counts: {}, recentFailures: [] };
    return {
      enabled: true,
      keeper: wallet.address,
      intervalMs: settings.intervalMs,
      confirmation: profile.confirmation,
      lastRunAt: lastRun?.at ?? null,
      lastRunError: lastRun?.error ?? null,
      pending: lastRun?.pending ?? null,
      jobs: { sent: 0, confirmed: 0, failed: 0, cancelled: 0, ...summary.counts },
      recentFailures: summary.recentFailures.map((job) => ({
        auctionId: job.auction_id, attempts: job.attempts, error: job.last_error,
        nextAttemptAt: job.next_attempt_at, updatedAt: job.updated_at,
      })),
    };
  }

  return { runOnce, done: () => running ?? Promise.resolve(), status, lastRun: () => lastRun };
}
