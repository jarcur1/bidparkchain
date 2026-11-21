import type { SpotMetadata } from './types';
export function validateSpotMetadata(input: unknown): {
  valid: boolean;
  error?: string;
  normalized?: SpotMetadata;
};

/** True for an https URL or a safe local path starting with a single slash. */
export function isValidImageUrl(url: string): boolean;

/** Largest photo the API accepts in one upload; bigger uploads are refused with 413. */
export const PHOTO_MAX_BYTES: number;
