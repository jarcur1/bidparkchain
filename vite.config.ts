import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { getNetworkProfile } from './shared/network-profiles.mjs';

// Test harnesses point the dev server at owned services; defaults are the local launcher's ports.
const apiUrl = process.env.BIDPARK_API_URL || 'http://127.0.0.1:3001';
const profile = getNetworkProfile(process.env.BIDPARK_PROFILE);
let rpcUrl: string | undefined;
if (profile.id === 'local') {
  rpcUrl = process.env.BIDPARK_RPC_URL ?? 'http://127.0.0.1:8545';
  let target: URL;
  try {
    target = new URL(rpcUrl);
  } catch {
    throw new Error('Invalid local RPC proxy configuration');
  }
  const loopback = target.hostname === 'localhost' || target.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
  if (!loopback || !['http:', 'https:'].includes(target.protocol) ||
      target.username || target.password || target.hash) {
    throw new Error('Local RPC proxy must target loopback HTTP(S)');
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BIDPARK_PROFILE': JSON.stringify(profile.id),
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BIDPARK_WEB_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': apiUrl,
      ...(rpcUrl ? {
        '/rpc': {
          target: rpcUrl,
          changeOrigin: true,
          rewrite: () => '/',
        },
      } : {}),
    },
  },
});
