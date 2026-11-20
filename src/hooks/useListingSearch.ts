import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, searchListings, searchListingsPages } from '../services/api';
import { deploymentKey, getChainNowSec } from '../utils/eligibility';
import {
  MY_LOCATION_LABEL,
  type Place,
  destinationOptions,
  discoverListings,
  filtersFromSearch,
  filtersToSearch,
  resolveDestination,
  searchQuery,
} from '../utils/discovery';
import type { FilterState, Listing, SearchListing } from '../types';

interface UseListingSearchOptions {
  listings: Listing[];
  snapshotBlock: number | undefined;
  listingsDeployment: string | null;
}

export function useListingSearch({ listings, snapshotBlock, listingsDeployment }: UseListingSearchOptions) {
  const [filters, setFilters] = useState<FilterState>(() => filtersFromSearch(window.location.search));
  // Keep the URL in step with the filters so a reload or shared link restores them.
  useEffect(() => {
    const search = filtersToSearch(filters, window.location.search);
    if (search !== window.location.search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
    }
  }, [filters]);

  // Filter & Sort Logic
  // Optional browser location: asked only when the driver presses the button, rounded, kept in memory
  // and used only as the `near` value of the search query.
  const [myLocation, setMyLocation] = useState<Place | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);
  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationMessage('This browser cannot share a location. Type a destination instead.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocationMessage(null);
        setMyLocation({ label: MY_LOCATION_LABEL, latitude: Math.round(pos.coords.latitude * 1000) / 1000, longitude: Math.round(pos.coords.longitude * 1000) / 1000 });
        setFilters((f) => ({ ...f, destination: MY_LOCATION_LABEL }));
      },
      () => {
        setLocating(false);
        setLocationMessage('Location not shared. Type a destination or pick a landmark instead.');
      },
      { maximumAge: 60_000, timeout: 15_000 },
    );
  }, []);
  const destinationChoices = useMemo(
    () => (myLocation ? [myLocation, ...destinationOptions(listings)] : destinationOptions(listings)),
    [listings, myLocation],
  );
  const destination = resolveDestination(filters.destination, destinationChoices);
  const { listings: filteredListings, distances } = useMemo(
    () => discoverListings(listings, filters, getChainNowSec(), destination),
    [listings, filters, destination]
  );

  // The server answers the same filters with bounded, block-pinned pages. Until its answer for the
  // current query and deployment arrives (or if it fails, with a notice), the loaded snapshot is filtered locally.
  const searchKey = searchQuery(filters, destination);
  const [serverSearch, setServerSearch] = useState<{
    key: string; deployment: string | null; listings: SearchListing[]; total: number; nextCursor: string | null; loadingMore: boolean;
    /** Pages loaded, so a listings refresh can reload as many. */
    pages: number;
    /** Why the last cursor request failed; the pages already shown stay. */
    pageError: string | null;
  } | null>(null);
  const serverSearchRef = useRef(serverSearch);
  serverSearchRef.current = serverSearch;
  const [searchNonce, setSearchNonce] = useState(0);
  // The query and deployment of the last search that failed. An accepted answer or a new query clears it.
  const [searchFailure, setSearchFailure] = useState<{ key: string; deployment: string | null; error: string } | null>(null);
  useEffect(() => { setSearchFailure(null); }, [searchKey, listingsDeployment]);
  useEffect(() => {
    if (snapshotBlock === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      // A refresh of the same search reloads the pages already shown, from the new head.
      const prev = serverSearchRef.current;
      const keep = prev && prev.key === searchKey && prev.deployment === listingsDeployment ? prev.pages : 1;
      searchListingsPages(searchKey, keep)
        .then((r) => {
          if (!live) return;
          const deployment = r.chain ? deploymentKey(r.chain) : null;
          if (deployment !== listingsDeployment) { setServerSearch(null); return; }
          setSearchFailure(null);
          setServerSearch({
            key: searchKey, deployment, listings: r.listings, total: r.total, nextCursor: r.nextCursor, loadingMore: false,
            pages: r.pagesLoaded, pageError: r.pageError ? r.pageError.message : null,
          });
        })
        .catch((err: unknown) => {
          if (!live) return;
          setServerSearch(null);
          setSearchFailure({ key: searchKey, deployment: listingsDeployment, error: err instanceof Error ? err.message : String(err) });
        });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [searchKey, snapshotBlock, listingsDeployment, searchNonce]);
  const serverResult = serverSearch?.key === searchKey && serverSearch.deployment === listingsDeployment ? serverSearch : null;
  const searchNotice = searchFailure?.key === searchKey && searchFailure.deployment === listingsDeployment ? searchFailure : null;
  const shownListings: Listing[] = serverResult ? serverResult.listings : filteredListings;
  const shownDistances = useMemo(
    () => serverResult
      ? new Map(serverResult.listings.flatMap((l) => (l.distanceKm === undefined ? [] : [[l.id, l.distanceKm] as const])))
      : distances,
    [serverResult, distances]
  );
  const loadMoreResults = useCallback(async () => {
    const current = serverSearch;
    if (!current?.nextCursor || current.loadingMore) return;
    setServerSearch({ ...current, loadingMore: true, pageError: null });
    try {
      const page = await searchListings(current.key, current.nextCursor);
      setServerSearch((s) => s?.key === current.key && s.nextCursor === current.nextCursor
        ? { ...s, listings: [...s.listings, ...page.listings], nextCursor: page.nextCursor, loadingMore: false, pages: s.pages + 1, pageError: null }
        : s);
    } catch (err) {
      // A cursor whose block was replaced starts the search again from the first page.
      const replaced = err instanceof ApiError && err.status === 409;
      if (replaced) setSearchNonce((n) => n + 1);
      const message = err instanceof Error ? err.message : String(err);
      setServerSearch((s) => (s === null ? s : { ...s, loadingMore: false, pageError: replaced ? null : message }));
    }
  }, [serverSearch]);

  return {
    filters, setFilters, useMyLocation, locating, locationMessage, destinationChoices, destination,
    filteredListings, shownListings, shownDistances, serverResult, searchNotice, setSearchNonce, loadMoreResults,
  };
}
