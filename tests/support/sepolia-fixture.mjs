import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { ethers } from 'ethers';
import { createScope, findFreePort, ROOT_DIR, rpcChainId } from './owned-env.mjs';

// This fixture never uses a public RPC. The proxy can hold finality behind the chain head.
export async function createSepoliaFixture() {
  const scope = await createScope('sepolia-profile');
  const port = await findFreePort();
  const upstream = `http://127.0.0.1:${port}`;
  try {
    await scope.startService({
      label: 'owned Sepolia-ID Hardhat node',
      args: [path.join(ROOT_DIR, 'node_modules/hardhat/dist/src/cli.js'), '--config', 'hardhat.config.ts', 'node', '--chain-id', '11155111', '--hostname', '127.0.0.1', '--port', String(port)],
      ready: async () => await rpcChainId(upstream) === '0xaa36a7',
    });
    let finalized = null;
    let fail = false;
    let declineNextBroadcast = false;
    let rejectHashPins = false;
    const broadcasts = [];
    const proxy = createServer(async (req, res) => {
      try {
        if (fail) { res.writeHead(503); res.end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const handle = async (request) => {
          if (request.method === 'eth_sendRawTransaction') {
            broadcasts.push(request.params[0]);
            if (declineNextBroadcast) {
              declineNextBroadcast = false;
              return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Broadcast declined by fixture' } };
            }
          }
          if (rejectHashPins && request.params?.some((value) => value && typeof value === 'object' && 'blockHash' in value)) {
            return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Hash-pinned calls unsupported by fixture' } };
          }
          const params = await Promise.all((request.params || []).map(async (value) => {
            if (value === 'finalized') return finalized === null ? 'latest' : ethers.toQuantity(finalized);
            if (!value || typeof value !== 'object' || !('blockHash' in value)) return value;
            // Hardhat may not implement EIP-1898. Emulate it only after checking canonicality.
            const rpc = async (method, params) => {
              const response = await fetch(upstream, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
              });
              return (await response.json()).result;
            };
            const block = await rpc('eth_getBlockByHash', [value.blockHash, false]);
            const canonical = block && await rpc('eth_getBlockByNumber', [block.number, false]);
            if (!block || canonical?.hash?.toLowerCase() !== value.blockHash.toLowerCase()) throw new Error('Noncanonical block');
            return block.number;
          }));
          const mapped = { ...request, params };
          const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mapped) });
          if (!response.ok) throw new Error('Upstream RPC failure');
          return await response.json();
        };
        const result = Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch { res.writeHead(502); res.end(); }
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const rpcUrl = `http://127.0.0.1:${proxy.address().port}/private-operator-token`;
    const provider = new ethers.JsonRpcProvider(upstream, undefined, { cacheTimeout: -1 });
    const key = ethers.Wallet.createRandom().privateKey;
    const wallet = new ethers.Wallet(key, provider);
    const funder = await provider.getSigner(0);
    await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('10') })).wait();
    return {
      scope, provider, wallet, key, rpcUrl,
      env(dataDir) { return { BIDPARK_PROFILE: 'sepolia', BIDPARK_DATA_DIR: dataDir, BIDPARK_SEPOLIA_RPC_URL: rpcUrl }; },
      setFinalized(block) { finalized = block; },
      setFailure(value) { fail = value; },
      declineNextBroadcast() { declineNextBroadcast = true; },
      setRejectHashPins(value) { rejectHashPins = value; },
      broadcasts,
      async close() { provider.destroy(); await new Promise((resolve) => proxy.close(resolve)); await scope.close(); },
    };
  } catch (error) { await scope.close(); throw error; }
}

export async function runProfileDeploy(env, args = []) {
  return await new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    // Never inherit an operator credential or unrelated profile configuration from the host.
    for (const name of Object.keys(childEnv)) if (name === 'RPC_URL' || name.startsWith('BIDPARK_')) delete childEnv[name];
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, ['scripts/deploy.mjs', ...args], { cwd: ROOT_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}
