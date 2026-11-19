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
    dropAfterMs: options.dropAfterMs ?? 5 * 60_000, now: options.now ?? Date.now,
    // Stuck-transaction replacement: after replaceAfterMs pending, resend the same nonce with fees raised by
    // bumpPercent (nodes demand at least 10%), never above maxFeePerGasWei, for at most maxAttempts sends.
    replaceAfterMs: options.replaceAfterMs ?? 2 * 60_000, bumpPercent: options.bumpPercent ?? 20,
    maxFeePerGasWei: options.maxFeePerGasWei ?? BigInt(Math.round(Number(env.BIDPARK_KEEPER_MAX_FEE_GWEI ?? 100) * 1e9)),
    maxAttempts: options.maxAttempts ?? 5 };
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
  const { wallet, retryBaseMs, retryMaxMs, dropAfterMs, now, replaceAfterMs = 2 * 60_000, bumpPercent = 20, maxFeePerGasWei = 100n * 10n ** 9n, maxAttempts = 5 } = settings;
  const signer = wallet.connect(provider);
  let running = null;
  let lastRun = null;
  const totals = { sent: 0, replaced: 0, failed: 0, runFailures: 0 };

  // Contract outcome (enum index) that completes each protected action.
  const DONE_OUTCOME = { expire: 3, expireDispute: 5 };

  async function step(contract, address, id, head, confirmedTag, resolutionWindow) {
    const prior = db.getSettlementJob(address, id);
    const auction = await contract.auctions(id);
    const booking = resolutionWindow === null ? null : await contract.bookings(id);
    const isProtected = Boolean(booking?.isProtected);
    // What the contract allows next. Protected bookings: settle before parkingStart, expire() once it
    // has passed unsettled, expireDispute() once a report outlives the resolution window. Otherwise
    // the dispute hold (open report, window still running) and resolvers' decisions are not ours.
    let action = 'settle';
    if (isProtected && !auction.cancelled && head.timestamp >= Number(auction.parkingStart) && !auction.settled &&
        auction.highestBidder !== ethers.ZeroAddress) action = 'expire';
    if (isProtected && !auction.cancelled && auction.settled && booking.disputeReporter !== ethers.ZeroAddress &&
        head.timestamp >= Number(auction.parkingEnd) + resolutionWindow) action = 'expireDispute';
    const job = prior && (prior.action ?? 'settle') === action ? prior : null;
    const save = (fields) => db.saveSettlementJob(address, id, {
      status: job?.status, txHash: job?.tx_hash, attempts: job?.attempts ?? 0, updatedAt: now(), action, ...fields,
    });
    if (auction.cancelled) {
      // A refund (expiry, host cancellation, upheld report) also marks the auction cancelled; ours is
      // confirmed once its own outcome stands at the confirmation depth.
      const own = prior && prior.action !== 'settle' ? DONE_OUTCOME[prior.action] : undefined;
      if (prior && own !== undefined && Number(booking?.outcome) === own) {
        const confirmed = confirmedTag === 'latest' || Number((await contract.bookings(id, { blockTag: confirmedTag })).outcome) === own;
        if (confirmed && prior.status !== 'confirmed') {
          db.saveSettlementJob(address, id, { status: 'confirmed', txHash: prior.tx_hash, attempts: prior.attempts, updatedAt: now(), action: prior.action });
          log({ event: 'confirmed', auctionId: id, action: prior.action, txHash: prior.tx_hash });
        }
        return !confirmed;
      }
      if (prior && prior.status !== 'cancelled') db.saveSettlementJob(address, id, { status: 'cancelled', txHash: prior.tx_hash, attempts: prior.attempts, updatedAt: now(), action: prior.action ?? 'settle' });
      return false;
    }
    if (auction.settled && action === 'settle') {
      const confirmed = confirmedTag === 'latest' || (await contract.auctions(id, { blockTag: confirmedTag })).settled;
      if (confirmed && job && job.status !== 'confirmed') {
        save({ status: 'confirmed', error: null, nextAttemptAt: null });
        log({ event: 'confirmed', auctionId: id, txHash: job.tx_hash });
      }
      return !confirmed;
    }
    if (action === 'settle') {
      // Not due, or nothing to settle (no bids: the host may still cancel).
      if (Number(auction.bidEnd) > head.timestamp || auction.highestBidder === ethers.ZeroAddress) return false;
      // A protected booking never reaches here once parking starts (action is expire then).
    }

    let attempts = job?.attempts ?? 0;
    if (job?.status === 'sent' && job.tx_hash) {
      const receipt = await provider.getTransactionReceipt(job.tx_hash);
      // Still pending, or too recent to call dropped: never send a second transaction.
      const pendingTx = receipt ? null : await provider.getTransaction(job.tx_hash);
      if (pendingTx && now() - job.updated_at >= replaceAfterMs && attempts < maxAttempts) await replace(contract, id, action, job, pendingTx, save);
      if (!receipt && (pendingTx || now() - job.updated_at < dropAfterMs)) return true;
      const error = !receipt ? 'DROPPED' : receipt.status === 0 ? 'REVERTED' : 'REORGED';
      save({ status: 'failed', error, nextAttemptAt: now() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs) });
      totals.failed += 1;
      log({ event: 'failed', auctionId: id, attempts, reason: error, txHash: job.tx_hash });
      return true;
    }
    if (job?.status === 'failed' && job.next_attempt_at > now()) return true;

    let txHash = null;
    try {
      // Sign first and record the hash before broadcasting, so a crash or a lost RPC response after
      // the node accepted it still leaves a transaction to check rather than a reason to send again.
      const signed = await signer.signTransaction(await signer.populateTransaction(await contract[action].populateTransaction(id)));
      txHash = ethers.Transaction.from(signed).hash;
      save({ status: 'sent', txHash, attempts: attempts + 1, error: null, nextAttemptAt: null });
      await provider.broadcastTransaction(signed);
      totals.sent += 1;
      log({ event: 'sent', auctionId: id, attempts: attempts + 1, txHash });
    } catch (error) {
      const reason = reasonOf(contract, error);
      // Someone settled it first (or our clock is ahead of the chain's): not a failure.
      if (['AlreadySettled', 'BookingFinalized', 'NoOpenDispute', 'NONCE_EXPIRED'].includes(reason)) return true;
      if (['AuctionNotEnded', 'TooEarly', 'TooLate'].includes(reason)) return false;
      // The node may have accepted it before the connection failed: keep it as sent and check it next pass.
      if (txHash && ['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(reason)) {
        log({ event: 'send_unconfirmed', auctionId: id, reason, txHash });
        return true;
      }
      attempts += 1;
      save({ status: 'failed', attempts, error: reason, nextAttemptAt: now() + Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs) });
      totals.failed += 1;
      log({ event: 'failed', auctionId: id, attempts, reason });
    }
    return true;
  }

  /**
   * Replaces a transaction stuck in the mempool: same nonce and gas limit, both fees raised by
   * bumpPercent and clamped to maxFeePerGasWei. The new hash is stored before broadcasting, like a
   * first send. If the cap leaves no room for a valid bump (nodes reject under 10%), it logs and waits.
   */
  async function replace(contract, id, action, job, stuck, save) {
    const bump = (fee) => (fee * BigInt(100 + bumpPercent) + 99n) / 100n;
    const oldMax = stuck.maxFeePerGas ?? stuck.gasPrice;
    const maxFee = bump(oldMax) > maxFeePerGasWei ? maxFeePerGasWei : bump(oldMax);
    if (maxFee * 100n < oldMax * 110n) {
      log({ event: 'replace_capped', auctionId: id, attempts: job.attempts, txHash: job.tx_hash });
      return;
    }
    const tip = stuck.maxPriorityFeePerGas == null ? maxFee : bump(stuck.maxPriorityFeePerGas);
    let txHash = null;
    try {
      const request = await contract[action].populateTransaction(id);
      const signed = await signer.signTransaction({
        to: request.to, data: request.data, type: 2, chainId: stuck.chainId, nonce: stuck.nonce, gasLimit: stuck.gasLimit,
        maxFeePerGas: maxFee, maxPriorityFeePerGas: tip > maxFee ? maxFee : tip,
      });
      txHash = ethers.Transaction.from(signed).hash;
      save({ status: 'sent', txHash, attempts: job.attempts + 1, error: null, nextAttemptAt: null });
      job.attempts += 1;
      job.tx_hash = txHash;
      job.updated_at = now();
      await provider.broadcastTransaction(signed);
      totals.replaced += 1;
      log({ event: 'replaced', auctionId: id, attempts: job.attempts, txHash, replaced: stuck.hash, maxFeePerGas: maxFee.toString() });
    } catch (error) {
      // Typically the original mined first (nonce too low) or the node refused the bump: the next pass sees which.
      log({ event: 'replace_failed', auctionId: id, attempts: job.attempts, reason: reasonOf(contract, error), txHash });
    }
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
      const resolutionWindow = contract.interface.getFunction('bookings') ? Number(await contract.RESOLUTION_WINDOW()) : null;
      let pending = 0;
      // ponytail: one live read per open auction with bids per pass; batch with multicall if that grows large.
      for (const id of db.getSettlementCandidates(address)) {
        if (await step(contract, address, id, head, confirmedTag, resolutionWindow)) pending += 1;
      }
      lastRun = { at: now(), error: null, pending };
      return lastRun;
    })().catch((error) => {
      totals.runFailures += 1;
      lastRun = { at: now(), error: reasonOf(null, error), pending: lastRun?.pending ?? null };
      log({ event: 'run_failed', reason: lastRun.error });
      return lastRun;
    }).finally(() => { running = null; });
    return running;
  }

  /** Prometheus text exposition of backlog, attempts, failures and lag. Counters restart with the process. */
  function metrics() {
    const deployment = loadDeployment();
    const m = deployment?.contractAddress ? db.getSettlementMetrics(deployment.contractAddress) : { counts: {}, attempts: 0, oldestUnconfirmedAt: null };
    const out = [];
    const add = (name, type, help, samples) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
    };
    add('bidpark_settlement_jobs', 'gauge', 'Settlement jobs by state.',
      ['sent', 'confirmed', 'failed', 'cancelled'].map((s) => [`{state="${s}"}`, m.counts[s] ?? 0]));
    add('bidpark_settlement_job_attempts', 'gauge', 'Transactions sent across all jobs, replacements included.', [['', m.attempts]]);
    add('bidpark_settlement_pending', 'gauge', 'Auctions the last pass left unfinished.', [['', lastRun?.pending ?? 0]]);
    add('bidpark_settlement_sent_total', 'counter', 'Settlement transactions sent by this process.', [['', totals.sent]]);
    add('bidpark_settlement_replaced_total', 'counter', 'Stuck transactions replaced with higher fees by this process.', [['', totals.replaced]]);
    add('bidpark_settlement_failures_total', 'counter', 'Failed settlement attempts recorded by this process.', [['', totals.failed]]);
    add('bidpark_settlement_run_failures_total', 'counter', 'Passes that failed outright, such as an RPC outage.', [['', totals.runFailures]]);
    add('bidpark_settlement_last_run_timestamp_seconds', 'gauge', 'Unix time of the last pass, 0 if none.', [['', lastRun ? Math.floor(lastRun.at / 1000) : 0]]);
    add('bidpark_settlement_last_run_ok', 'gauge', '1 when the last pass succeeded.', [['', lastRun && !lastRun.error ? 1 : 0]]);
    add('bidpark_settlement_lag_seconds', 'gauge', 'Age of the oldest job not yet confirmed, 0 if none.',
      [['', m.oldestUnconfirmedAt === null ? 0 : Math.max(0, Math.floor((now() - m.oldestUnconfirmedAt) / 1000))]]);
    return `${out.join('\n')}\n`;
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

  return { runOnce, metrics, done: () => running ?? Promise.resolve(), status, lastRun: () => lastRun };
}
