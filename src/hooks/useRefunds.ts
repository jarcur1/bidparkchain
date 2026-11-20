import { useCallback, useRef, useState } from 'react';
import type { BrowserProvider, JsonRpcProvider } from 'ethers';
import { fetchBidAuctionIds, fetchPendingReturns, getContractInstance } from '../services/blockchain';
import type { Config, WalletState } from '../types';
import {
  LOADING_READ,
  READ_OK,
  READ_SKIPPED,
  READ_SUPERSEDED,
  readFailed,
  readFailure,
  readSucceeded,
  type ReadResult,
  type ReadState,
} from '../utils/readState';

interface RefundIdentity {
  address: string | null;
  chainId: number | null;
  provider: unknown;
  deployment: string | null;
}

interface RefundState {
  identity: RefundIdentity;
  wei: bigint | null;
  // Auctions this account bid on; null when the bid history could not be read.
  bidIds: Set<string> | null;
  read: ReadState;
}

const UNKNOWN_REFUND = { wei: null, bidIds: null, read: LOADING_READ };

const sameRefundIdentity = (a: RefundIdentity, b: RefundIdentity) =>
  a.address === b.address && a.chainId === b.chainId && a.provider === b.provider &&
  a.deployment === b.deployment;

interface UseRefundsOptions {
  walletState: WalletState;
  provider: JsonRpcProvider | BrowserProvider | null;
  config: Config | null;
  configDeployment: string | null;
}

export function useRefunds({ walletState, provider, config, configDeployment }: UseRefundsOptions) {
  // Activity & Refunds
  const [refundState, setRefundState] = useState<RefundState | null>(null);

  // Refund reads are scoped to account, chain, provider and contract; foreign values are never shown.
  const refundIdentity: RefundIdentity = {
    address: walletState.address,
    chainId: walletState.chainId,
    provider,
    deployment: configDeployment,
  };
  const refundIdentityRef = useRef(refundIdentity);
  refundIdentityRef.current = refundIdentity;
  const refundReqIdRef = useRef(0);
  const refund =
    refundState && sameRefundIdentity(refundState.identity, refundIdentity) ? refundState : UNKNOWN_REFUND;
  const claimableRefundWei = refund.wei;
  const refundRead = refund.read;
  const myBidAuctionIds = refund.bidIds;

  // Load pending returns from onchain contract
  const loadPendingRefunds = useCallback(async (): Promise<ReadResult> => {
    const identity: RefundIdentity = {
      address: walletState.address,
      chainId: walletState.chainId,
      provider,
      deployment: configDeployment,
    };
    const thisReqId = ++refundReqIdRef.current;
    const isCurrent = () =>
      thisReqId === refundReqIdRef.current && sameRefundIdentity(refundIdentityRef.current, identity);
    const fail = (err: unknown): ReadResult => {
      setRefundState((prev) => {
        const known = prev && sameRefundIdentity(prev.identity, identity) ? prev : null;
        return {
          identity, wei: known?.wei ?? null, bidIds: known?.bidIds ?? null,
          read: readFailed(known?.read ?? LOADING_READ, err),
        };
      });
      return readFailure(err);
    };
    if (!identity.address || !provider) return READ_SKIPPED;
    if (!walletState.isReady) return fail('Wallet is not connected to the supported network.');
    if (!config?.contractAddress) return fail('Contract configuration is unavailable.');
    try {
      const readContract = getContractInstance(config.contractAddress, config.abi, provider);
      // Bid history only explains the refund; failing to read it must not block a withdrawal.
      const [wei, bidIds] = await Promise.all([
        fetchPendingReturns(readContract, identity.address, config.confirmation),
        fetchBidAuctionIds(readContract, identity.address, config.deploymentBlock, config.confirmation).catch((err) => {
          console.warn('Failed to load bid history:', err);
          return null;
        }),
      ]);
      if (!isCurrent()) return READ_SUPERSEDED;
      setRefundState({ identity, wei, bidIds, read: readSucceeded(wei === 0n) });
      return READ_OK;
    } catch (err) {
      console.warn('Failed to load pending returns:', err);
      if (!isCurrent()) return READ_SUPERSEDED;
      return fail(err);
    }
  }, [config, configDeployment, walletState.address, walletState.chainId, walletState.isReady, provider]);

  return { refundRead, claimableRefundWei, myBidAuctionIds, loadPendingRefunds };
}
