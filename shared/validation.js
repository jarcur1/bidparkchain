import { normalizeMetadata } from './metadata.js';

const VALID_KINDS = new Set(['garage', 'driveway', 'covered']);

/**
 * Validates whether an image URL is an allowed HTTPS URL or safe local relative path.
 * Explicitly rejects javascript:, data:, file:, or dangerous URI schemes.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isValidImageUrl(url) {
  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }

  // Safe relative paths for local assets (e.g. /images/spot.jpg)
  if (url.startsWith('/') && !url.startsWith('//') && !/[<>"'\s]/.test(url)) {
    return true;
  }

  // Safe loopback HTTP for local dev assets
  if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
    try {
      const parsed = new URL(url);
      return (
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      );
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Validates SpotMetadata against conservative bounds.
 * Coordinates must be explicit finite JSON numbers (no null / empty string coercion).
 * Image must be a valid https URL or safe local asset path.
 *
 * @param {unknown} input
 * @returns {{ valid: boolean, error?: string, normalized?: ReturnType<typeof normalizeMetadata> }}
 */
export function validateSpotMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Metadata must be a non-null JSON object' };
  }

  const raw = /** @type {Record<string, unknown>} */ (input);

  // Title validation
  if (typeof raw.title !== 'string') {
    return { valid: false, error: 'Metadata field "title" must be a string' };
  }
  const title = raw.title.trim();
  if (title.length < 3 || title.length > 120) {
    return { valid: false, error: 'Title length must be between 3 and 120 characters' };
  }

  // Address validation
  if (typeof raw.address !== 'string') {
    return { valid: false, error: 'Metadata field "address" must be a string' };
  }
  const address = raw.address.trim();
  if (address.length < 5 || address.length > 200) {
    return { valid: false, error: 'Address length must be between 5 and 200 characters' };
  }

  // Neighborhood validation
  if (typeof raw.neighborhood !== 'string') {
    return { valid: false, error: 'Metadata field "neighborhood" must be a string' };
  }
  const neighborhood = raw.neighborhood.trim();
  if (neighborhood.length < 2 || neighborhood.length > 100) {
    return { valid: false, error: 'Neighborhood length must be between 2 and 100 characters' };
  }

  // Latitude validation - requires strict finite JSON number, no null/empty-string coercion
  if (typeof raw.latitude !== 'number' || !Number.isFinite(raw.latitude)) {
    return { valid: false, error: 'Latitude must be an explicit finite JSON number' };
  }
  if (raw.latitude < -90 || raw.latitude > 90) {
    return { valid: false, error: 'Latitude must be between -90 and 90' };
  }

  // Longitude validation - requires strict finite JSON number
  if (typeof raw.longitude !== 'number' || !Number.isFinite(raw.longitude)) {
    return { valid: false, error: 'Longitude must be an explicit finite JSON number' };
  }
  if (raw.longitude < -180 || raw.longitude > 180) {
    return { valid: false, error: 'Longitude must be between -180 and 180' };
  }

  // Description validation
  if (typeof raw.description !== 'string') {
    return { valid: false, error: 'Metadata field "description" must be a string' };
  }
  const description = raw.description.trim();
  if (description.length < 10 || description.length > 2000) {
    return { valid: false, error: 'Description length must be between 10 and 2000 characters' };
  }

  // Image validation - requires https or safe local asset path
  if (typeof raw.image !== 'string') {
    return { valid: false, error: 'Metadata field "image" must be a string URL' };
  }
  const image = raw.image.trim();
  if (image.length < 5 || image.length > 1000) {
    return { valid: false, error: 'Image URL length must be between 5 and 1000 characters' };
  }
  if (!isValidImageUrl(image)) {
    return {
      valid: false,
      error: 'Image must be a valid secure HTTPS URL or safe local asset path',
    };
  }

  // Kind validation
  if (typeof raw.kind !== 'string' || !VALID_KINDS.has(raw.kind)) {
    return {
      valid: false,
      error: `Kind must be one of: ${Array.from(VALID_KINDS).join(', ')}`,
    };
  }

  // Amenities validation
  if (!Array.isArray(raw.amenities)) {
    return { valid: false, error: 'Amenities must be an array of strings' };
  }
  if (raw.amenities.length > 20) {
    return { valid: false, error: 'Amenities list cannot exceed 20 items' };
  }
  for (const item of raw.amenities) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 60) {
      return { valid: false, error: 'Each amenity must be a non-empty string under 60 characters' };
    }
  }

  const normalized = normalizeMetadata({
    title,
    address,
    neighborhood,
    latitude: raw.latitude,
    longitude: raw.longitude,
    description,
    image,
    kind: raw.kind,
    amenities: raw.amenities,
  });

  return { valid: true, normalized };
}
