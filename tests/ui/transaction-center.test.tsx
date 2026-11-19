import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TransactionCenter } from '../../src/components/TransactionCenter';
import type { TxRecord } from '../../src/utils/txStore';
import type { SpotMetadata } from '../../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scope = { account: '0x01', chainId: 11155111, contract: '0xc', deployment: 'd' };
const hash = `0x${'ab'.repeat(32)}`;
const base = { scope, createdAt: 1, updatedAt: 1 };
const records: TxRecord[] = [
  { ...base, id: '1', kind: 'create', label: 'List "Garage"', status: 'confirmed', hash, auctionId: '4', registered: false, metadata: { title: 'Garage' } as SpotMetadata },
  { ...base, id: '2', kind: 'bid', label: 'Bid 0.1 ETH on auction #3', status: 'replaced', hash, replacementHash: `0x${'cd'.repeat(32)}` },
  { ...base, id: '3', kind: 'withdraw', label: 'Withdraw refund', status: 'rejected' },
  { ...base, id: '4', kind: 'settle', label: 'Settle auction #2', status: 'unknown', hash },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('shows each status in words with explorer links, and offers registration for a confirmed listing', () => {
  const onCompleteRegistration = vi.fn();
  act(() => root.render(<TransactionCenter records={records} staleCount={2} explorerUrl="https://sepolia.etherscan.io/" onCompleteRegistration={onCompleteRegistration} isActionBusy={false} />));
  const text = host.textContent ?? '';
  expect(text).toContain('Replaced by another transaction');
  expect(text).toContain('Rejected in wallet');
  expect(text).toContain('Not sent');
  expect(text).toContain('Outcome unknown, check the transaction');
  expect(text).toContain("2 earlier transactions belong to a previous deployment of this chain (it was reset)");
  const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(links).toContain(`https://sepolia.etherscan.io/tx/${hash}`);
  expect(links).toContain(`https://sepolia.etherscan.io/tx/0x${'cd'.repeat(32)}`);
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Complete registration')!;
  act(() => button.click());
  expect(onCompleteRegistration).toHaveBeenCalledWith(records[0]);
});
