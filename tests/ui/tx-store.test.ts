import { beforeEach, expect, it } from 'vitest';
import {
  patchTransaction, readTransactions, recordTransaction, staleTransactionsFor, transactionsFor, type TxScope,
} from '../../src/utils/txStore';
import type { SpotMetadata } from '../../src/types';

const scope: TxScope = { account: '0xAbC0000000000000000000000000000000000001', chainId: 31337, contract: '0xC0', deployment: 'dep-1' };
const metadata = { title: 'Garage', address: '1 Main St', neighborhood: 'Downtown', latitude: 1, longitude: 2, description: 'Covered.', image: '/g.jpg', kind: 'garage', amenities: [] } as SpotMetadata;

beforeEach(() => localStorage.clear());

it('persists records across a reload and scopes them by account, chain, contract and deployment', () => {
  recordTransaction({ id: 'a', kind: 'bid', label: 'Bid', status: 'awaiting-wallet', scope });
  recordTransaction({ id: 'b', kind: 'bid', label: 'Other account', status: 'confirmed', scope: { ...scope, account: '0x02' } });
  recordTransaction({ id: 'c', kind: 'bid', label: 'Other chain', status: 'confirmed', scope: { ...scope, chainId: 11155111 } });
  recordTransaction({ id: 'd', kind: 'settle', label: 'Reset chain', status: 'submitted', scope: { ...scope, deployment: 'dep-0' } });
  // Simulates a reload: the store reads back from localStorage.
  expect(JSON.parse(localStorage.getItem('bidpark_transactions_v1')!)).toHaveLength(4);
  expect(transactionsFor({ ...scope, account: scope.account.toLowerCase() }).map((r) => r.id)).toEqual(['a']);
  expect(staleTransactionsFor(scope).map((r) => r.id)).toEqual(['d']);
});

it('keeps committed metadata immutable once the transaction is submitted', () => {
  recordTransaction({ id: 'c1', kind: 'create', label: 'List Garage', status: 'awaiting-wallet', scope, metadata });
  patchTransaction('c1', { status: 'submitted', hash: '0x1' });
  patchTransaction('c1', { metadata: { ...metadata, title: 'Edited' }, auctionId: '7', registered: false });
  const stored = readTransactions().find((r) => r.id === 'c1')!;
  expect(stored).toMatchObject({ status: 'submitted', hash: '0x1', auctionId: '7', registered: false });
  expect(stored.metadata?.title).toBe('Garage');
});

it('never stores anything that looks like a key, and caps history', () => {
  for (let i = 0; i < 60; i++) recordTransaction({ id: String(i), kind: 'bid', label: `Bid ${i}`, status: 'confirmed', scope });
  const raw = localStorage.getItem('bidpark_transactions_v1')!;
  expect(JSON.parse(raw)).toHaveLength(50);
  expect(raw).not.toMatch(/mnemonic|privateKey/i);
});
