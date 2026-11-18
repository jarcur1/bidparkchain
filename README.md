# BidPark

A local parking-auction marketplace with actual Ethereum smart-contract escrow. Browse demonstration private parking spaces in Austin, bid for a time window, withdraw outbid funds, and settle the auction into an on-chain reservation.

**Local development only. Test ETH has no monetary value. The sample parking spaces are not available for real booking. Never send real funds to the development accounts.**

## Run

Requires **Node.js 24 LTS** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The launcher starts the local Hardhat chain (31337), compiles Solidity using the installed solc package, deploys and seeds seven auctions, starts the SQLite-backed API, and starts Vite. No wallet extension, RPC subscription, or hosted database is required. Stop all three services with Ctrl+C.

Ports 5173, 3001, and 8545 must be available. Services bind to loopback; this is not a deployment configuration.

## Try it

- Browse the cards and map; search by location and filter parking types.
- Open the wallet control and explicitly select a **local test wallet**. These use Hardhat's publicly known development accounts. Account 0 owns the seeded listings; account 1 has two seeded example bids. Switch buyer accounts to exercise outbidding.
- Open a spot to inspect its reservation window and auction closing time, then submit a full bid in local ETH. Wait for the transaction confirmation.
- Use **My activity** to see leading bids and reservations, withdraw refundable outbid amounts, and settle a closed auction. The highest bidder wins; settlement is permissionless.
- Create a new listing with public metadata and a future auction/reservation window. Creating the on-chain auction and registering its hash-matched metadata are separate operations.
- If the auction confirms but metadata registration fails, keep the tab open and use **Complete Registration** to retry the same auction without deploying another one. The committed metadata is read-only during recovery. This recovery state is held in the current browser session; reloading the page discards it.
- As the owner, cancel an unbid listing or claim its escrow after settlement and the end of the parking window.

An injected Ethereum wallet is also supported on local chain **31337**. If adding it manually, use RPC **http://127.0.0.1:8545**, currency **ETH**. Use a disposable wallet; the built-in local test option is simpler.

### Escrow rules

- A bid must meet the opening price and exceed the current highest bid. Owners cannot bid on their own auctions.
- Each transaction sends the **entire new bid**, not a top-up. A displaced bid—including your own previous bid when raising it—becomes a withdrawable refund.
- Owners cannot cancel an auction after any bid. The current winner cannot withdraw their winning bid.
- Bid eligibility (open, not cancelled or settled, not the owner) is one rule shared by cards, the detail view, map popups and the bid dialog. It is judged against **chain time**, not the browser clock: `GET /api/listings` returns a `chain` object (deployment identity plus the latest block timestamp and a `chainTime` lower bound for the next block), and the browser advances that value with its monotonic clock between polls.
- An open bid dialog is bound to the listing's deployment, auction id and metadata hash, not a snapshot. Price, owner and eligibility refresh with every poll while the amount you typed is kept. If the deployment or committed metadata changes, or the listing disappears, the dialog closes. Before the wallet is asked to sign, the bid is revalidated against freshly read chain state; a competing bid, cutoff, cancellation or settlement is reported with your input retained and no transaction sent.
- Bidding ends at the contract's `bidEnd` timestamp. The winner is confirmed by calling `settle` after that deadline.
- Seller payout is available only after settlement and `parkingEnd`, and can be claimed once.
- There is **no automatic refund or dispute process for an inaccessible space**. Time-locked escrow does not prove physical access or delivery.

## Verify

With `npm run dev` running:

```sh
npm run build
npm run smoke
```

`npm test` runs the Vitest component regressions (competing bid, closure during edit, owner/deployment change, shared card/map eligibility) under jsdom; it needs no running services.

`build` runs strict TypeScript checking and a Vite production build. `smoke` deploys a separate contract and exercises the live auction, outbid/refund, same-bidder rebid, settlement, payout, cancellation, authorization, and time-boundary paths. It snapshots and restores the local chain, including its clock. **Do not submit app transactions while the smoke script runs**: snapshot restoration also reverts any concurrent transactions.

## Components

| Path | Purpose |
| --- | --- |
| `src/` | React/TypeScript interface, Leaflet map, ethers wallet integration |
| `contracts/ParkingAuctionEscrow.sol` | Auctions, pull refunds, settlement, time-locked owner payout |
| `server/` | Express API and Node's native SQLite metadata storage |
| `shared/` | Shared types and canonical metadata normalization |
| `scripts/deploy.mjs` | Local Solidity compilation, deployment, seeded listings |
| `scripts/dev.mjs` | Cross-platform local service launcher |
| `scripts/smoke.mjs` | Live-chain escrow lifecycle checks |

### Data and restarts

SQLite metadata and the deployment descriptor live under gitignored `data/`. Metadata is hash-bound to each auction on-chain; a registration with mismatched metadata is rejected. No privileged HTTP endpoint can alter auction ownership or bids.

The local Hardhat chain is **in memory**. Stopping and restarting it resets auctions, balances, and reservations. A fresh deployment clears metadata from the prior chain session and recreates the seven samples. SQLite persistence supports API restarts while the same chain remains running; it does not make blockchain state persistent.

For separate service terminals, run `npm run chain`, then `npm run deploy`, then `npm run api` and `npm run web`. Re-running deployment against the same active chain reuses the deployment.

## Boundaries before real use

This is a functional local prototype, **not an audited or production-ready payment system**. It does not verify listing ownership, availability, identities, municipal permission, gate access, or parking delivery. It has no fiat payments, dispute resolution, cancellation policy after bidding, or production authentication/operations. A wallet address is not proof of property ownership.

All listing fields are public. Do not enter gate codes, personal information, or private access instructions. Contract storage also publicly exposes wallet addresses, bid amounts, and auction times. The public test mnemonic is deliberately for local use only.

OpenStreetMap tiles and listing photography require an internet connection; the auction list and local chain do not depend on those image services. Map data © OpenStreetMap contributors. Sample photographs are illustrative, not verification of a listed property.
