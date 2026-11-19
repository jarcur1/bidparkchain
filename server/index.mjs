import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';

export { createApp };

/**
 * Starts the API and returns `close()`, which stops accepting connections, lets in-flight requests
 * finish (up to `drainMs`, then cuts the remaining connections), and only then closes the database
 * and RPC provider, so no request ever runs against a closed resource.
 */
export function serve({ port = 3001, host = '127.0.0.1', drainMs = 10_000, indexIntervalMs = 5_000, ...options } = {}) {
  const { app, db, provider, syncIndexOnce, indexingDone } = createApp(options);
  const server = app.listen(port, host);
  // Background indexer job; 0 disables it. Shutdown waits for a pass in flight before closing the DB.
  const indexTimer = indexIntervalMs > 0 ? setInterval(() => void syncIndexOnce(), indexIntervalMs) : null;
  if (indexTimer) void syncIndexOnce();
  let closing = null;
  const close = () => closing ??= new Promise((resolve) => {
    if (indexTimer) clearInterval(indexTimer);
    const force = setTimeout(() => server.closeAllConnections(), drainMs);
    server.close(async () => {
      clearTimeout(force);
      await indexingDone();
      db.close();
      provider.destroy();
      resolve();
    });
    server.closeIdleConnections();
  });
  return { server, db, provider, close, syncIndexOnce };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3001;
  const indexIntervalMs = process.env.BIDPARK_INDEX_INTERVAL_MS === undefined ? 5_000 : Number(process.env.BIDPARK_INDEX_INTERVAL_MS);
  const { server, close } = serve({ runtime: resolveRuntimeProfile(), port, indexIntervalMs });
  server.once('listening', () => {
    console.log(`[BidPark API] Escrow metadata server running at http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      console.log(`[BidPark API] ${signal}: draining in-flight requests, then closing the database.`);
      close().then(() => process.exit(0));
    });
  }
}
