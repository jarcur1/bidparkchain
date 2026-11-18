import { createApp } from './app.mjs';
import { resolveRuntimeProfile } from '../scripts/helpers/runtime-profile.mjs';

export { createApp };

const PORT = Number(process.env.PORT) || 3001;
const HOST = '127.0.0.1';
const runtime = resolveRuntimeProfile();
const { app } = createApp({ runtime });

const server = app.listen(PORT, HOST, () => {
  console.log(`[BidPark API] Escrow metadata server running at http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
