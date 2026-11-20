// Gas snapshot for ParkingAuctionEscrow, measured on an owned Hardhat node.
//   node tests/gas/gas-snapshot.mjs          check (CI): fails when a value drifts beyond TOLERANCE_PERCENT
//   node tests/gas/gas-snapshot.mjs update   rewrite tests/gas/gas-snapshot.json and the README gas figures
// Every block is stamped with an explicit timestamp, so measured gas does not depend on the wall clock.
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { SOLIDITY_SETTINGS, SOLIDITY_VERSION } from '../../scripts/helpers/compiler.mjs';
import { ROOT_DIR, createScope, deployEscrow } from '../support/owned-env.mjs';

const SNAPSHOT_PATH = path.join(ROOT_DIR, 'tests/gas/gas-snapshot.json');
const README_PATH = path.join(ROOT_DIR, 'README.md');
const README_BLOCK = /(<!-- gas:start -->)([\s\S]*?)(<!-- gas:end -->)/;
const TOLERANCE_PERCENT = 1;
const WINDOW_COUNT = 63;
const FIRST_BLOCK = 2_000_000_000;
const SCENARIO_SPAN = 100_000; // seconds between scenarios, longer than any scenario's own span
const HOUR = 3600;
const DAY = 86_400;
const GAS_LIMIT = 6_000_000n;
const MIN_BID = ethers.parseEther('0.01');
const HASH = ethers.id('gas-snapshot');

// Runs each scenario on a fresh escrow, so no scenario sees another one's state.
async function measure(chain) {
  const { provider } = chain;
  const [alice, bob] = [1, 2].map((index) => chain.wallet(index));
  const gas = {};
  let started = 0;

  // Sends one transaction in a block stamped `time`; returns the gas it used.
  const at = async (time, send) => {
    await provider.send('evm_setNextBlockTimestamp', [time]);
    return Number((await (await send()).wait()).gasUsed);
  };

  // Deploys a fresh escrow whose blocks start at its own base time, then measures against it.
  const scenario = async (name, measureOn) => {
    const base = FIRST_BLOCK + started++ * SCENARIO_SPAN;
    await provider.send('evm_setNextBlockTimestamp', [base]);
    const { contract } = await deployEscrow(chain);
    gas[name] = await measureOn(contract, base);
  };

  // Times are offsets from `base`; bidding on every listing closes at base + HOUR.
  const auctionArgs = (base) => [HASH, MIN_BID, base + HOUR, base + DAY, base + DAY + HOUR];
  // Calendar window n is one hour long and starts a day out.
  const windowArgs = (base, n, bidEnd = base + HOUR) => {
    const start = base + DAY + n * HOUR;
    return [HASH, MIN_BID, bidEnd, start, start + HOUR];
  };
  // Creates a one-off listing at block base + 1 and returns its auction id.
  const createListing = async (escrow, base) => {
    const id = await escrow.createAuction.staticCall(...auctionArgs(base));
    await at(base + 1, () => escrow.createAuction(...auctionArgs(base), { gasLimit: GAS_LIMIT }));
    return id;
  };
  // Registers a space at base + 1 and lists `count` windows on it, one per block from base + 2.
  const spaceWithWindows = async (escrow, base, count) => {
    const spaceId = await escrow.registerSpace.staticCall();
    await at(base + 1, () => escrow.registerSpace({ gasLimit: GAS_LIMIT }));
    for (let n = 0; n < count; n++) {
      await at(base + 2 + n, () => escrow.createSpaceAuction(spaceId, ...windowArgs(base, n), { gasLimit: GAS_LIMIT }));
    }
    return spaceId;
  };

  await scenario('createAuction', (escrow, base) =>
    at(base + 1, () => escrow.createAuction(...auctionArgs(base), { gasLimit: GAS_LIMIT })),
  );
  await scenario('createSpaceAuction.0windows', async (escrow, base) => {
    const spaceId = await spaceWithWindows(escrow, base, 0);
    return at(base + 100, () => escrow.createSpaceAuction(spaceId, ...windowArgs(base, 0), { gasLimit: GAS_LIMIT }));
  });
  await scenario('createSpaceAuction.63windows', async (escrow, base) => {
    const spaceId = await spaceWithWindows(escrow, base, WINDOW_COUNT);
    const next = windowArgs(base, WINDOW_COUNT);
    return at(base + 100, () => escrow.createSpaceAuction(spaceId, ...next, { gasLimit: GAS_LIMIT }));
  });
  await scenario('createSpaceAuction.prune63', async (escrow, base) => {
    // Nobody bids on these windows, so once bidding closes at base + HOUR every one of them is stale.
    const spaceId = await spaceWithWindows(escrow, base, WINDOW_COUNT);
    const relist = windowArgs(base, WINDOW_COUNT, base + 3 * HOUR);
    return at(base + 2 * HOUR, () => escrow.createSpaceAuction(spaceId, ...relist, { gasLimit: GAS_LIMIT }));
  });
  await scenario('bid.first', async (escrow, base) => {
    const id = await createListing(escrow, base);
    return at(base + 2, () => escrow.connect(alice).bid(id, { value: MIN_BID, gasLimit: GAS_LIMIT }));
  });
  await scenario('bid.outbid', async (escrow, base) => {
    const id = await createListing(escrow, base);
    await at(base + 2, () => escrow.connect(alice).bid(id, { value: MIN_BID, gasLimit: GAS_LIMIT }));
    return at(base + 3, () => escrow.connect(bob).bid(id, { value: MIN_BID * 2n, gasLimit: GAS_LIMIT }));
  });
  await scenario('settle', async (escrow, base) => {
    const id = await createListing(escrow, base);
    await at(base + 2, () => escrow.connect(alice).bid(id, { value: MIN_BID, gasLimit: GAS_LIMIT }));
    return at(base + HOUR, () => escrow.connect(bob).settle(id, { gasLimit: GAS_LIMIT }));
  });
  await scenario('withdrawRefund', async (escrow, base) => {
    const id = await createListing(escrow, base);
    await at(base + 2, () => escrow.connect(alice).bid(id, { value: MIN_BID, gasLimit: GAS_LIMIT }));
    await at(base + 3, () => escrow.connect(bob).bid(id, { value: MIN_BID * 2n, gasLimit: GAS_LIMIT }));
    return at(base + 4, () => escrow.connect(alice).withdrawRefund({ gasLimit: GAS_LIMIT }));
  });
  return gas;
}

