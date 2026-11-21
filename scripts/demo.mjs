// Class demo helpers for a local campus scenario (#38). Local Hardhat chain only.
//   npm run demo -- walkthrough   scripted bid, outbid, refund, settle on spot N1
//   npm run demo -- advance       move the chain clock past every open bidding deadline
//   npm run demo -- compare       fixture-derived near/far counts for both scenarios (no chain needed)
//   npm run demo -- commuters     scripted four-commuter run on the current scenario (#40)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers, FetchRequest } from 'ethers';
import { assertLocalChain, getProvider, getWallet, HARDHAT_CHAIN_ID, HARDHAT_RPC_URL } from './helpers/chain.mjs';
import { CAMPUS_EXPANSION_REMOVED, getSeededListings } from './helpers/seed-data.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Simulated roles: Hardhat development accounts 0-2. */
export const DEMO_ROLES = { host: 0, driverA: 1, driverB: 2 };
/** Scripted amounts, chosen for the demo; they are not derived from the fixtures. */
export const DEMO_BIDS = { driverA: '0.03', driverB: '0.05' };

// An RPC that redirects could carry privileged calls (evm_*) to another host, so any 3xx is an error.
function getNoRedirectProvider(rpcUrl) {
  const request = new FetchRequest(rpcUrl);
  const send = FetchRequest.createGetUrlFunc();
  request.getUrlFunc = async (req, signal) => {
    const response = await send(req, signal);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new Error(`Refusing RPC redirect (HTTP ${response.statusCode}).`);
    }
    return response;
  };
  return new ethers.JsonRpcProvider(request, { chainId: HARDHAT_CHAIN_ID, name: 'hardhat' }, { cacheTimeout: -1, staticNetwork: true });
}

async function openDemo(rpcUrl, deploymentPath) {
  if (process.env.BIDPARK_PROFILE && process.env.BIDPARK_PROFILE !== 'local') {
    throw new Error('Demo helpers only run with the local profile.');
  }
  if (!LOOPBACK.has(new URL(rpcUrl).hostname)) throw new Error(`Refusing non-loopback RPC ${rpcUrl}.`);
  const provider = getNoRedirectProvider(rpcUrl);
  await assertLocalChain(provider);
  if (!fs.existsSync(deploymentPath)) throw new Error('No local deployment found. Start the stack with npm run dev first.');
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  if ((await provider.getCode(deployment.contractAddress)) === '0x') {
    throw new Error('The deployment in this data directory is not on this chain. Restart npm run dev.');
  }
  const contract = new ethers.Contract(deployment.contractAddress, deployment.abi, provider);
  return { provider, contract, scenario: deployment.seedScenario ?? 'austin' };
}

async function chainNow(provider) {
  return (await provider.getBlock('latest')).timestamp;
}

async function advanceTo(provider, timestamp) {
  const delta = timestamp - (await chainNow(provider));
  if (delta > 0) await provider.send('evm_increaseTime', [delta]);
  await provider.send('evm_mine', []);
}

/**
 * Chain-time skip targets. Each moves chain time past the latest deadline still in play for that target:
 * bidding closes auctions that are neither settled nor cancelled; parking ends every auction that is not cancelled.
 */
export const SKIP_TARGETS = {
  bidding: { deadline: 'bidEnd', inPlay: (a) => !a.settled && !a.cancelled },
  parking: { deadline: 'parkingEnd', inPlay: (a) => !a.cancelled },
};

// Skips run one at a time so two requests cannot read the same head and both move the clock.
let skipQueue = Promise.resolve();

/**
 * Moves chain time to one second past the latest open deadline for `target` (a SKIP_TARGETS key).
 * The target is an absolute timestamp, so repeating a skip is a no-op once the head has passed it.
 */
export function skipChainTime(options) {
  const run = skipQueue.then(() => skipChainTimeOnce(options));
  skipQueue = run.catch(() => {});
  return run;
}

async function skipChainTimeOnce({ rpcUrl = HARDHAT_RPC_URL, deploymentPath, target }) {
  if (!Object.hasOwn(SKIP_TARGETS, target)) throw new Error(`Unknown skip target: ${target}`);
  const rule = SKIP_TARGETS[target];
  const { provider, contract } = await openDemo(rpcUrl, deploymentPath);
  try {
    const now = await chainNow(provider);
    let latest = 0;
    for (let id = 1n; id < (await contract.nextAuctionId()); id++) {
      const a = await contract.auctions(id);
      const deadline = Number(a[rule.deadline]);
      if (rule.inPlay(a) && deadline > now) latest = Math.max(latest, deadline);
    }
    if (latest) {
      // evm_setNextBlockTimestamp is absolute and rejects a timestamp at or before the head, so it cannot overshoot.
      await provider.send('evm_setNextBlockTimestamp', [latest + 1]);
      await provider.send('evm_mine', []);
    }
    const chainTime = await chainNow(provider);
    return { advancedSeconds: latest ? Math.max(0, chainTime - now) : 0, chainTime };
  } finally {
    provider.destroy();
  }
}

