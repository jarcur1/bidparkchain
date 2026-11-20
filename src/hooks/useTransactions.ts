import { useEffect, useMemo, useRef, useState } from 'react';
import { Interface, type BrowserProvider, type JsonRpcProvider } from 'ethers';
import type { TxObserver } from '../services/blockchain';
import { linkReplacement } from '../services/workspace';
import type { Config, DeploymentIdentity, Listing } from '../types';
import { patchTransaction, readTransactions, recordTransaction, staleTransactionsFor, transactionsFor, type TxKind, type TxRecord } from '../utils/txStore';
import type { AddToast } from './useToasts';

interface UseTransactionsOptions {
  account: string | null;
  config: Config | null;
  configDeployment: string | null;
  provider: JsonRpcProvider | BrowserProvider | null;
  listings: Listing[];
  addToast: AddToast;
}

export type TrackFn = (kind: TxKind, label: string, extra?: Partial<TxRecord>) => { id: string | null; observe?: TxObserver };

export function useTransactions({ account, config, configDeployment, provider, listings, addToast }: UseTransactionsOptions) {
  const [txVersion, setTxVersion] = useState(0);
  const sessionTxIds = useRef(new Set<string>());
  const txScope = useMemo(() => account && config && configDeployment
    ? { account, chainId: config.chainId, contract: config.contractAddress, deployment: configDeployment }
    : null, [account, config, configDeployment]);
  const track = (kind: TxKind, label: string, extra: Partial<TxRecord> = {}): { id: string | null; observe?: TxObserver } => {
    if (!txScope) return { id: null };
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionTxIds.current.add(id);
    recordTransaction({ id, kind, label, status: 'awaiting-wallet', scope: txScope, ...extra });
    setTxVersion((v) => v + 1);
    return { id, observe: (update) => { patchTransaction(id, update); setTxVersion((v) => v + 1); } };
  };
  const txRecords = txScope ? transactionsFor(txScope) : [];
  const staleTxCount = txScope ? staleTransactionsFor(txScope).length : 0;
  void txVersion; // re-read the store whenever a transaction changes

  // After a reload or reconnect, re-check transactions that were still in flight and pick up listings
  // the API already recovered from staged metadata. This only reads the chain; nothing is re-sent.
  useEffect(() => {
    if (!txScope || !provider || !config) return;
    let live = true;
    const iface = new Interface(config.abi);
    (async () => {
      for (const r of transactionsFor(txScope)) {
        if (!live) return;
        if (r.status === 'awaiting-wallet' && !sessionTxIds.current.has(r.id)) {
          patchTransaction(r.id, { status: 'unknown', error: 'The page reloaded before the wallet answered. Check your wallet activity.' });
        } else if ((r.status === 'submitted' || r.status === 'confirming') && r.hash && !sessionTxIds.current.has(r.id)) {
          const receipt = await provider.getTransactionReceipt(r.hash).catch(() => null);
          if (receipt && config.confirmation === 'finalized') {
            const finalized = await provider.getBlock('finalized').catch(() => null);
            if (!finalized || receipt.blockNumber > finalized.number) continue;
          }
          if (receipt) {
            let auctionId = r.auctionId;
            for (const log of r.kind === 'create' && !auctionId ? receipt.logs : []) {
              try {
                const parsed = iface.parseLog(log);
                if (parsed?.name === 'AuctionCreated') auctionId = parsed.args[0].toString();
              } catch { /* another contract's log */ }
            }
            patchTransaction(r.id, {
              status: receipt.status === 1 ? 'confirmed' : 'reverted',
              ...(r.kind === 'create' && auctionId ? { auctionId, registered: false } : {}),
            });
          } else if (!(await provider.getTransaction(r.hash).catch(() => null))) {
            patchTransaction(r.id, { status: 'unknown', error: 'The network no longer knows this transaction; it may have been replaced or dropped.' });
          }
        }
        const current = readTransactions().find((x) => x.id === r.id);
        if (current?.kind === 'create' && current.auctionId && !current.registered && listings.some((l) => l.id === current.auctionId)) {
          patchTransaction(r.id, { registered: true });
        }
      }
      if (live) setTxVersion((v) => v + 1);
    })();
    return () => { live = false; };
  }, [txScope, provider, config, listings]);

  const markRegistered = (auctionId: string) => {
    for (const r of readTransactions()) {
      if (r.kind === 'create' && r.auctionId === auctionId && !r.registered) patchTransaction(r.id, { registered: true });
    }
    setTxVersion((v) => v + 1);
  };

  // Links a replacement to the auction it replaces. A failure leaves `linked` unset on the create record,
  // so My Activity → Transactions can retry it after a reload.
  const linkReplacementRecord = async (recordId: string | null, replaces: string, auctionId: string, deployment: DeploymentIdentity) => {
    try {
      await linkReplacement(replaces, auctionId, deployment);
      if (recordId) patchTransaction(recordId, { linked: true });
      addToast('success', 'Replacement linked', `Bidders on auction #${replaces} will see a pointer to auction #${auctionId} in their inbox.`);
    } catch (linkErr) {
      addToast('error', 'Replacement not linked', `${linkErr instanceof Error ? linkErr.message : String(linkErr)}. Retry from My Activity → Transactions.`);
    } finally {
      setTxVersion((v) => v + 1);
    }
  };

  return { txScope, track, txRecords, staleTxCount, markRegistered, linkReplacementRecord };
}
