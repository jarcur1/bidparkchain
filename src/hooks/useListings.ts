import { useCallback, useRef, useState } from 'react';
import { fetchListings } from '../services/api';
import type { ChainSnapshot, Listing, ListingsResponse, UnindexedAuction } from '../types';
import { deploymentKey, resetChainClock, syncChainClock } from '../utils/eligibility';
import { webProfile } from '../utils/networkProfile';
import {
  LOADING_READ,
  READ_OK,
  READ_SUPERSEDED,
  readFailed,
  readFailure,
  readSucceeded,
  type ReadResult,
  type ReadState,
} from '../utils/readState';

interface ListingsState {
  deployment: string | null;
  data: Listing[];
  unindexed: UnindexedAuction[];
  chain: ChainSnapshot | null;
  deploymentChanged: boolean;
  read: ReadState;
}

export type ListingsReadResult = ReadResult & { snapshot?: ListingsResponse };
export type LoadListings = (forBid?: boolean, forceFresh?: boolean) => Promise<ListingsReadResult>;

const EMPTY_LISTINGS: ListingsState = {
  deployment: null, data: [], unindexed: [], chain: null, deploymentChanged: false, read: LOADING_READ,
};

interface UseListingsOptions {
  // Deployment of the config the app currently shows; a read that finishes for another one is discarded.
  deploymentRef: { readonly current: string | null };
  configDeployment: string | null;
  onRefreshConfig: () => Promise<ReadResult>;
}

export function useListings({ deploymentRef, configDeployment, onRefreshConfig }: UseListingsOptions) {
  const [listingsState, setListingsState] = useState<ListingsState>(EMPTY_LISTINGS);
  const listingsView =
    configDeployment === null || listingsState.deployment === configDeployment ? listingsState : EMPTY_LISTINGS;
  const listings = listingsView.data;
  const chain = listingsView.deploymentChanged ? null : listingsView.chain;
  const calendarSnapshot = listingsView.read.status === 'success' ? chain : null;

  const listingsReqRef = useRef(0);
  const bidReadRef = useRef<{ deployment: string | null; promise: Promise<ListingsReadResult> } | null>(null);

  // Only the newest request for the current deployment may publish or re-anchor the clock.
  const readListings = useCallback(async (): Promise<ListingsReadResult> => {
    const reqId = ++listingsReqRef.current;
    const requestedDeployment = deploymentRef.current;
    const isSuperseded = () =>
      reqId !== listingsReqRef.current || requestedDeployment !== deploymentRef.current;
    const fail = (error: unknown, deploymentChanged = false) => {
      setListingsState((prev) => {
        const base = prev.deployment === requestedDeployment ? prev : EMPTY_LISTINGS;
        return {
          ...base,
          deployment: requestedDeployment,
          deploymentChanged: base.deploymentChanged || deploymentChanged,
          read: readFailed(base.read, error),
        };
      });
      return readFailure(error);
    };
    try {
      const snapshot = await fetchListings();
      if (isSuperseded()) return READ_SUPERSEDED;
      if (snapshot.chain && snapshot.chain.chainId !== undefined && snapshot.chain.chainId !== webProfile.chainId) {
        return fail('Listings are from a different network.');
      }
      if (webProfile.id === 'sepolia' && (!snapshot.chain || snapshot.chain.chainId !== webProfile.chainId)) {
        return fail('Listings did not include the expected network.');
      }
      const observedDeployment = snapshot.chain ? deploymentKey(snapshot.chain) : null;
      if (requestedDeployment !== null && observedDeployment !== requestedDeployment) {
        if (observedDeployment === null) return fail('Listings did not include the current deployment.');
        void onRefreshConfig();
        return fail('The listings deployment changed. Refresh the marketplace configuration.', true);
      }
      if (snapshot.chain) syncChainClock(snapshot.chain.chainTime);
      else resetChainClock();
      setListingsState({
        deployment: observedDeployment,
        data: snapshot.listings,
        unindexed: snapshot.unindexed ?? [],
        chain: snapshot.chain,
        deploymentChanged: false,
        read: readSucceeded(snapshot.listings.length === 0),
      });
      return { ...READ_OK, snapshot };
    } catch (err) {
      console.error('Failed to load listings:', err);
      if (isSuperseded()) return READ_SUPERSEDED;
      return fail(err);
    }
  }, [onRefreshConfig, deploymentRef]);

  // A refresh can share a bid's in-flight read, but cannot supersede it on the same deployment.
  const loadListings = useCallback((forBid = false, forceFresh = false): Promise<ListingsReadResult> => {
    const deployment = deploymentRef.current;
    const current = bidReadRef.current;
    if (!forceFresh && current?.deployment === deployment) return current.promise;
    const read = readListings();
    if (!forBid) return read;
    const promise = read.finally(() => {
      if (bidReadRef.current?.promise === promise) bidReadRef.current = null;
    });
    bidReadRef.current = { deployment, promise };
    return promise;
  }, [readListings, deploymentRef]);

  return { listingsView, listings, chain, calendarSnapshot, loadListings };
}
