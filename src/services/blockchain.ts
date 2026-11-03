import {
  Contract,
  Interface,
  JsonRpcProvider,
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

export async function fetchPendingReturns(
  contract: Contract,
  accountAddress: string
): Promise<bigint> {
  const balance = (await contract.pendingReturns(accountAddress)) as bigint;
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
  parkingEndSec: number
): Promise<CreateAuctionResult> {
  const metadataHash = computeMetadataHash(metadata);
  const minBidWei = parseEther(minBidEth);

  const tx = await contract.createAuction(
    metadataHash,
    minBidWei,
    BigInt(bidEndSec),
    BigInt(parkingStartSec),
    BigInt(parkingEndSec)
  );

  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) {
    throw new Error('Transaction was submitted but receipt was null');
  }

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
    throw new Error('AuctionCreated event not emitted in transaction receipt');
  }

  return { receipt, auctionId };
}

export async function placeBid(
  contract: Contract,
  auctionId: string,
  bidAmountEth: string
): Promise<TransactionReceipt> {
  const valueWei = parseEther(bidAmountEth);
  const tx = await contract.bid(BigInt(auctionId), { value: valueWei });
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) throw new Error('Bid transaction confirmed with null receipt');
  return receipt;
}

export async function withdrawRefund(contract: Contract): Promise<TransactionReceipt> {
  const tx = await contract.withdrawRefund();
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) throw new Error('Withdrawal confirmed with null receipt');
  return receipt;
}

export async function settleAuction(
  contract: Contract,
  auctionId: string
): Promise<TransactionReceipt> {
  const tx = await contract.settle(BigInt(auctionId));
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) throw new Error('Settlement confirmed with null receipt');
  return receipt;
}

export async function cancelAuction(
  contract: Contract,
  auctionId: string
): Promise<TransactionReceipt> {
  const tx = await contract.cancel(BigInt(auctionId));
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) throw new Error('Cancellation confirmed with null receipt');
  return receipt;
}

export async function claimPayout(
  contract: Contract,
  auctionId: string
): Promise<TransactionReceipt> {
  const tx = await contract.claimPayout(BigInt(auctionId));
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt) throw new Error('Payout claim confirmed with null receipt');
  return receipt;
}

export function parseContractError(err: unknown): string {
  if (!err) return 'Unknown error occurred';

  if (typeof err === 'object') {
    const errorObj = err as Record<string, unknown>;

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
