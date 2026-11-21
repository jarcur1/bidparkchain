import { useEffect, useMemo, useState } from 'react';
import type { BrowserProvider, JsonRpcProvider } from 'ethers';
import type { OwnedSpace } from '../components/CreateListingModal';
import { heldWindows } from '../components/HostWorkspace';
import { fetchHostSpaces, getContractInstance, type HostSpace } from '../services/blockchain';
import type { Config, Listing, WalletState } from '../types';
import { getChainNowSec } from '../utils/eligibility';

const NO_HOST_SPACES: HostSpace[] = [];

interface UseHostSpacesOptions {
  walletState: WalletState;
  provider: JsonRpcProvider | BrowserProvider | null;
  config: Config | null;
  configDeployment: string | null;
  listings: Listing[];
}

export function useHostSpaces({ walletState, provider, config, configDeployment, listings }: UseHostSpacesOptions) {
  // Spaces this wallet owns or may list on, read from the chain, reloaded after each space action.
  const [spacesNonce, setSpacesNonce] = useState(0);
  const [hostSpacesState, setHostSpacesState] = useState<{ key: string; spaces: HostSpace[]; error: string | null }>({ key: '', spaces: [], error: null });
  const hostSpacesKey = walletState.address && configDeployment && walletState.isReady ? `${walletState.address}|${configDeployment}` : '';
  useEffect(() => {
    if (!hostSpacesKey || !provider || !config?.contractAddress) return;
    let live = true;
    const contract = getContractInstance(config.contractAddress, config.abi, provider);
    fetchHostSpaces(contract, walletState.address as string, config.deploymentBlock, config.confirmation).then(
      (spaces) => { if (live) setHostSpacesState({ key: hostSpacesKey, spaces, error: null }); },
      (err) => { if (live) setHostSpacesState({ key: hostSpacesKey, spaces: [], error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [hostSpacesKey, spacesNonce, provider, config, walletState.address]);
  const hostSpaces = hostSpacesState.key === hostSpacesKey ? hostSpacesState.spaces : NO_HOST_SPACES;

  // The wallet's spaces and the windows each still holds, mirroring the contract's holdsWindow rule.
  const ownedNowSec = getChainNowSec();
  const ownedSpaces = useMemo<OwnedSpace[]>(() => {
    if (!walletState.address) return [];
    const now = ownedNowSec;
    const addr = walletState.address.toLowerCase();
    const spaces = new Map<string, OwnedSpace>();
    for (const l of listings) {
      if (l.owner.toLowerCase() === addr && !spaces.has(l.spaceId)) spaces.set(l.spaceId, { id: l.spaceId, title: l.title, held: [] });
    }
    for (const h of hostSpaces) {
      if (!spaces.has(h.id)) {
        const latest = listings.find((l) => l.spaceId === h.id);
        spaces.set(h.id, { id: h.id, title: latest?.title ?? 'No listings yet', held: [], lister: h.isLister });
      }
    }
    for (const space of spaces.values()) {
      space.title = listings.find((l) => l.spaceId === space.id)?.title ?? space.title;
      space.held = heldWindows(listings, space.id, now);
      const chainSpace = hostSpaces.find((h) => h.id === space.id);
      space.timeZone = chainSpace?.timeZone ?? '';
      space.blocked = chainSpace?.blocked ?? [];
    }
    return [...spaces.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }, [listings, hostSpaces, walletState.address, ownedNowSec]);

  return { hostSpacesKey, hostSpacesState, hostSpaces, ownedSpaces, setSpacesNonce };
}