/** Moves chain time to one second past the latest open bidding deadline. */
export async function advancePastBidding({ rpcUrl = HARDHAT_RPC_URL, dataDir }) {
  return skipChainTime({ rpcUrl, deploymentPath: path.join(dataDir, 'deployment.json'), target: 'bidding' });
}

/**
 * Driver A bids, driver B outbids, A withdraws the displaced bid, bidding closes, B settles.
 * Requires a fresh campus scenario; restart npm run dev to run it again.
 */
export async function runWalkthrough({ rpcUrl = HARDHAT_RPC_URL, dataDir, log = () => {} }) {
  const { provider, contract, scenario } = await openDemo(rpcUrl, path.join(dataDir, 'deployment.json'));
  try {
    if (!scenario.startsWith('campus-')) throw new Error('Run the walkthrough with BIDPARK_SCENARIO=campus-baseline or campus-expansion.');
    const spot = getSeededListings(0, scenario).find((l) => l.fixtureId === 'N1');
    let id;
    for (let i = 1n; i < (await contract.nextAuctionId()); i++) {
      if ((await contract.auctions(i)).metadataHash === spot.metadataHash) id = i;
    }
    if (!id) throw new Error('Spot N1 is not seeded on this deployment.');
    if ((await contract.auctions(id)).highestBidder !== ethers.ZeroAddress) {
      throw new Error('Spot N1 already has bids. Restart npm run dev for a clean run.');
    }
    const [driverA, driverB] = [getWallet(DEMO_ROLES.driverA, provider), getWallet(DEMO_ROLES.driverB, provider)];
    const as = (wallet) => contract.connect(wallet);
    const send = async (tx) => (await tx).wait();

    await send(as(driverA).bid(id, { value: ethers.parseEther(DEMO_BIDS.driverA) }));
    log(`1. Driver A (account ${DEMO_ROLES.driverA}) bids ${DEMO_BIDS.driverA} ETH on N1 (auction #${id}).`);
    await send(as(driverB).bid(id, { value: ethers.parseEther(DEMO_BIDS.driverB) }));
    const refund = await contract.pendingReturns(driverA.address);
    log(`2. Driver B (account ${DEMO_ROLES.driverB}) outbids with ${DEMO_BIDS.driverB} ETH; A can withdraw ${ethers.formatEther(refund)} ETH.`);
    await send(as(driverA).withdrawRefund());
    log(`3. Driver A withdraws the displaced ${ethers.formatEther(refund)} ETH.`);
    await advanceTo(provider, Number((await contract.auctions(id)).bidEnd) + 1);
    log('4. Demo clock moves past the bidding deadline.');
    await send(as(driverB).settle(id));
    const final = await contract.auctions(id);
    log(`5. Settled: winner is driver B with ${ethers.formatEther(final.highestBid)} ETH. Simulated record only; no real parking access.`);
    return {
      scenario,
      auctionId: String(id),
      winner: final.highestBidder === driverB.address ? 'driverB' : final.highestBidder,
      winningBid: ethers.formatEther(final.highestBid),
      refundWithdrawn: ethers.formatEther(refund),
      refundLeft: ethers.formatEther(await contract.pendingReturns(driverA.address)),
      settled: final.settled,
    };
  } finally {
    provider.destroy();
  }
}

/** Near/far counts read straight from the seed fixtures, plus the one planned supply change. */
export function compareScenarios() {
  const scenarios = Object.fromEntries(['campus-baseline', 'campus-expansion'].map((scenario) => {
    const spots = getSeededListings(0, scenario);
    const near = spots.filter((l) => l.tier === 'near');
    return [scenario, {
      near: near.length,
      far: spots.length - near.length,
      nearSpots: near.map((l) => l.fixtureId),
      openingBids: Object.fromEntries(spots.map((l) => [l.tier, l.minBidEth])),
    }];
  }));
  return { scenarios, removedForExpansion: CAMPUS_EXPANSION_REMOVED };
}

/** Example commuters: Hardhat development accounts 1-4, the same four in both scenarios. */
export const COMMUTERS = [1, 2, 3, 4].map((index) => ({ name: `Commuter ${index}`, index }));
/** Scripted raise when no near spot is free. A script choice, not a prediction of real prices. */
export const SCRIPTED_RAISE = '0.01';

/**
 * Scripted policy, in commuter order: take a free near spot at its opening bid; if none is free,
 * outbid the current N1 leader by SCRIPTED_RAISE. Everyone outbid then takes the next farther-away
 * spot at its opening bid. Bidding closes, every auction with a bid is settled, winners are read back.
 */
