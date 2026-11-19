import {
  Contract,
  type EventLog,
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

/** Auction ids this account has ever bid on, from BidPlaced logs at the same confirmation level as listings. */
export async function fetchBidAuctionIds(
  contract: Contract,
  accountAddress: string,
  fromBlock: number,
  confirmation: ConfirmationPolicy = 'mined',
): Promise<Set<string>> {
  const logs = await contract.queryFilter(
    contract.filters.BidPlaced(null, accountAddress),
    fromBlock,
    confirmation === 'finalized' ? 'finalized' : 'latest',
  );
  return new Set(logs.map((log) => String((log as EventLog).args.id)));
}

/** Lifecycle of one wallet transaction, as shown in the transaction center. */
export type TxStatus =
  | 'awaiting-wallet' | 'submitted' | 'confirming' | 'confirmed'
  | 'rejected' | 'failed' | 'reverted' | 'replaced' | 'cancelled' | 'unknown';
export interface TxUpdate { status: TxStatus; hash?: string; replacementHash?: string; error?: string }
export type TxObserver = (update: TxUpdate) => void;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isUserRejection(error: unknown): boolean {
  const e = error as { code?: unknown; info?: { error?: { code?: unknown } } } | null;
  return e?.code === 'ACTION_REJECTED' || e?.code === 4001 || e?.info?.error?.code === 4001;
}

/** Classifies a failure after the transaction was submitted. */
export function settledFailure(error: unknown, hash: string): TxUpdate {
  const e = error as { code?: unknown; reason?: unknown; replacement?: { hash?: string } } | null;
  if (e?.code === 'TRANSACTION_REPLACED') {
    return { status: e.reason === 'cancelled' ? 'cancelled' : 'replaced', hash, replacementHash: e.replacement?.hash, error: message(error) };
  }
  if (e?.code === 'CALL_EXCEPTION' || /reverted/i.test(message(error))) return { status: 'reverted', hash, error: message(error) };
  return { status: 'unknown', hash, error: message(error) };
}

/**
 * Sends one contract call and reports each step: waiting for the wallet, submitted (with hash),
 * confirming, then confirmed, reverted, replaced/cancelled, or unknown. A refusal in the wallet is
 * 'rejected'; any other failure before submission is 'failed' and no transaction exists.
 */
async function send(
  contract: Contract,
  method: string,
  args: unknown[],
  confirmation: ConfirmationPolicy,
  observe: TxObserver = () => {},
): Promise<TransactionReceipt> {
  observe({ status: 'awaiting-wallet' });
  let tx: { hash: string; wait: () => Promise<TransactionReceipt | null> };
  try {
    tx = confirmation === 'finalized' ? await dispatchFinalized(contract, method, args) : await contract[method](...args);
  } catch (error) {
    observe({ status: isUserRejection(error) ? 'rejected' : 'failed', error: message(error) });
    throw error;
  }
  observe({ status: 'submitted', hash: tx.hash });
  observe({ status: 'confirming', hash: tx.hash });
  try {
    const receipt = await waitForTransaction(tx, contract, confirmation);
    observe({ status: 'confirmed', hash: receipt.hash ?? tx.hash });
    return receipt;
  } catch (error) {
    observe(settledFailure(error, tx.hash));
    throw error;
  }
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
  observe?: TxObserver,
  spaceId?: string,
): Promise<CreateAuctionResult> {
  const metadataHash = computeMetadataHash(metadata);
  const minBidWei = parseEther(minBidEth);

  const args = [metadataHash, minBidWei, BigInt(bidEndSec), BigInt(parkingStartSec), BigInt(parkingEndSec)];
  // Without a space id, createAuction registers a new space for this listing.
  const receipt = spaceId
    ? await send(contract, 'createSpaceAuction', [BigInt(spaceId), ...args], confirmation, observe)
    : await send(contract, 'createAuction', args, confirmation, observe);
  const tx = { hash: receipt.hash };

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
  observe?: TxObserver,
): Promise<TransactionReceipt> {
  return send(contract, 'bid', [BigInt(auctionId), { value: parseEther(bidAmountEth) }], confirmation, observe);
}

export async function withdrawRefund(contract: Contract, confirmation: ConfirmationPolicy = 'mined', observe?: TxObserver): Promise<TransactionReceipt> {
  return send(contract, 'withdrawRefund', [], confirmation, observe);
}

export async function settleAuction(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
  observe?: TxObserver,
): Promise<TransactionReceipt> {
  return send(contract, 'settle', [BigInt(auctionId)], confirmation, observe);
}

export async function cancelAuction(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
  observe?: TxObserver,
): Promise<TransactionReceipt> {
  return send(contract, 'cancel', [BigInt(auctionId)], confirmation, observe);
}

export async function claimPayout(
  contract: Contract,
  auctionId: string,
  confirmation: ConfirmationPolicy = 'mined',
  observe?: TxObserver,
): Promise<TransactionReceipt> {
  return send(contract, 'claimPayout', [BigInt(auctionId)], confirmation, observe);
}

const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  BidTooLow: 'Another bid reached or passed your amount first. Your input was kept; raise it above the new highest bid.',
  AuctionEnded: 'Bidding closed on-chain before your bid was mined.',
  AlreadySettled: 'This auction was already settled.',
  AlreadyCancelled: 'This auction was cancelled.',
  AuctionCancelledError: 'This auction was cancelled.',
  AuctionNotFound: 'This auction does not exist on the connected deployment.',
  OwnerCannotBid: 'Spot owners cannot bid on their own listing.',
  SpaceWindowTaken: 'This space already has a listing for an overlapping parking window. Pick a window that does not overlap, or cancel the other listing first.',
  NotSpaceOwner: 'Only the wallet that owns this parking space can list it.',
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
