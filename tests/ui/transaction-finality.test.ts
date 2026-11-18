import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, type Contract, type TransactionReceipt } from 'ethers';
import { fetchPendingReturns, placeBid, TransactionOutcomeUnknown } from '../../src/services/blockchain';

const txHash = '0xtransaction';
const account = '0x0000000000000000000000000000000000000001';
const contractAddress = '0x0000000000000000000000000000000000000002';
const pendingReturnsData = '0x1234';
const pendingReturnsResult = '0x5678';
const receipt = { blockNumber: 12, blockHash: '0xabc', status: 1 } as TransactionReceipt;

function fixture() {
  const provider = {
    getTransactionReceipt: vi.fn(async (_hash: string): Promise<TransactionReceipt | null> => receipt),
    getBlock: vi.fn(async (tag: string | number): Promise<{ number: number; hash: string } | null> =>
      tag === 'finalized' ? { number: 12, hash: '0xfinal' } : { number: 12, hash: '0xabc' }),
    send: vi.fn(async (method: string, _params: unknown[]): Promise<unknown> => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_accounts') return [account];
      if (method === 'eth_call') return pendingReturnsResult;
      throw new Error(`Unexpected RPC method ${method}`);
    }),
  };
  const wait = vi.fn(async (): Promise<TransactionReceipt | null> => receipt);
  const populateTransaction = vi.fn(async (..._args: unknown[]) => ({
    to: contractAddress, data: '0xbid', value: parseEther('0.5'),
  }));
  const bid = Object.assign(vi.fn(async () => ({ hash: txHash, wait })), { populateTransaction });
  const pendingReturns = vi.fn(async (..._args: unknown[]) => 42n);
  const sendUncheckedTransaction = vi.fn(async (..._args: unknown[]) => txHash);
  const contract = {
    runner: { provider, getAddress: vi.fn(async () => account), sendUncheckedTransaction },
    bid,
    pendingReturns,
    getAddress: vi.fn(async () => contractAddress),
    interface: {
      encodeFunctionData: vi.fn(() => pendingReturnsData),
      decodeFunctionResult: vi.fn(() => [42n]),
    },
  } as unknown as Contract;
  return { contract, provider, wait, bid, pendingReturns, sendUncheckedTransaction };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('transaction confirmation policy', () => {
  it('keeps the default mined flow and does not query finality', async () => {
    const { contract, provider, wait, bid } = fixture();
    await expect(placeBid(contract, '7', '0.5')).resolves.toBe(receipt);
    expect(bid).toHaveBeenCalledWith(7n, { value: parseEther('0.5') });
    expect(wait).toHaveBeenCalledOnce();
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('waits for a provider receipt, a sufficiently high finalized block, and its canonical hash', async () => {
    const { contract, provider, wait, bid, sendUncheckedTransaction } = fixture();
    provider.getTransactionReceipt.mockResolvedValueOnce(null);
    provider.getBlock.mockResolvedValueOnce({ number: 11, hash: '0xfinal' })
      .mockResolvedValueOnce({ number: 11, hash: '0xfinal' });
    let settled = false;
    const result = placeBid(contract, '7', '0.5', 'finalized').then((value) => { settled = true; return value; });

    await vi.advanceTimersByTimeAsync(0);
    expect(wait).not.toHaveBeenCalled();
    expect(bid.populateTransaction).toHaveBeenCalledWith(7n, { value: parseEther('0.5') });
    expect(sendUncheckedTransaction).toHaveBeenCalledWith({
      to: contractAddress, data: '0xbid', value: parseEther('0.5'), chainId: 11155111n,
    });
    expect(bid).not.toHaveBeenCalled();
    expect(provider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBe(false);
    expect(provider.getBlock).not.toHaveBeenCalledWith(receipt.blockNumber);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toBe(receipt);
    expect(provider.getBlock).toHaveBeenCalledWith('finalized');
    expect(provider.getBlock).toHaveBeenCalledWith(receipt.blockNumber);
  });

  it('does not accept a reorged receipt until its block hash is canonical', async () => {
    const { contract, provider } = fixture();
    const reorged = { ...receipt, blockHash: '0xold' } as TransactionReceipt;
    const canonicalReceipt = { ...receipt, blockHash: '0xnew' } as TransactionReceipt;
    provider.getTransactionReceipt.mockResolvedValueOnce(reorged).mockResolvedValue(canonicalReceipt);
    provider.getBlock.mockImplementation(async (tag) =>
      tag === 'finalized' ? { number: 12, hash: '0xfinal' } : { number: 12, hash: '0xnew' });
    let settled = false;
    const result = placeBid(contract, '7', '0.5', 'finalized').then((value) => { settled = true; return value; });

    await vi.advanceTimersByTimeAsync(0);
    expect(provider.getBlock).toHaveBeenCalledWith(12);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toBe(canonicalReceipt);
    expect(provider.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable finality with the submitted transaction hash', async () => {
    const { contract, provider } = fixture();
    provider.getBlock.mockResolvedValueOnce(null);
    const result = placeBid(contract, '7', '0.5', 'finalized');
    await expect(result).rejects.toBeInstanceOf(TransactionOutcomeUnknown);
    await expect(result).rejects.toMatchObject({ hash: txHash });
    await expect(result).rejects.toThrow('finalized block is unavailable');
  });
});

describe('pending returns confirmation policy', () => {
  it('reads the default mined balance without a block override', async () => {
    const { contract, provider, pendingReturns } = fixture();
    await expect(fetchPendingReturns(contract, account)).resolves.toBe(42n);
    expect(pendingReturns).toHaveBeenCalledWith(account);
    expect(provider.getBlock).not.toHaveBeenCalled();
  });

  it('pins the balance read to the finalized block and verifies its hash', async () => {
    const { contract, provider, pendingReturns } = fixture();
    provider.getBlock.mockResolvedValueOnce({ number: 12, hash: '0xabc' });
    await expect(fetchPendingReturns(contract, account, 'finalized')).resolves.toBe(42n);
    expect(pendingReturns).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledWith('eth_call', [
      { to: contractAddress, data: pendingReturnsData },
      { blockHash: '0xabc', requireCanonical: true },
    ]);
    expect(provider.getBlock.mock.calls).toEqual([['finalized'], [12]]);
  });

  it('rejects a balance if the pinned block changes during the read', async () => {
    const { contract, provider, pendingReturns } = fixture();
    provider.getBlock.mockResolvedValueOnce({ number: 12, hash: '0xold' })
      .mockResolvedValueOnce({ number: 12, hash: '0xnew' });
    await expect(fetchPendingReturns(contract, account, 'finalized')).rejects.toThrow('block changed');
    expect(pendingReturns).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledWith('eth_call', [
      { to: contractAddress, data: pendingReturnsData },
      { blockHash: '0xold', requireCanonical: true },
    ]);
    expect(provider.getBlock.mock.calls).toEqual([['finalized'], [12]]);
  });
});
