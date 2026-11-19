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
  "skipped": 0,
  "pricing": "minBid is the opening bid and highestBid the current highest bid. Neither is a final booking price: ..."
}
```

- **Price is not final.** `minBid` is the opening bid and `highestBid` the current one. Bids can rise
  until `bidEnd`; what a driver pays is only known when the auction settles.
- **One block per response.** Every contract read uses `eth_call` at `chain.blockHash` with
  `requireCanonical` (the latest block locally, the finalized block on Sepolia), and the block is
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
| 422 | More than `BIDPARK_SEARCH_SCAN_LIMIT` (default 500) stored listings match the off-chain filters; narrow the area, time or filters. |
| 503 | The node is unreachable, a read failed, the chain reorganized during the read, or the search passed `BIDPARK_SEARCH_DEADLINE_MS` (default 20 s). |

Kind, amenities, area and text are filtered from stored metadata first; only those candidates are
read from the chain (two calls each, 16 at a time), and each RPC call is bounded by
`BIDPARK_RPC_TIMEOUT_MS`.
