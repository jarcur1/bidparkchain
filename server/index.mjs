import path from 'node:path';
import { createApp } from './app.mjs';

export { createApp };

const PORT = Number(process.env.PORT) || 3001;
const HOST = '127.0.0.1';
const DATA_DIR = process.env.BIDPARK_DATA_DIR;

const { app } = createApp(DATA_DIR ? {
  dbPath: path.resolve(DATA_DIR, 'bidpark.db'),
  deploymentPath: path.resolve(DATA_DIR, 'deployment.json'),
} : {});

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
