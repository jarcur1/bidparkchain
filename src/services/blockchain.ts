import {
  Contract,
  Interface,
  JsonRpcProvider,
  type BrowserProvider,
  type JsonRpcSigner,
  keccak256,
  parseEther,
  toUtf8Bytes,
  type ContractRunner,
  type InterfaceAbi,
  type TransactionReceipt,
} from 'ethers';
import { normalizeMetadata } from '../../shared/metadata.js';
import type { SpotMetadata } from '../types';

export function computeMetadataHash(metadata: SpotMetadata): string {
  const normalized = normalizeMetadata(metadata);
  const jsonStr = JSON.stringify(normalized);
  return keccak256(toUtf8Bytes(jsonStr));
}

export function getContractInstance(
  address: string,
  abi: InterfaceAbi,
  runner: ContractRunner
): Contract {
  return new Contract(address, abi, runner);
}

export type ConfirmationPolicy = 'mined' | 'finalized';
const FINALITY_TIMEOUT_MS = 15 * 60 * 1000;
const FINALITY_POLL_MS = 4000;

export class TransactionOutcomeUnknown extends Error {
  constructor(public readonly hash: string, detail: string) {
    super(`Transaction ${hash} was submitted but its outcome is unknown: ${detail}`);
    this.name = 'TransactionOutcomeUnknown';
  }
}

class CanonicalRevert extends Error {}

async function dispatchFinalized(contract: Contract, method: string, args: unknown[]): Promise<{ hash: string; wait: () => Promise<TransactionReceipt | null> }> {
  const signer = contract.runner as JsonRpcSigner | null;
  const provider = signer?.provider as BrowserProvider | null;
  if (!signer || !provider || typeof signer.sendUncheckedTransaction !== 'function' || typeof provider.send !== 'function') {
    throw new Error('A browser wallet signer is required for Sepolia transactions.');
  }
  const populated = await contract[method].populateTransaction(...args);
  const address = await signer.getAddress();
  const chain = await provider.send('eth_chainId', []);
  const accounts = await provider.send('eth_accounts', []) as string[];
  if (BigInt(chain) !== 11155111n || !Array.isArray(accounts) ||
      !accounts.some((account) => typeof account === 'string' && account.toLowerCase() === address.toLowerCase())) {
    throw new Error('Wallet account or network changed before transaction submission.');
  }
  const hash = await signer.sendUncheckedTransaction({ ...populated, chainId: 11155111n });
  return { hash, wait: () => provider.waitForTransaction(hash) };
}

async function waitForTransaction(
  tx: { hash: string; wait: () => Promise<TransactionReceipt | null> },
  contract: Contract,
  confirmation: ConfirmationPolicy,
): Promise<TransactionReceipt> {
  if (confirmation === 'mined') {
    const receipt = await tx.wait();
    if (!receipt) throw new Error(`Transaction ${tx.hash} was submitted but receipt was null`);
    return receipt;
  }
  const provider = contract.runner?.provider;
  if (!provider) throw new TransactionOutcomeUnknown(tx.hash, 'no provider is available');
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransactionOutcomeUnknown(tx.hash, 'finality timed out')), FINALITY_TIMEOUT_MS);
  });
  const check = async (): Promise<TransactionReceipt> => {
    while (Date.now() < deadline) {
      let receipt: TransactionReceipt | null;
      try {
        receipt = await provider.getTransactionReceipt(tx.hash);
        const finalized = await provider.getBlock('finalized');
        if (!finalized?.hash || !Number.isSafeInteger(finalized.number) || finalized.number < 0) {
          throw new Error('finalized block is unavailable');
        }
        if (receipt && receipt.blockNumber <= finalized.number) {
          const canonical = await provider.getBlock(receipt.blockNumber);
          if (canonical?.hash && canonical.hash.toLowerCase() === receipt.blockHash.toLowerCase()) {
            if (receipt.status === 0) throw new CanonicalRevert();
            if (receipt.status !== 1) throw new Error('receipt has no execution status');
            return receipt;
          }
        }
      } catch (error) {
        if (error instanceof CanonicalRevert) throw new Error(`Transaction ${tx.hash} reverted in a finalized block`);
        throw new TransactionOutcomeUnknown(tx.hash, error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_MS));
    }
    throw new TransactionOutcomeUnknown(tx.hash, 'finality timed out');
  };
  try {
    return await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPendingReturns(
  contract: Contract,
  accountAddress: string,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<bigint> {
  if (confirmation === 'mined') return (await contract.pendingReturns(accountAddress)) as bigint;
  const provider = contract.runner?.provider as BrowserProvider | null;
  if (!provider || typeof provider.send !== 'function') throw new Error(`Finalized pending returns unavailable for ${accountAddress}: no RPC provider`);
  const block = await provider.getBlock('finalized');
  if (!block?.hash || !Number.isSafeInteger(block.number) || block.number < 0) {
    throw new Error(`Finalized pending returns unavailable for ${accountAddress}: finalized block unavailable`);
  }
  const result = await provider.send('eth_call', [
    { to: await contract.getAddress(), data: contract.interface.encodeFunctionData('pendingReturns', [accountAddress]) },
    { blockHash: block.hash, requireCanonical: true },
  ]);
  const balance = contract.interface.decodeFunctionResult('pendingReturns', result)[0] as bigint;
  const canonical = await provider.getBlock(block.number);
  if (!canonical?.hash || canonical.hash.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error(`Finalized pending returns unavailable for ${accountAddress}: block changed`);
  }
  return balance;
}

export interface CreateAuctionResult {
  receipt: TransactionReceipt;
  auctionId: string;
}

export async function createAuctionOnChain(
  contract: Contract,
  metadata: SpotMetadata,
  minBidEth: string,
  bidEndSec: number,
  parkingStartSec: number,
  parkingEndSec: number,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<CreateAuctionResult> {
  const metadataHash = computeMetadataHash(metadata);
  const minBidWei = parseEther(minBidEth);

  const args = [metadataHash, minBidWei, BigInt(bidEndSec), BigInt(parkingStartSec), BigInt(parkingEndSec)];
  const tx = confirmation === 'finalized'
    ? await dispatchFinalized(contract, 'createAuction', args)
    : await contract.createAuction(...args);

  const receipt = await waitForTransaction(tx, contract, confirmation);

  // Parse logs for AuctionCreated(uint256 indexed id, address indexed owner)
  let auctionId = '';
  const iface = contract.interface as Interface;

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed && parsed.name === 'AuctionCreated') {
        const idArg = parsed.args[0] as bigint | number | string;
        auctionId = idArg.toString();
        break;
      }
    } catch {
      // not an event from this contract interface
    }
  }

  if (!auctionId) {
    if (confirmation === 'finalized') throw new TransactionOutcomeUnknown(tx.hash, 'AuctionCreated event not found in finalized receipt');
    throw new Error('AuctionCreated event not emitted in transaction receipt');
  }

  return { receipt, auctionId };
}

