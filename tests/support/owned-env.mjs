// Disposable test environments: every chain, service, port and directory here belongs to the
// calling test. Nothing connects to the developer's 8545/3001/5173 services or the repo's data/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { compileEscrowContract } from '../../scripts/helpers/compiler.mjs';
import { HARDHAT_CHAIN_ID, getProvider, getWallet } from '../../scripts/helpers/chain.mjs';

export const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const GUARD = path.join(ROOT_DIR, 'tests/support/resource-guard.mjs');
const HARDHAT_CLI = path.join(ROOT_DIR, 'node_modules/hardhat/dist/src/cli.js');
const READY_TIMEOUT_MS = 30_000;

const liveGuards = new Set();
// Synchronous last resort; guards also clean up when this process dies and closes their stdin.
process.once('exit', () => {
  for (const guard of liveGuards) guard.kill('SIGTERM');
});

/** Returns a currently unused loopback TCP port. */
export async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startGuard(spec) {
  const guard = spawn(process.execPath, [GUARD, JSON.stringify(spec)], {
    cwd: ROOT_DIR,
    // Own process group: a group-wide SIGKILL of the test runner (CI timeout) cannot take the
    // guard down before it notices the closed stdin and cleans up.
    detached: true,
    stdio: ['pipe', process.env.BIDPARK_TEST_VERBOSE ? 'inherit' : 'ignore', 'inherit'],
  });
  liveGuards.add(guard);
  const exited = new Promise((resolve) => guard.once('exit', (code) => {
    liveGuards.delete(guard);
    resolve(code);
  }));
  return {
    guard,
    exited,
    async stop() {
      if (guard.exitCode === null && guard.signalCode === null) guard.kill('SIGTERM');
      await exited;
    },
  };
}

async function waitUntil(check, label, exited) {
  let exitCode;
  exited.then((code) => { exitCode = code; });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`${label} exited (${exitCode}) before becoming ready`);
    try {
      if (await check()) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready within ${READY_TIMEOUT_MS}ms`);
}

export async function rpcChainId(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(1000),
  });
  return (await response.json()).result;
}

let compiled;
/** Compiles the escrow contract once per process. */
export function escrowArtifact() {
  compiled ??= compileEscrowContract();
  return compiled;
}

/**
 * Creates an isolated scope. Call `close()` in afterAll/finally; resources are also reclaimed if
 * the test process is interrupted or killed.
 * @param {string} name label used for the temp directory
 */
export async function createScope(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bidpark-${name}-`));
  const handles = [];
  // Owns the directory itself so it is removed even if the test process is killed.
  const dirGuard = startGuard({ removePaths: [dir] });

  const scope = {
    dir,

    /** Creates a fresh subdirectory inside the scope. */
    tempDir(label = 'data') {
      return fs.mkdtempSync(path.join(dir, `${label}-`));
    },

    /**
     * Starts a long-running node process owned by this scope.
     * @param {{ label: string, args: string[], env?: Record<string, string>, ready: () => Promise<boolean> }} options
     */
    async startService({ label, args, env = {}, ready }) {
      const handle = startGuard({ command: [process.execPath, ...args], cwd: ROOT_DIR, env });
      handles.push(handle);
      try {
        await waitUntil(ready, label, handle.exited);
      } catch (error) {
        await handle.stop();
        throw error;
      }
      return { stop: () => handle.stop(), exited: handle.exited };
    },

    /** Starts a dedicated Hardhat node on a free port and returns connected helpers. */
    async startChain() {
      const port = await findFreePort();
      const rpcUrl = `http://127.0.0.1:${port}`;
      const service = await scope.startService({
        label: `Hardhat node :${port}`,
        args: [HARDHAT_CLI, 'node', '--hostname', '127.0.0.1', '--port', String(port)],
        ready: async () => (await rpcChainId(rpcUrl)) === ethers.toQuantity(HARDHAT_CHAIN_ID),
      });
      const provider = getProvider(rpcUrl);
      return {
        port,
        rpcUrl,
        provider,
        /** HD account from the public Hardhat mnemonic; only valid on this owned chain. */
        wallet: (index) => getWallet(index, provider),
        async increaseTime(seconds) {
          await provider.send('evm_increaseTime', [seconds]);
          await provider.send('evm_mine', []);
        },
        async latestTimestamp() {
          return (await provider.getBlock('latest')).timestamp;
        },
        async stop() {
          provider.destroy();
          await service.stop();
        },
      };
    },

    /** Starts the marketplace API (server/index.mjs) against a chain and data directory. */
    async startApi({ rpcUrl, dataDir }) {
      const port = await findFreePort();
      const url = `http://127.0.0.1:${port}`;
      const service = await scope.startService({
        label: `API :${port}`,
        args: ['server/index.mjs'],
        env: { PORT: String(port), RPC_URL: rpcUrl, BIDPARK_DATA_DIR: dataDir },
        ready: async () => (await fetch(`${url}/api/does-not-exist`, { signal: AbortSignal.timeout(1000) })).status === 404,
      });
      return { ...service, port, url };
    },

    async close() {
      await Promise.all(handles.map((handle) => handle.stop()));
      await dirGuard.stop();
    },
  };
  return scope;
}

/**
 * Deploys a fresh escrow contract with account 0 and returns a connected instance.
 * @param {{ provider: ethers.Provider, wallet: (i: number) => ethers.Wallet }} chain
 */
export async function deployEscrow(chain) {
  const { abi, bytecode } = escrowArtifact();
  const factory = new ethers.ContractFactory(abi, bytecode, chain.wallet(0));
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction().wait();
  return {
    contract,
    abi,
    address: await contract.getAddress(),
    deploymentTxHash: receipt.hash,
    deploymentBlock: receipt.blockNumber,
  };
}

/** Writes a deployment descriptor in the same shape scripts/deploy.mjs produces. */
export function writeDeployment(dataDir, deployment) {
  const descriptor = {
    chainId: HARDHAT_CHAIN_ID,
    contractAddress: deployment.address,
    deploymentTxHash: deployment.deploymentTxHash,
    abi: deployment.abi,
    currency: 'ETH',
    networkName: 'Hardhat Local',
    demoMnemonic: 'test test test test test test test test test test test junk',
    demoAccountIndex: 1,
    deploymentBlock: deployment.deploymentBlock,
  };
  const file = path.join(dataDir, 'deployment.json');
  fs.writeFileSync(file, JSON.stringify(descriptor, null, 2));
  return file;
}

/**
 * Runs scripts/deploy.mjs (compile, deploy, seed) against an owned chain and data directory.
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function runDeployScript({ rpcUrl, dataDir }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/deploy.mjs'], {
      cwd: ROOT_DIR,
      env: { ...process.env, RPC_URL: rpcUrl, BIDPARK_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}
