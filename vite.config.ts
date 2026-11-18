import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Test harnesses point the dev server at owned services; defaults are the local launcher's ports.
const apiUrl = process.env.BIDPARK_API_URL || 'http://127.0.0.1:3001';
const rpcUrl = process.env.BIDPARK_RPC_URL || 'http://127.0.0.1:8545';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BIDPARK_WEB_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': apiUrl,
      '/rpc': {
        target: rpcUrl,
        changeOrigin: true,
        rewrite: () => '/',
      },
    },
  },
});
