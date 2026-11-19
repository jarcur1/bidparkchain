import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '../../server/index.mjs';
import { createScope } from '../support/owned-env.mjs';

let scope;
beforeAll(async () => { scope = await createScope('api-shutdown'); });
afterAll(async () => { await scope?.close(); });

/** A JSON-RPC endpoint that answers chain id 31337 but holds every other call until released. */
async function slowRpc() {
  const held = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = (calls) => [calls].flat().map(({ id, method }) => ({
      jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x7a69' : '0x1',
    }));
    const parsed = JSON.parse(body);
    const respond = () => res.end(JSON.stringify(Array.isArray(parsed) ? reply(parsed) : reply(parsed)[0]));
    if ([parsed].flat().every((c) => c.method === 'eth_chainId')) respond();
    else held.push(respond);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, held, stop: () => new Promise((r) => server.close(r)) };
}

it('drains an in-flight request before closing the database and provider', async () => {
  const rpc = await slowRpc();
  const dataDir = scope.tempDir();
  const deploymentPath = path.join(dataDir, 'deployment.json');
  fs.writeFileSync(deploymentPath, JSON.stringify({ chainId: 31337, contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3', abi: [], deploymentBlock: 0 }));
  const api = serve({ port: 0, dbPath: path.join(dataDir, 'bidpark.db'), deploymentPath, rpcUrl: rpc.url });
  await once(api.server, 'listening');
  const url = `http://127.0.0.1:${api.server.address().port}`;
  try {
    // /api/config waits on the held RPC call, so this request is in flight when shutdown starts.
    const inFlight = fetch(`${url}/api/config`);
    await expect.poll(() => rpc.held.length).toBeGreaterThan(0);
    let closed = false;
    const closePromise = api.close();
    const closing = closePromise.then(() => { closed = true; });

    await expect(fetch(`${url}/api/config`)).rejects.toThrow();
    expect(closed).toBe(false);
    expect(api.db.db.isOpen).toBe(true);

    rpc.held.splice(0).forEach((respond) => respond());
    const response = await inFlight;
    expect(response.status).toBeLessThan(600);
    await closing;
    expect(closed).toBe(true);
    expect(api.db.db.isOpen).toBe(false);
    expect(api.close()).toBe(closePromise);
  } finally {
    await rpc.stop();
  }
});
