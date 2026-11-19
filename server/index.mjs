import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import { resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';

export { createApp };

/**
 * Starts the API and returns `close()`, which stops accepting connections, lets in-flight requests
 * finish (up to `drainMs`, then cuts the remaining connections), and only then closes the database
 * and RPC provider, so no request ever runs against a closed resource.
 */
export function serve({ port = 3001, host = '127.0.0.1', drainMs = 10_000, indexIntervalMs = 5_000, webDir, ...options } = {}) {
  const { app, db, provider, syncIndexOnce, indexingDone, settlement, settlementIntervalMs } = createApp(options);
  if (webDir) {
    // Hosted mode serves the built web app from the same origin as /api: no Vite dev server and no
    // /rpc proxy. Hashed assets are cached for a year; index.html is always revalidated.
    const root = path.resolve(webDir);
    app.use(express.static(root, {
      index: false,
      setHeaders: (res, file) => res.setHeader('Cache-Control',
        file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    }));
    app.use((req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method) || req.path === '/api' || req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(root, 'index.html'));
    });
  }
  const server = app.listen(port, host);
  // Background indexer job; 0 disables it. Shutdown waits for a pass in flight before closing the DB.
  const indexTimer = indexIntervalMs > 0 ? setInterval(() => void syncIndexOnce(), indexIntervalMs) : null;
  if (indexTimer) void syncIndexOnce();
  // Optional settlement keeper, same lifecycle: shutdown waits for a pass in flight.
  const settleTimer = settlement ? setInterval(() => void settlement.runOnce(), settlementIntervalMs) : null;
  if (settleTimer) void settlement.runOnce();
  let closing = null;
  const close = () => closing ??= new Promise((resolve) => {
    if (indexTimer) clearInterval(indexTimer);
    if (settleTimer) clearInterval(settleTimer);
    const force = setTimeout(() => server.closeAllConnections(), drainMs);
    server.close(async () => {
      clearTimeout(force);
      await Promise.all([indexingDone(), settlement?.done()]);
      db.close();
      provider.destroy();
      resolve();
    });
    server.closeIdleConnections();
  });
  return { server, db, provider, close, syncIndexOnce, settlement };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3001;
  // Keep the default loopback bind behind a TLS-terminating reverse proxy.
  const host = process.env.BIDPARK_HOST || '127.0.0.1';
  const indexIntervalMs = process.env.BIDPARK_INDEX_INTERVAL_MS === undefined ? 5_000 : Number(process.env.BIDPARK_INDEX_INTERVAL_MS);
  const { server, close } = serve({ runtime: resolveRuntimeProfile(), port, host, indexIntervalMs, webDir: process.env.BIDPARK_WEB_DIR || undefined });
  server.once('listening', () => {
    console.log(`[BidPark API] Escrow metadata server running at http://${host}:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      console.log(`[BidPark API] ${signal}: draining in-flight requests, then closing the database.`);
      close().then(() => process.exit(0));
    });
  }
}
