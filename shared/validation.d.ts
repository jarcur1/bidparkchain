import type { SpotMetadata } from './types';
export function validateSpotMetadata(input: unknown): {
  valid: boolean;
  error?: string;
  normalized?: SpotMetadata;
};

/** True for an https URL or a safe local path starting with a single slash. */
export function isValidImageUrl(url: string): boolean;
