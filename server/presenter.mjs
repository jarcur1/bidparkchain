import { SKIP_TARGETS, skipChainTime } from '../scripts/demo.mjs';
import { HARDHAT_CHAIN_ID } from '../scripts/helpers/chain.mjs';

// Raw JSON-RPC rather than ethers, so the gate reads the chain id the endpoint actually reports.
async function isLocalChain(rpcUrl) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Chain id probe failed with HTTP ${res.status}`);
  const { result } = await res.json();
  return BigInt(result) === BigInt(HARDHAT_CHAIN_ID);
}

/**
 * Local demo clock controls. createApp mounts this only for the local profile on a loopback RPC,
 * and each request also checks chain id 31337. Anywhere else the route is the same 404 as any unknown API route.
 */
export function mountPresenter(app, { rpcUrl, deploymentPath }) {
  app.post('/api/presenter/skip', async (req, res, next) => {
    try {
      if (!(await isLocalChain(rpcUrl))) return next();
      const target = req.body?.target;
      if (typeof target !== 'string' || !Object.hasOwn(SKIP_TARGETS, target)) {
        return res.status(400).json({ error: 'target must be "bidding" or "parking"' });
      }
      return res.json(await skipChainTime({ rpcUrl, deploymentPath, target }));
    } catch (error) {
      console.warn('[BidPark Presenter] Skip failed:', error?.message ?? error);
      return next(error);
    }
  });
}
