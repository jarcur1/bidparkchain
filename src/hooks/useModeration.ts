import { useCallback, useMemo, type RefObject } from 'react';
import type { VerificationState } from '../components/Verification';
import type { SessionContextValue } from '../context/SessionContext';
import type { WalletContextValue } from '../context/WalletContext';
import {
  fetchSpaceAttestation,
  getContractInstance,
  parseContractError,
  sendSpaceAttestation,
  TransactionOutcomeUnknown,
  type SpaceAttestation,
  type TxObserver,
} from '../services/blockchain';
import type { Config, Listing, ListingsResponse, WalletState } from '../types';
import type { LoadListings } from './useListings';
import type { TrackFn } from './useTransactions';

interface UseModerationOptions {
  walletState: WalletState;
  signer: WalletContextValue['signer'];
  isCurrentSigner: WalletContextValue['isCurrentSigner'];
  wrongChain: boolean;
  provider: WalletContextValue['provider'];
  session: SessionContextValue['session'];
  verification: VerificationState;
  config: Config | null;
  configDeployment: string | null;
  deploymentRef: RefObject<string | null>;
  isActionBusy: boolean;
  setIsActionBusy: (busy: boolean) => void;
  hostSpacesKey: string | null;
  preflightWrite: (listing?: Listing) => Promise<ListingsResponse | undefined>;
  track: TrackFn;
  loadListings: LoadListings;
}

export function useModeration({
  walletState,
  signer,
  isCurrentSigner,
  wrongChain,
  provider,
  session,
  verification,
  config,
  configDeployment,
  deploymentRef,
  isActionBusy,
  setIsActionBusy,
  hostSpacesKey,
  preflightWrite,
  track,
  loadListings,
}: UseModerationOptions) {
  const moderationContract = useMemo(
    () => provider && config && hostSpacesKey ? getContractInstance(config.contractAddress, config.abi, provider) : null,
    [provider, config, hostSpacesKey],
  );
  const readInventoryMode = useCallback(async (): Promise<boolean> => {
    if (!moderationContract || !config) throw new Error('The marketplace deployment is unavailable.');
    return moderationContract.verifiedInventoryRequired({ blockTag: config.confirmation === 'finalized' ? 'finalized' : 'latest' });
  }, [moderationContract, config]);
  const readModerationInventory = useCallback(async (spaceId: string) => {
    if (!moderationContract || !config || !session) throw new Error('Sign in to check on-chain verification.');
    return fetchSpaceAttestation(moderationContract, spaceId, session.address, config.confirmation);
  }, [moderationContract, config, session]);

  async function handleAttestation(decision: SpaceAttestation, observe: TxObserver) {
    if (!signer || !walletState.isReady || wrongChain || !session || !verification.moderator || !config || !configDeployment || isActionBusy) {
      throw new Error('Connect an authorized reviewer wallet before signing.');
    }
    setIsActionBusy(true);
    try {
      await preflightWrite();
      if (!await readInventoryMode()) throw new Error('This deployment does not enforce verified inventory.');
      const current = await readModerationInventory(decision.spaceId);
      const block = await provider?.getBlock(config.deploymentBlock);
      if (!block?.hash || block.hash.toLowerCase() !== config.deploymentBlockHash.toLowerCase()) {
        throw new Error('The wallet RPC is not serving the reviewed deployment. No transaction was sent.');
      }
      const response = await fetch(`/api/moderation/verifications/${encodeURIComponent(decision.spaceId)}/attestation`);
      if (!response.ok) throw new Error('Could not confirm the current moderation decision. No transaction was sent.');
      const review = await response.json() as { contractAddress: string; reviewer: string; host: string; epoch: string | null; action: string | null };
      const action = /^0x0{64}$/i.test(decision.metadataHash) ? 'revoke' : 'approve';
      if (review.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase() || review.action !== action ||
          review.reviewer.toLowerCase() !== session.address.toLowerCase() ||
          review.host.toLowerCase() !== current.owner.toLowerCase() ||
          (action === 'approve' && review.epoch !== current.epoch)) {
        throw new Error('The review does not match this action or ownership period. Refresh the queue or request new proof.');
      }
      if (!isCurrentSigner(signer) || deploymentRef.current !== configDeployment) {
        throw new Error('The active wallet or deployment changed. No transaction was sent.');
      }
      if (!current.canVerify || current.owner.toLowerCase() !== decision.owner.toLowerCase() || current.epoch !== decision.epoch) {
        throw new Error('The verifier role or space ownership changed. Check on-chain verification before signing.');
      }
      const label = `Attest verification for space #${decision.spaceId}`;
      const tracked = track('space', label).observe;
      const contract = getContractInstance(config.contractAddress, config.abi, signer);
      await sendSpaceAttestation(contract, decision, config.confirmation, (update) => {
        tracked?.(update);
        observe(update);
      });
      void loadListings();
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) throw err;
      throw new Error(parseContractError(err, config.abi), { cause: err });
    } finally {
      setIsActionBusy(false);
    }
  }

  return { readInventoryMode, readModerationInventory, handleAttestation };
}
