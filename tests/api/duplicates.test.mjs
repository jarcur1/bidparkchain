import { expect, it } from 'vitest';
import { aliasKeys, normalizeAddress } from '../../server/duplicates.mjs';

it('normalizes address spelling, case, punctuation and unit designators', () => {
  const plain = normalizeAddress('12 Elm Street');
  expect(plain).toBe('12 elm st');
  for (const alias of ['12 ELM ST.', '12  elm street, Apt 3', '12 Elm St #B', '12 Elm Street, Suite 400']) {
    expect(normalizeAddress(alias)).toBe(plain);
  }
  expect(normalizeAddress('14 Elm Street')).not.toBe(plain);
  expect(normalizeAddress('12 North Elm Avenue')).toBe('12 n elm ave');
});

it('derives an address key and an 11 m location key', () => {
  expect(aliasKeys({ address: '12 Elm Street', latitude: 30.30001, longitude: -97.73002 }))
    .toEqual(['addr:12 elm st', 'geo:30.3000,-97.7300']);
});
