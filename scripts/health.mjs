// Read-only health check for a shared or public-testnet deployment. It never signs, sends
// transactions, snapshots, reverts or changes time: only the RPC methods in READ_ONLY_METHODS
// are ever issued. Destructive verification lives in the isolated test suites (npm test).
//
//   HEALTH_RPC_URL           JSON-RPC endpoint (required)
//   HEALTH_CHAIN_ID          expected chain id, decimal (required)
//   HEALTH_CONTRACT_ADDRESS  expected escrow address (required)
//   HEALTH_API_URL           marketplace API base URL, e.g. https://host (optional)
//   HEALTH_MAX_BLOCK_AGE     max seconds since the latest block (optional, default 600)
import { ethers } from 'ethers';

const READ_ONLY_METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_getBlockByNumber', 'eth_call']);
const TIMEOUT_MS = 10_000;
const escrow = new ethers.Interface(['function nextAuctionId() view returns (uint256)']);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function rpc(url, method, params) {
  if (!READ_ONLY_METHODS.has(method)) throw new Error(`Refusing non-read-only RPC method ${method}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'RPC error'}`);
  return body.result;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${response.status}`);
  return await response.json();
}

async function main() {
  const rpcUrl = required('HEALTH_RPC_URL');
  const chainId = BigInt(required('HEALTH_CHAIN_ID'));
  const contractAddress = ethers.getAddress(required('HEALTH_CONTRACT_ADDRESS'));
  const apiUrl = process.env.HEALTH_API_URL?.trim().replace(/\/+$/, '');
  const maxBlockAge = Number(process.env.HEALTH_MAX_BLOCK_AGE || 600);

  const checks = [];
  const check = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await check('chain id', async () => {
    const actual = BigInt(await rpc(rpcUrl, 'eth_chainId', []));
    if (actual !== chainId) throw new Error(`expected ${chainId}, got ${actual}`);
    return String(actual);
  });
  await check('contract code', async () => {
    const code = await rpc(rpcUrl, 'eth_getCode', [contractAddress, 'latest']);
    if (!code || code === '0x') throw new Error(`no code at ${contractAddress}`);
    return `${(code.length - 2) / 2} bytes`;
  });
  await check('contract readable', async () => {
    const data = escrow.encodeFunctionData('nextAuctionId');
    const result = await rpc(rpcUrl, 'eth_call', [{ to: contractAddress, data }, 'latest']);
    return `nextAuctionId ${escrow.decodeFunctionResult('nextAuctionId', result)[0]}`;
  });
  await check('block freshness', async () => {
    const block = await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    const age = Math.floor(Date.now() / 1000) - Number(block.timestamp);
    if (age > maxBlockAge) throw new Error(`latest block ${Number(block.number)} is ${age}s old`);
    return `block ${Number(block.number)}, ${age}s old`;
  });

  if (apiUrl) {
    await check('api config identity', async () => {
      const config = await getJson(`${apiUrl}/api/config`);
      if (BigInt(config.chainId) !== chainId) throw new Error(`API chainId ${config.chainId}`);
      if (ethers.getAddress(config.contractAddress) !== contractAddress) {
        throw new Error(`API contract ${config.contractAddress}`);
      }
      return 'matches';
    });
    await check('api listings', async () => {
      const body = await getJson(`${apiUrl}/api/listings`);
      if (!Array.isArray(body.listings)) throw new Error('listings is not an array');
      return `${body.listings.length} listings`;
    });
  }

  for (const { name, ok, detail } of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
