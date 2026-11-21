# Listing search

`GET /api/listings/search` answers discovery queries with validated parameters, bounded work and one
consistent chain snapshot. `GET /api/listings` still returns the whole marketplace (and recovers
staged or unindexed auctions); the marketplace filters use search.

## Parameters

All are optional. Unknown, repeated (except `amenity`) or malformed parameters get **400**.

| Parameter | Meaning |
| --- | --- |
| `arrive`, `depart` | Visit in unix seconds. The parking window must cover the **whole** visit: `parkingStart <= arrive` and `depart <= parkingEnd`. A window ending exactly at `arrive` does not cover it; one ending exactly at `depart` does. With only one bound, that instant must be covered. `depart` must be after `arrive`. |
| `near` | `lat,lon` of the destination. Adds `distanceKm` to each listing. |
| `radiusKm` | Needs `near`. Above 0, at most 100. |
| `bbox` | `minLat,minLon,maxLat,maxLon` (does not cross the antimeridian). |
| `kind` | `garage`, `driveway` or `covered`. |
| `amenity` | Repeat for each required amenity (all must be present), at most 10. |
| `q` | Case-insensitive text in title, address, neighborhood, description or amenities, at most 100 characters. |
| `minPrice`, `maxPrice` | Budget in ETH, compared exactly in wei with the **current price**: the highest bid, or the opening bid when there is none. |
| `status` | `all` (default), `active`, `ending-soon` (open, under 30 min left), `ended`, `settled`. Judged against `chain.chainTime`. Cancelled auctions are only in `all`. |
| `sort` | `ending-soon` (default; open first), `starts-soon`, `price-asc`, `price-desc`, `newest`, `distance` (needs `near`). Ties break on auction id, so the order is total. |
| `limit` | Page size, 1 to 50, default 20. |
| `cursor` | `nextCursor` from the previous page of the same query. |

## Response

```json
{
  "listings": [ { "id": "3", "minBid": "0.01", "highestBid": "0.0", "distanceKm": 0.4, "...": "..." } ],
  "total": 12,
  "nextCursor": "eyJiIjo...",
  "chain": { "blockNumber": 42, "blockHash": "0x...", "blockTimestamp": 1767312000, "chainTime": 1767312005,
             "chainId": 31337, "contractAddress": "0x...", "deploymentBlock": 1, "deploymentBlockHash": "0x..." },
  "source": "index",
  "skipped": 0,
  "pricing": "minBid is the opening bid and highestBid the current highest bid. Neither is a final booking price: ..."
}
```

- **Price is not final.** `minBid` is the opening bid and `highestBid` the current one. Bids can rise
  until `bidEnd`; what a driver pays is only known when the auction settles.
- **One block per response.** Every contract read uses `eth_call` at `chain.blockHash` with
  `requireCanonical` (the index checkpoint when served from the index, otherwise the latest block locally
  and the finalized block on Sepolia), and the block is
  checked again before answering.
- **Pages share the first page's snapshot.** A cursor carries the block, chain time and offset, so
  later pages read the same block even while bids and new listings land: pages never overlap or
  skip. If that block is no longer canonical (a reorg or a reset chain) the cursor gets **409** and the
  search should start again. A cursor from a different query gets 400.
- `skipped` counts stored listing rows that are malformed. They are left out; they are not an outage.

## Limits and errors

| Status | When |
| --- | --- |
| 400 | Malformed query or cursor. Checked before any chain read, so it is returned even when the node is down. |
| 409 | The cursor's block is no longer canonical. |
| 422 | Only when reading the chain directly (`source: "chain"`): more than `BIDPARK_SEARCH_SCAN_LIMIT` (default 500) stored listings match the off-chain filters; narrow the area, time or filters. |
| 503 | The node is unreachable, a read failed, the chain reorganized during the read, or the search passed `BIDPARK_SEARCH_DEADLINE_MS` (default 20 s). |

Kind, amenities, area and text are filtered from stored metadata first. Each RPC call is bounded by
`BIDPARK_RPC_TIMEOUT_MS`.

## Served from the event index

`source` says how the answer was built.

- **`index`**: the visit, status, budget filters and the sort run on auction state projected from the event
  index (server/indexer.mjs). Creation parameters (opening bid, bid end, parking window, metadata hash) are
  read once per auction when it is indexed and stored on its `AuctionCreated` row (migration 14); the
  current bid, settled and cancelled come from the later canonical events. The response is pinned to the
  index checkpoint block, and the state used is the state at that block (events up to it), so a cursor
  page keeps reading the first page's block. Only the returned page is read from the chain (three
  `eth_call`s per listing at `chain.blockHash` with `requireCanonical`), and each listing must agree with
  the indexed state.
- **`chain`**: every candidate is read from the chain, as before. Used when:
  - the checkpoint is more than `BIDPARK_SEARCH_INDEX_MAX_LAG` blocks (default 50) behind the head, or
    there is no checkpoint yet. Within that lag, search first runs one indexer pass so the answer is at
    the head. A negative value turns index serving off;
  - `status` is `active` or `ending-soon` and the deployment requires verified inventory (the index has
    no verification state);
  - an indexed auction has no stored creation parameters yet (just after upgrading; the next pass fills
    them);
  - the page read from the chain disagrees with the index (logged as a warning).

A reorg is handled by the indexer: events above the last canonical block stop counting, so the projected
state follows them.

Measured on the `austin` seed (7 listings, 25 requests each, local Hardhat node): request RPC calls and
median latency were about the same (29 calls, about 170 to 200 ms either way), since every listing fits on
one page. With 200 more listings registered on top (207 matching), the default query went from 629 to 68
RPC calls and from 1315 ms to 282 ms median; `limit=5` from 629 to 23 calls and 1763 ms to 216 ms.

## `GET /api/listings` is bounded too

The full listing read scans auction ids, not stored rows, so staged and unindexed auctions (on chain, no
stored row yet) are still found and reported in `unindexed`.

- At most `BIDPARK_LISTINGS_SCAN_LIMIT` (default 500) auction ids are read per request. `limit`
  (1 to that value) lowers it.
- `nextCursor` is the first auction id not yet scanned, omitted when every id has been. Pass it back as
  `cursor` for the next page. A request with no parameters returns the first page, which is everything while
  there are no more auctions than the limit, so existing clients keep working. The web app follows the cursor
  (up to 20 pages per refresh).
- Each page is its own snapshot: `chain` names the block that page was read at. Unlike the search cursor it
  does not pin the block across pages.
- A malformed `limit`, `cursor` or unknown parameter is 400 before any chain read.

## Map area, location and time zones

- The marketplace map has a **Search this area** control: it sends the viewport as `bbox`
  (`minLat,minLon,maxLat,maxLon`) and a **Clear area** control removes it. The area is part of the shareable
  URL (`area=`).
- **Use my location** is optional and asks the browser only when pressed. The position is rounded to about
  100 m and is sent only as the `near` value of the search query. It is not stored and not put in the page URL.
  If permission is denied or unavailable, the destination field keeps working by hand.
- Cards show each space's own time zone with its parking times (the viewer's zone when none is set, and the
  card says so). The arrive/depart filter is in the browser's zone, as the filter hint states.

## Active filters

- Each filter in effect shows as a chip after the results count, worded as in the no-results note. A chip's button is named `Remove filter: …` and clears only its own filter. Focus moves to the chip that takes its place (or the last chip), or to the search field when none remain.
- **Clear all** appears with two or more chips and resets the filters to their defaults, as **Reset** does.
- A filter that is not applied has no chip: a reversed or invalid visit, an invalid budget, a destination that does not resolve, or a radius without a destination.