const toolchain = () => ({
  solc: SOLIDITY_VERSION,
  evmVersion: SOLIDITY_SETTINGS.evmVersion,
  optimizerRuns: SOLIDITY_SETTINGS.optimizer.runs,
  hardhat: JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'node_modules/hardhat/package.json'), 'utf8')).version,
});

const kilo = (gas) => `${Math.round(gas / 1000)}k`;

// The README sentence is generated from the snapshot; only the text between the markers is owned here.
const readmeFigures = (gas) =>
  `listing with ${WINDOW_COUNT} upcoming windows costs about ${kilo(gas['createSpaceAuction.63windows'])} gas, ` +
  `against ${kilo(gas['createSpaceAuction.0windows'])} for an empty space; the listing that prunes ` +
  `${WINDOW_COUNT} stale windows costs about ${kilo(gas['createSpaceAuction.prune63'])} once.`;

const currentReadmeFigures = (readme) => README_BLOCK.exec(readme)?.[2];

function replaceReadmeFigures(readme, figures) {
  if (!README_BLOCK.test(readme)) throw new Error('README.md has no <!-- gas:start --> / <!-- gas:end --> markers');
  return readme.replace(README_BLOCK, (_match, open, _current, close) => `${open}${figures}${close}`);
}

// Returns one table row per scenario, plus a problem for each drift beyond tolerance or mismatched key.
function compare(expected, measured) {
  const rows = [];
  const problems = [];
  for (const name of new Set([...Object.keys(expected), ...Object.keys(measured)])) {
    const snapshot = expected[name];
    const actual = measured[name];
    if (snapshot === undefined || actual === undefined) {
      problems.push(`${name}: ${snapshot === undefined ? 'not in the snapshot' : 'not measured'}`);
      continue;
    }
    const drift = ((actual - snapshot) / snapshot) * 100;
    rows.push(
      `${name.padEnd(32)}${String(snapshot).padStart(10)}${String(actual).padStart(10)}${`${drift.toFixed(2)}%`.padStart(9)}`,
    );
    if (Math.abs(drift) > TOLERANCE_PERCENT) {
      problems.push(`${name}: ${drift.toFixed(2)}% drift exceeds ${TOLERANCE_PERCENT}%`);
    }
  }
  return { rows, problems };
}

async function main(mode) {
  const scope = await createScope('gas');
  let chain;
  let measured;
  try {
    chain = await scope.startChain();
    measured = await measure(chain);
  } finally {
    try {
      await scope.close();
    } finally {
      chain?.provider.destroy();
    }
  }

  const readme = fs.readFileSync(README_PATH, 'utf8');
  if (mode === 'update') {
    const nextReadme = replaceReadmeFigures(readme, readmeFigures(measured));
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify({ toolchain: toolchain(), gas: measured }, null, 2)}\n`);
    fs.writeFileSync(README_PATH, nextReadme);
    for (const [name, value] of Object.entries(measured)) console.log(`${name.padEnd(32)}${String(value).padStart(10)}`);
    console.log(`Wrote ${path.relative(ROOT_DIR, SNAPSHOT_PATH)} and the README gas figures.`);
    return;
  }

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const { rows, problems } = compare(snapshot.gas, measured);
  if (currentReadmeFigures(readme) !== readmeFigures(snapshot.gas)) {
    problems.push('README gas figures do not match the snapshot');
  }
  console.log(`${'scenario'.padEnd(32)}${'snapshot'.padStart(10)}${'measured'.padStart(10)}${'drift'.padStart(9)}`);
  console.log(rows.join('\n'));
  if (problems.length > 0) {
    console.error(`\nGas check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    console.error('If the change is intended, refresh with: npm run gas:snapshot');
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${rows.length} gas values are within ${TOLERANCE_PERCENT}% of the snapshot.`);
  }
}

const mode = process.argv[2] ?? 'check';
if (mode === 'check' || mode === 'update') {
  await main(mode);
} else {
  console.error('usage: node tests/gas/gas-snapshot.mjs [check|update]');
  process.exitCode = 2;
}
