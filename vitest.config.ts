import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Chain-backed suites start their own Hardhat node, API and temp data per file (tests/support).
const ownedChain = {
  environment: 'node',
  pool: 'forks',
  testTimeout: 60_000,
  hookTimeout: 60_000,
} as const;

export default mergeConfig(viteConfig, defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'ui', environment: 'jsdom', include: ['tests/*.test.{ts,tsx}', 'tests/ui/**/*.test.{ts,tsx}'] },
      },
      {
        extends: true,
        test: { name: 'contracts', include: ['tests/contracts/**/*.test.{mjs,ts}'], ...ownedChain },
      },
      {
        extends: true,
        test: { name: 'api', include: ['tests/api/**/*.test.{mjs,ts}'], ...ownedChain },
      },
    ],
  },
}));
