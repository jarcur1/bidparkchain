import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';

export { createApp };

/**
 * Starts the API and returns `close()`, which stops accepting connections, lets in-flight requests
 * finish (up to `drainMs`, then cuts the remaining connections), and only then closes the database
 * and RPC provider, so no request ever runs against a closed resource.
 */
export function serve({ port = 3001, host = '127.0.0.1', drainMs = 10_000, ...options } = {}) {
  const { app, db, provider } = createApp(options);
  const server = app.listen(port, host);
  let closing = null;
  const close = () => closing ??= new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), drainMs);
    server.close(() => {
      clearTimeout(force);
      db.close();
      provider.destroy();
      resolve();
    });
    server.closeIdleConnections();
  });
  return { server, db, provider, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3001;
  const { server, close } = serve({ runtime: resolveRuntimeProfile(), port });
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
