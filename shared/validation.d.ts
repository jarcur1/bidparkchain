import type { SpotMetadata } from './types';
export function validateSpotMetadata(input: unknown): {
  valid: boolean;
  error?: string;
  normalized?: SpotMetadata;
};