export async function placeBid(
  contract: Contract,
  auctionId: string,
  bidAmountEth: string,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<TransactionReceipt> {
  const valueWei = parseEther(bidAmountEth);
  const tx = confirmation === 'finalized'
    ? await dispatchFinalized(contract, 'bid', [BigInt(auctionId), { value: valueWei }])
    : await contract.bid(BigInt(auctionId), { value: valueWei });
  return waitForTransaction(tx, contract, confirmation);
}

export async function withdrawRefund(contract: Contract, confirmation: ConfirmationPolicy = 'mined'): Promise<TransactionReceipt> {
  const tx = confirmation === 'finalized' ? await dispatchFinalized(contract, 'withdrawRefund', []) : await contract.withdrawRefund();
  return waitForTransaction(tx, contract, confirmation);
}

export async function settleAuction(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<TransactionReceipt> {
  const tx = confirmation === 'finalized' ? await dispatchFinalized(contract, 'settle', [BigInt(auctionId)]) : await contract.settle(BigInt(auctionId));
  return waitForTransaction(tx, contract, confirmation);
}

export async function cancelAuction(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<TransactionReceipt> {
  const tx = confirmation === 'finalized' ? await dispatchFinalized(contract, 'cancel', [BigInt(auctionId)]) : await contract.cancel(BigInt(auctionId));
  return waitForTransaction(tx, contract, confirmation);
}

export async function claimPayout(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<TransactionReceipt> {
  const tx = confirmation === 'finalized' ? await dispatchFinalized(contract, 'claimPayout', [BigInt(auctionId)]) : await contract.claimPayout(BigInt(auctionId));
  return waitForTransaction(tx, contract, confirmation);
}

const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  BidTooLow: 'Another bid reached or passed your amount first. Your input was kept; raise it above the new highest bid.',
  AuctionEnded: 'Bidding closed on-chain before your bid was mined.',
  AlreadySettled: 'This auction was already settled.',
  AlreadyCancelled: 'This auction was cancelled.',
  AuctionCancelledError: 'This auction was cancelled.',
  AuctionNotFound: 'This auction does not exist on the connected deployment.',
  OwnerCannotBid: 'Spot owners cannot bid on their own listing.',
};

export function parseContractError(err: unknown): string {
  if (!err) return 'Unknown error occurred';

  if (typeof err === 'object') {
    const errorObj = err as Record<string, unknown>;

    // Decoded custom errors from the escrow contract ABI
    const revert = errorObj.revert;
    if (revert && typeof revert === 'object') {
      const known = CONTRACT_ERROR_MESSAGES[(revert as Record<string, unknown>).name as string];
      if (known) return known;
    }

    // Ethers custom error or reason
    if (typeof errorObj.reason === 'string') return errorObj.reason;
    if (typeof errorObj.shortMessage === 'string') return errorObj.shortMessage;

    // Check data.message
    if (errorObj.data && typeof errorObj.data === 'object') {
      const dataObj = errorObj.data as Record<string, unknown>;
      if (typeof dataObj.message === 'string') return dataObj.message;
    }

    // Check info.error.message
    if (errorObj.info && typeof errorObj.info === 'object') {
      const infoObj = errorObj.info as Record<string, unknown>;
      if (infoObj.error && typeof infoObj.error === 'object') {
        const inner = infoObj.error as Record<string, unknown>;
        if (typeof inner.message === 'string') return inner.message;
      }
    }

    if (typeof errorObj.message === 'string') {
      const msg = errorObj.message;
      // Clean up common Hardhat revert messages
      if (msg.includes('execution reverted:')) {
        const match = msg.match(/execution reverted:\s*([^\n]+)/);
        if (match && match[1]) return match[1].trim();
      }
      if (msg.includes('user rejected action')) {
        return 'Transaction cancelled by user.';
      }
      return msg.length > 150 ? msg.slice(0, 150) + '…' : msg;
    }
  }

  return String(err);
}
