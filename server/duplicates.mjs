/**
 * Duplicate-space detection. Each registered listing yields alias keys for its space: a normalized
 * street address and a ~11 m location cell. A different host's space with a key in common is flagged
 * to moderators and the new host is warned. Detection is advisory; it never blocks a listing.
 */
const ABBREVIATIONS = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln', court: 'ct', place: 'pl',
  north: 'n', south: 's', east: 'e', west: 'w', apartment: 'apt', suite: 'ste', unit: 'unit',
};
const UNIT_WORDS = new Set(['apt', 'ste', 'unit', '#']);

/** Lowercases, drops punctuation, abbreviates common street words and removes unit designators. */
export function normalizeAddress(address) {
  const words = String(address).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/#/g, ' # ').replace(/[^a-z0-9# ]+/g, ' ').split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = ABBREVIATIONS[words[i]] ?? words[i];
    if (UNIT_WORDS.has(word)) { i += 1; continue; }
    kept.push(word);
  }
  return kept.join(' ');
}

// ponytail: fixed 4-decimal grid cells miss two points straddling a cell edge; use a neighbour lookup if that matters.
export function aliasKeys({ address, latitude, longitude }) {
  return [`addr:${normalizeAddress(address)}`, `geo:${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`];
}

export const matchKind = (key) => (key.startsWith('addr:') ? 'address' : 'location');
