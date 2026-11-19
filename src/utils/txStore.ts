import type { TxStatus, TxUpdate } from '../services/blockchain';
import type { SpotMetadata } from '../types';

/** Who and where a transaction belongs to. Recovery only ever happens within the same scope. */
export interface TxScope {
  account: string;
  chainId: number;
  contract: string;
  /** Deployment identity (chain, contract, deployment block and hash); changes when a chain is reset. */
  deployment: string;
}

export type TxKind = 'create' | 'bid' | 'withdraw' | 'settle' | 'cancel' | 'claim' | 'space';

export interface TxRecord {
  id: string;
  kind: TxKind;
  label: string;
  status: TxStatus;
  scope: TxScope;
  hash?: string;
  replacementHash?: string;
  error?: string;
  auctionId?: string;
  /** Exact metadata committed by a create transaction; frozen once the transaction is submitted. */
  metadata?: SpotMetadata;
  /** For creates: whether the listing details are registered with the API. */
  registered?: boolean;
  createdAt: number;
  updatedAt: number;
}

const KEY = 'bidpark_transactions_v1';
const LIMIT = 50;
/** Statuses after which the transaction can no longer change. */
export const FINAL_STATUSES: ReadonlySet<TxStatus> = new Set(['confirmed', 'rejected', 'failed', 'reverted', 'replaced', 'cancelled']);

// Storage can be unavailable (private mode, blocked); the center then just lives for this page.
let memory: TxRecord[] = [];
export function readTransactions(): TxRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    memory = raw ? (JSON.parse(raw) as TxRecord[]) : memory;
  } catch { /* fall back to memory */ }
  return memory;
}
function write(records: TxRecord[]) {
  memory = records.slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* memory only */ }
}

export function recordTransaction(record: Omit<TxRecord, 'createdAt' | 'updatedAt'>): TxRecord {
  const now = Date.now();
  const full = { ...record, createdAt: now, updatedAt: now };
  write([...readTransactions().filter((r) => r.id !== record.id), full]);
  return full;
}

/** Applies a status update or field patch. Committed metadata never changes after submission. */
export function patchTransaction(id: string, patch: Partial<Pick<TxRecord, 'auctionId' | 'registered' | 'metadata'>> & Partial<TxUpdate>): TxRecord | null {
  let updated: TxRecord | null = null;
  write(readTransactions().map((r) => {
    if (r.id !== id) return r;
    const { metadata, ...rest } = patch;
    updated = { ...r, ...rest, ...(metadata && !r.hash ? { metadata } : {}), updatedAt: Date.now() };
    return updated;
  }));
  return updated;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameWallet = (r: TxRecord, scope: TxScope) =>
  same(r.scope.account, scope.account) && r.scope.chainId === scope.chainId && same(r.scope.contract, scope.contract);

/** Transactions of this account on this deployment, newest first. */
export function transactionsFor(scope: TxScope): TxRecord[] {
  return readTransactions().filter((r) => sameWallet(r, scope) && r.scope.deployment === scope.deployment).reverse();
}

/** This account's transactions from an earlier, reset deployment: shown, but never resumed. */
export function staleTransactionsFor(scope: TxScope): TxRecord[] {
  return readTransactions().filter((r) => sameWallet(r, scope) && r.scope.deployment !== scope.deployment).reverse();
}
