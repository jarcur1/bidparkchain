import { describe, expect, it, vi } from 'vitest';
import type { Contract, TransactionReceipt } from 'ethers';
import { placeBid, settleAuction, type TxUpdate } from '../../src/services/blockchain';

const receipt = { hash: '0xmined', blockNumber: 1, blockHash: '0xb', status: 1 } as TransactionReceipt;

/** A contract whose `bid`/`settle` send behaves as `sent`, and whose receipt wait behaves as `waited`. */
function contractWith(sent: () => Promise<unknown>, waited: () => Promise<TransactionReceipt | null> = async () => receipt) {
  const call = vi.fn(async () => { await sent(); return { hash: '0xsent', wait: waited }; });
  return { bid: call, settle: call } as unknown as Contract;
}
async function statuses(contract: Contract, run = (c: Contract, observe: (u: TxUpdate) => void) => placeBid(c, '1', '0.1', 'mined', observe)) {
  const updates: TxUpdate[] = [];
  await run(contract, (u) => updates.push(u)).catch(() => {});
  return updates;
}

describe('transaction status reporting', () => {
  it('reports wallet approval, submission, confirming and confirmation with the hash', async () => {
    expect(await statuses(contractWith(async () => {}))).toEqual([
      { status: 'awaiting-wallet' },
      { status: 'submitted', hash: '0xsent' },
      { status: 'confirming', hash: '0xsent' },
      { status: 'confirmed', hash: '0xmined' },
    ]);
  });

  it('separates a wallet refusal from a failure before anything was submitted', async () => {
    const rejected = await statuses(contractWith(async () => { throw Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' }); }));
    expect(rejected.map((u) => u.status)).toEqual(['awaiting-wallet', 'rejected']);
    const failed = await statuses(contractWith(async () => { throw new Error('insufficient funds'); }));
    expect(failed.map((u) => u.status)).toEqual(['awaiting-wallet', 'failed']);
    expect(failed.at(-1)).not.toHaveProperty('hash');
  });

  it.each([
    ['replaced', { code: 'TRANSACTION_REPLACED', reason: 'replaced', replacement: { hash: '0xnew' } }, { status: 'replaced', replacementHash: '0xnew' }],
    ['cancelled', { code: 'TRANSACTION_REPLACED', reason: 'cancelled', replacement: { hash: '0xzero' } }, { status: 'cancelled', replacementHash: '0xzero' }],
    ['reverted', { code: 'CALL_EXCEPTION' }, { status: 'reverted' }],
    ['unknown', { code: 'NETWORK_ERROR' }, { status: 'unknown' }],
  ])('classifies a %s transaction after submission, keeping its hash', async (_name, failure, expected) => {
    const updates = await statuses(contractWith(async () => {}, async () => { throw Object.assign(new Error(String(failure.code)), failure); }), (c, observe) => settleAuction(c, '1', 'mined', observe));
    expect(updates.map((u) => u.status).slice(0, 3)).toEqual(['awaiting-wallet', 'submitted', 'confirming']);
    expect(updates.at(-1)).toMatchObject({ ...expected, hash: '0xsent' });
  });
});