export async function runCommuters({ rpcUrl = HARDHAT_RPC_URL, dataDir, log = () => {} }) {
  const { provider, contract, scenario } = await openDemo(rpcUrl, path.join(dataDir, 'deployment.json'));
  try {
    if (!scenario.startsWith('campus-')) throw new Error('Run commuters with BIDPARK_SCENARIO=campus-baseline or campus-expansion.');
    const ids = new Map();
    for (let i = 1n; i < (await contract.nextAuctionId()); i++) ids.set((await contract.auctions(i)).metadataHash, i);
    const spots = getSeededListings(0, scenario).map((l) => ({ ...l, id: ids.get(l.metadataHash) }));
    for (const spot of spots) {
      if (!spot.id) throw new Error(`Spot ${spot.fixtureId} is not seeded on this deployment.`);
      if ((await contract.auctions(spot.id)).highestBidder !== ethers.ZeroAddress) {
        throw new Error('Campus spots already have bids. Restart npm run dev for a clean run.');
      }
    }
    const near = spots.filter((l) => l.tier === 'near');
    const far = spots.filter((l) => l.tier === 'far');
    const n1 = near.find((l) => l.fixtureId === 'N1');
    const wallets = new Map(COMMUTERS.map((c) => [c.index, getWallet(c.index, provider)]));
    const bid = async (commuter, spot, eth) => {
      await (await contract.connect(wallets.get(commuter.index)).bid(spot.id, { value: ethers.parseEther(eth) })).wait();
      log(`  ${commuter.name} bids ${eth} ETH on ${spot.fixtureId} (${spot.tier}).`);
    };

    log(`Scenario ${scenario}: ${near.length} near spots, ${far.length} farther away.`);
    const free = [...near];
    let n1Leader = null;
    let n1Bid = n1.minBidEth;
    const outbid = [];
    for (const commuter of COMMUTERS) {
      const spot = free.shift();
      if (spot) {
        await bid(commuter, spot, spot.minBidEth);
        if (spot === n1) n1Leader = commuter;
        continue;
      }
      n1Bid = ethers.formatEther(ethers.parseEther(n1Bid) + ethers.parseEther(SCRIPTED_RAISE));
      await bid(commuter, n1, n1Bid);
      outbid.push(n1Leader);
      n1Leader = commuter;
    }
    for (const commuter of outbid) {
      const spot = far.shift();
      log(`  ${commuter.name} was outbid on N1 and falls back.`);
      await bid(commuter, spot, spot.minBidEth);
    }

    // Every campus spot shares one bidding window.
    await advanceTo(provider, Number((await contract.auctions(n1.id)).bidEnd) + 1);
    const byAddress = new Map(COMMUTERS.map((c) => [wallets.get(c.index).address, c.name]));
    const results = [];
    for (const spot of spots) {
      const a = await contract.auctions(spot.id);
      if (a.highestBidder === ethers.ZeroAddress) continue;
      await (await contract.connect(wallets.get(COMMUTERS[0].index)).settle(spot.id)).wait();
      results.push({ commuter: byAddress.get(a.highestBidder), spot: spot.fixtureId, tier: spot.tier, winningBid: ethers.formatEther(a.highestBid) });
    }
    results.sort((a, b) => a.commuter.localeCompare(b.commuter));
    log('Settled (simulated records only, no real parking access):');
    for (const r of results) log(`  ${r.commuter}: ${r.spot} (${r.tier}) for ${r.winningBid} ETH`);
    return {
      scenario,
      nearWinners: results.filter((r) => r.tier === 'near').length,
      farWinners: results.filter((r) => r.tier === 'far').length,
      results,
    };
  } finally {
    provider.destroy();
  }
}

function printComparison() {
  const { scenarios, removedForExpansion } = compareScenarios();
  console.log('Fixture-derived counts (scripts/helpers/seed-data.mjs):');
  for (const [name, c] of Object.entries(scenarios)) {
    console.log(`  ${name}: ${c.near} near (${c.nearSpots.join(', ')}), ${c.far} farther away; opening bids near ${c.openingBids.near} / far ${c.openingBids.far} ETH`);
  }
  console.log(`  Only planned change: ${removedForExpansion.join(', ')} removed for the fictional residence hall.`);
  console.log(`Same ${COMMUTERS.length} example commuters in both. Bid amounts in "commuters" are scripted, not derived from the fixtures.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = path.resolve(process.env.BIDPARK_DATA_DIR || path.join(ROOT_DIR, 'data'));
  const command = process.argv[2];
  const run = command === 'walkthrough'
    ? runWalkthrough({ dataDir, log: console.log })
    : command === 'compare'
      ? Promise.resolve(printComparison())
    : command === 'commuters'
      ? runCommuters({ dataDir, log: console.log })
    : command === 'advance'
      ? advancePastBidding({ dataDir }).then((r) => console.log(`Advanced the chain clock ${r.advancedSeconds}s. Refresh the app.`))
      : Promise.reject(new Error('Usage: npm run demo -- walkthrough | advance | compare | commuters'));
  run.catch((error) => {
    console.error(`[BidPark Demo] ${error.message}`);
    process.exit(1);
  });
}
