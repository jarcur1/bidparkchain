import path from 'node:path';
import { createApp } from './app.mjs';

export { createApp };

const PORT = Number(process.env.PORT) || 3001;
const HOST = '127.0.0.1';

const { app } = createApp();

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
