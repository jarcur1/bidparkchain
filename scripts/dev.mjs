import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getNetworkProfile } from '../shared/network-profiles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('exit', () => { for (const child of children) child.kill('SIGTERM'); });

function start(label, args, finite = false) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.add(child);
  child.on('error', (error) => { console.error(`${label}: ${error.message}`); stop(1); });
  child.on('exit', (code) => {
    children.delete(child);
    if (!finite && !stopping) {
      console.error(`${label} exited (${code ?? 'signal'}). Stopping local services.`);
      stop(code || 1);
    }
  });
  return child;
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is in use. Stop the existing service before npm run dev.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function ready(url, rpc = false) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url, rpc ? {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(1000),
      } : { signal: AbortSignal.timeout(1000) });
      if (response.ok && (!rpc || (await response.json()).result === '0x7a69')) return;
    } catch { /* The child service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Service did not become ready: ${url}`);
}

try {
  if (getNetworkProfile(process.env.BIDPARK_PROFILE).id !== 'local') {
    throw new Error('npm run dev only supports the local profile.');
  }
  for (const port of [8545, 3001, 5173]) await assertPortFree(port);
  console.log('\nBidPark local development • test ETH only, no real money\n');
  start('Local Ethereum chain', [path.join(root, 'node_modules/hardhat/dist/src/cli.js'), 'node', '--hostname', '127.0.0.1']);
  await ready('http://127.0.0.1:8545', true);
  const deploy = start('Contract deployment', ['scripts/deploy.mjs'], true);
  await new Promise((resolve, reject) => {
    deploy.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Contract deployment failed.')));
    deploy.once('error', reject);
  });
  if (!stopping) {
    start('Marketplace API', ['server/index.mjs']);
    await ready('http://127.0.0.1:3001/api/config');
    start('Web app', [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1']);
    await ready('http://127.0.0.1:5173');
    console.log('\nBIDPARK READY → http://127.0.0.1:5173\nLocal test network only. Ctrl+C stops all services.\n');
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
