# BidPark

A parking-auction prototype with Ethereum smart-contract escrow. Browse demonstration private parking spaces in Austin, bid for a time window, withdraw outbid funds, and settle the auction into an on-chain reservation.

**Local by default. The optional Sepolia profile is for test ETH and illustrative rehearsals only. The sample parking spaces are not available for real booking. Never send real funds.**

## Run

Requires **Node.js 24 LTS** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The launcher starts the local Hardhat chain (31337), compiles Solidity using the installed solc package, deploys and seeds seven auctions, starts the SQLite-backed API, and starts Vite. No wallet extension, RPC subscription, or hosted database is required. Stop all three services with Ctrl+C.

For the class demo, set `BIDPARK_SCENARIO=campus-baseline` or `campus-expansion` to seed a fictional campus instead of the Austin samples; see [class demo scenarios](docs/class-demo-scenarios.md).

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

Tests do not need `npm run dev` and never touch its chain, API, web server, or `data/`. Suites that need services start their own on free loopback ports with temporary data and clean them up.

```sh
npm run build            # strict TypeScript check and production build
npm test                 # UI, contracts, API, and seed recovery
npm run test:ui          # jsdom component tests
npm run test:contracts   # escrow contract suite on an owned chain
npm run test:api         # API, metadata, and deploy/seed integration
npx playwright install chromium   # once
npm run test:e2e         # browser host/driver journey on an owned stack
```

CI (`.github/workflows/ci.yml`) runs all of the above on every pull request using `npm ci`.

`npm run health` is a separate, read-only check for a shared or public-testnet deployment: chain id, contract code, latest-block age, and API identity. It only issues read RPC methods. Configure it with `HEALTH_RPC_URL`, `HEALTH_CHAIN_ID`, `HEALTH_CONTRACT_ADDRESS`, and optionally `HEALTH_API_URL` / `HEALTH_MAX_BLOCK_AGE`; the **Deployment health** workflow runs it on demand.

### Read status

Configuration, listings, the claimable-refund read and the wallet balance each track their own state: loading, success, empty (a successful read with nothing in it), failed (nothing known), or stale (the last read failed but the previous value is kept, labeled with the last successful read time). Unknown refund or wallet balances are shown as unavailable, never as zero, and withdrawals and bids are only enabled from a successful current read. Each failed source has its own retry button, and manual refresh re-reads configuration too and reports exactly which sources updated. Switching account, chain, provider or deployment immediately hides values read for the previous identity and ignores late responses from it.

If a listings response belongs to a different deployment, the interface keeps any previous listings marked stale, closes their dialogs, and refreshes configuration. Bid preflight will not sign if the wallet changes while the fresh listing is being read.

`npm run test:ui` covers competing bids, closure during editing, wallet and deployment changes, and agreement between cards and map popups.

The UI suite also exercises native keyboard controls and the shared dialog, including focus restoration, stacked dialogs, Escape, and busy close guards.

### Keyboard use

Use **Connect Wallet** to choose an account with Enter or Space, **List a Spot** to open the form, and **Details** or **Bid Now** on a card to act without using the map. The listing review moves focus to the public preview before confirmation; **Edit listing** returns focus to the form. Dismissing the form keeps the draft but requires a fresh review. Dialogs contain Tab navigation and make the background inert. Escape closes only the topmost dialog and is ignored while it is submitting. Closing a dialog returns focus to its opener when possible. The layout reflows on narrow screens and respects `prefers-reduced-motion`.

## Components

| Path | Purpose |
| --- | --- |
| `src/` | React/TypeScript interface, Leaflet map, ethers wallet integration |
| `contracts/ParkingAuctionEscrow.sol` | Auctions, pull refunds, settlement, time-locked owner payout |
| `server/` | Express API and Node's native SQLite metadata storage |
| `shared/` | Shared types and canonical metadata normalization |
| `scripts/deploy.mjs` | Local Solidity compilation, deployment, seeded listings |
| `scripts/dev.mjs` | Cross-platform local service launcher |
| `tests/` | Isolated suites; `tests/support/` owns disposable chains, services, and temp data |
| `scripts/health.mjs` | Read-only health check for shared deployments |

### Data and restarts

SQLite metadata and the deployment descriptor live under gitignored `data/`. Metadata is hash-bound to each auction on-chain; a registration with mismatched metadata is rejected. No privileged HTTP endpoint can alter auction ownership or bids.

Listing records are keyed by chain id, contract address and auction id, and keep the exact canonical JSON that hashes to the on-chain `metadataHash`. The schema is versioned (`PRAGMA user_version`), and older databases are migrated in place on startup without losing rows. Every deployment the API serves is recorded and never deleted. Before signing the create transaction, the app stages its metadata with `POST /api/listings/stage`. If registration is lost after that, the API recovers the listing from the new auction's hash. Any on-chain auction with no matching metadata is returned under `unindexed` in `GET /api/listings` and noted in the marketplace, rather than silently hidden. The API also runs a background event indexer (every 5 s; `BIDPARK_INDEX_INTERVAL_MS`, 0 disables it). It records every auction event with its block and transaction, follows the profile's confirmation policy, and handles reorgs by orphaning replaced events. Index freshness is at `GET /api/index`, and an auction's public history at `GET /api/auctions/:id/events`. Back up the database with `npm run backup` and restore with `npm run backup -- restore <backup> <empty-dir>`; see [backups, restore and migrations](docs/operations-backup.md).

The local Hardhat chain is **in memory**. Stopping and restarting it resets auctions, balances, and reservations. A fresh local deployment explicitly resets that local chain's listings, keeping deployment history, and recreates the samples. Persistent profiles never reset listings. SQLite persistence supports API restarts while the same chain remains running; it does not make blockchain state persistent.

For separate service terminals, run `npm run chain`, then `npm run deploy`, then `npm run api` and `npm run web`. Re-running deployment against the same active chain reuses the deployment.

If a resumed demo auction can no longer accept its initial bid, deployment reports the skipped bid and finishes seeding the remaining listings without replacing the existing auction. Subsequent runs report the degraded seed status without retrying the skipped bid.

## Persistent Sepolia profile

`BIDPARK_PROFILE=local` (the default) selects Hardhat chain 31337 and the local-only seed and wallet tools. `BIDPARK_PROFILE=sepolia` selects Ethereum Sepolia L1 (11155111), native test ETH, browser wallets, and finalized chain state. An unknown profile is an error; there is no fallback to another network. Set the same profile for the API and web build. `npm run dev` remains local-only.

These are operator instructions for an authorized environment, **not authorization to deploy or run a public pilot**. Check the [pilot release gates and Sepolia support window](docs/pilot-policy.md#release-gates) first. The API still binds to loopback; public hosting and authentication are separate work under [#23](https://github.com/jarcur1/bidparkchain/issues/23).

| Setting | Sepolia use |
| --- | --- |
| `BIDPARK_PROFILE` | Set to `sepolia` for the deploy tool, API, and web build. |
| `BIDPARK_DATA_DIR` | Required; use a dedicated persistent directory outside the source checkout. Retain its `deployment.json` and `bidpark-sepolia.db` across restarts. Do not reuse it for local development. |
| `BIDPARK_SEPOLIA_RPC_URL` | Required for the deploy tool and API. Use a server-side HTTPS endpoint with `finalized`, historical transaction reads, and EIP-1898 block-hash parameters. Do not put its credentials in `VITE_*` variables or browser config. |
| `BIDPARK_SEPOLIA_DEPLOYER_KEY` | Required **only** for explicit creation. Inject a dedicated faucet-funded test key through an approved secret manager into that process; do not set it in the API or build environment, log it, or commit it. |

- `npm run deploy` verifies and reuses the persisted descriptor without a deployer key or reseeding. A missing or invalid descriptor fails closed; it never causes an automatic redeployment or SQLite reset.
- `npm run deploy -- --create` explicitly submits a new deployment only when no deployment already exists. If the invocation stops before finalization, keep `deployment.json.pending` private. Use `npm run deploy -- --resume` to recover the same journaled transaction without a deployer key; if it was not observed, the tool can rebroadcast that exact signed transaction, not sign another. Do not delete a pending journal or stale lock before reconciling the transaction and confirming no deploy process is active.
- `npm run deploy -- --adopt <transaction-hash>` records an existing finalized deployment with the expected creation and runtime bytecode. It does not sign or send a transaction.
- `npm run api` serves the verified deployment using the same directory. `npm run build` with the Sepolia profile produces browser-wallet-only assets with no local `/rpc` proxy. Serve the built assets and route same-origin `/api` to the matching API; the development server is not hosted infrastructure.

For explorer verification, export the exact Solidity standard JSON input with `node --input-type=module -e "import {compileEscrowContract} from './scripts/helpers/compiler.mjs'; const {input}=compileEscrowContract(); console.log(JSON.stringify(input));"`. Use `project/contracts/ParkingAuctionEscrow.sol:ParkingAuctionEscrow`, the full compiler version recorded in `deployment.json`, Shanghai EVM, and optimizer 200 runs. The contract has no constructor arguments. Explorer links point to the Sepolia explorer only.

The API pins confirmed listings and registration checks to finalized state; mining alone is not confirmation on Sepolia. If the app reports a submitted transaction whose finality it cannot establish, check its hash in the explorer before retrying. Reload-safe transaction and listing-registration recovery is tracked in [#10](https://github.com/jarcur1/bidparkchain/issues/10). Normal verification uses an owned local Sepolia-chain-ID fixture, not a public RPC or shared contract.

## Boundaries before real use

This is a functional local prototype, **not an audited or production-ready payment system**. It does not verify listing ownership, availability, identities, municipal permission, gate access, or parking delivery. It has no fiat payments, dispute resolution, cancellation policy after bidding, or production authentication/operations. A wallet address is not proof of property ownership.

See the [shared testnet pilot policy](docs/pilot-policy.md) for the proposed pilot scope, the [booking and escrow policy](docs/booking-policy.md), and the approvals required before any real booking or funds. These decisions do not change the local prototype or enable a public deployment.

All listing fields are public: they appear in the UI and in `GET /api/listings`. The description is labelled **Public space description**, and the listing form shows a review step (exact normalized public metadata plus a privacy warning) that must be confirmed before anything is signed or sent; editing any field after the preview invalidates it. Safe things to enter are physical attributes of the space: size, surface, lighting, clearance height, cover, and nearby landmarks. Do not enter personal information or any private or access-related information. Private access instructions are **not supported**: there is no private instruction field, and the app does not detect or redact sensitive prose, so whatever you write is published as-is. Contract storage also publicly exposes wallet addresses, bid amounts, and auction times; only a metadata hash goes on-chain. The public test mnemonic is deliberately for local use only.

OpenStreetMap tiles and listing photography require an internet connection; the auction list and local chain do not depend on those image services. Map data © OpenStreetMap contributors. Sample photographs are illustrative, not verification of a listed property.
