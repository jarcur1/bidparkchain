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

Ports 5173, 3001, and 8545 must be available. Services bind to loopback; this is not a deployment configuration.

## Classroom demo

What if one more dorm made good commuter parking so scarce that students started auctioning it off? BidPark uses that premise for an **unofficial, LSU-inspired classroom parody**. The dorm expansion is fictional, not a finding about LSU construction or parking supply. Listings, bids, and winning reservations are illustrative; no real money changes hands and no actual parking or access is provided.

Run `npm ci` ahead of time. Start with `BIDPARK_SCENARIO=campus-baseline npm run dev`, then stop it and run `BIDPARK_SCENARIO=campus-expansion npm run dev` to show what changed. In PowerShell, set `$env:BIDPARK_SCENARIO = 'campus-baseline'` (or `'campus-expansion'`) before running `npm run dev`. Leaving the variable unset shows the Austin sample listings, not the classroom scenarios.

Open the loopback URL above and select a built-in **local test wallet** under **Connect Wallet**. No wallet extension, public testnet, or external data feed is needed. Use **Cards** if the map does not load. See the [scenario setup](docs/class-demo-scenarios.md) and [presenter walkthrough](docs/class-demo-presenter.md).

## Try it

- Browse the cards and map; search by location and filter parking types.
- Open the wallet control and explicitly select a **local test wallet**. These use Hardhat's publicly known development accounts. Account 0 owns the seeded listings; account 1 has two seeded example bids. Switch buyer accounts to exercise outbidding.
- Open a spot to inspect its reservation window and auction closing time, then submit a full bid in local ETH. Wait for the transaction confirmation.
- Use **My activity** to see leading bids and reservations, withdraw refundable outbid amounts, and settle a closed auction. The highest bidder wins; settlement is permissionless.
- Create a new listing with public metadata and a future auction/reservation window. Creating the on-chain auction and registering its hash-matched metadata are separate operations.
- If the auction confirms but metadata registration fails, use **Complete Registration** to retry the same auction without deploying another one. The committed metadata is read-only during recovery. Recovery survives a reload. The details were saved to the API before signing, so the listing usually reappears by itself. Otherwise **My Activity → Transactions** offers **Complete registration** with the original metadata.
- **My Activity → Transactions** keeps every wallet transaction for the connected account and deployment, saved in the browser without keys. It shows the state (waiting for wallet, submitted, confirming, confirmed, rejected, reverted, replaced, cancelled or unknown) and the transaction hash, with an explorer link on Sepolia. Transactions still in flight are re-checked after a reload, and nothing is ever re-sent. Entries from a reset deployment are listed as not resumable.
- As the owner, cancel an unbid listing or claim its escrow after settlement and the end of the parking window.

An injected Ethereum wallet is also supported on local chain **31337**. If adding it manually, use RPC **http://127.0.0.1:8545**, currency **ETH**. Use a disposable wallet; the built-in local test option is simpler.

### Escrow rules

- A bid must meet the opening price and exceed the current highest bid. Owners cannot bid on their own auctions.
- Each transaction sends the **entire new bid**, not a top-up. A displaced bid—including your own previous bid when raising it—becomes a withdrawable refund.
- Owners cannot cancel an auction after any bid. The current winner cannot withdraw their winning bid. Protected bookings (below) add cancellation paths that refund the winner.
- Bid eligibility (open, not cancelled or settled, not the owner) is one rule shared by cards, the detail view, map popups and the bid dialog. It is judged against **chain time**, not the browser clock: `GET /api/listings` returns a `chain` object (deployment identity, the one block all its contract reads used, its timestamp and a `chainTime` lower bound for the next block), and the browser advances that value with its monotonic clock between polls.
- An open bid dialog is bound to the listing's deployment, auction id and metadata hash, not a snapshot. Price, owner and eligibility refresh with every poll while the amount you typed is kept. If the deployment or committed metadata changes, or the listing disappears, the dialog closes. Before the wallet is asked to sign, the bid is revalidated against freshly read chain state; a competing bid, cutoff, cancellation or settlement is reported with your input retained and no transaction sent.
- Bidding ends at the contract's `bidEnd` timestamp. The winner is confirmed by calling `settle` after that deadline.
- Seller payout is available only after settlement and `parkingEnd`, and can be claimed once.
- For ordinary listings there is **no refund or dispute process for an inaccessible space**. Time-locked escrow does not prove physical access or delivery.

### Protected bookings

A host can select **Protected booking** in **List a Spot** or in **My Activity → Host workspace**. Parking must start at least 30 minutes after bidding closes. In the workspace, make the choice when publishing; it is not saved in drafts or templates. The contract applies the [booking policy](docs/booking-policy.md#protocol-version-2-in-the-contract) to that auction (`createProtectedAuction`, `bookings(id)`); ordinary listings keep the rules above.

- The winner must be settled before parking starts. After that, anyone can `expire` it and the winner is refunded in full.
- The host can withdraw the booking (`hostCancelBooking`) from the cutoff until parking starts; the winner is refunded in full.
- The winner can cancel (`cancelBooking`) for a full refund up to 24 hours before parking starts. Later, the cancellation is only recorded and there is no refund.
- The winner or host can report a seller failure (`reportSellerFailure`) until 24 hours after parking ends. While it is open the payout is held. A resolver who is not a party upholds it (winner refunded) or denies it before 72 hours after parking ends; after that anyone can `expireDispute`, which refunds the winner.
- The host claims the payout only from 24 hours after parking ends, with no open report. It is credited like a refund and withdrawn with **Withdraw**.
- Every refund and payout is a credit to withdraw; no protected action sends ETH. The detail view shows the booking status, deadlines and the actions open to the connected wallet, and the inbox notes a refunded winning bid.
- The deploying account authorizes resolvers with `setResolver(address, true)`. Participants submit private evidence through the app, and resolvers review it in **My Activity → Resolver queue**. Only an opaque reference is recorded on-chain.

### Parking spaces and calendars

- Every auction belongs to one on-chain parking space with a stable `spaceId` and an owner wallet. `createAuction` registers a new space for a one-off listing; `registerSpace` creates an empty one.
- `createSpaceAuction(spaceId, ...)` lists another window on an existing space. Only the space owner or a lister it approved can call it, and the contract rejects it (`SpaceWindowTaken`) if `[parkingStart, parkingEnd)` overlaps a window the space still holds. Windows that only touch (one ends exactly when the next starts) are allowed. The check runs inside the transaction, so it also covers direct contract calls and two listings mined in the same block.
- A window is held while its auction is not cancelled and either has a bid or is still open for bidding (`holdsWindow`). Cancelling, or bidding closing with no bids, releases it. A winning bid keeps it held for good.
- The owner can approve or revoke listers (`setSpaceLister`). A lister's auction is its own: it cancels it and receives the payout. Revoking a lister only stops new listings; its auctions with bids stand, and the space owner may cancel its bidless ones. `transferSpace` hands the space to a new owner and drops every approved lister; existing auctions and their payouts do not change.
- `setSpaceTimeZone` records the IANA time zone name of the space's location (for example `America/Chicago`). The contract checks only the name's shape; `GET /api/listings` returns it as `timeZone` (empty until set), and the app shows that listing's parking times in it. An unset or unknown name falls back to the viewer's zone.
- `blockSpaceWindow(spaceId, start, end)` blocks dates so nothing can be listed over them (`SpaceWindowUnavailable`) until `unblockSpaceWindow`. A block cannot cover a window the space still holds, and never affects existing auctions. Availability is every time that is neither held nor blocked.
- The overlap check is bounded: each space keeps at most `MAX_SPACE_WINDOWS` (64) upcoming held or blocked windows (`SpaceCalendarFull` beyond that), and windows that ended or were released are pruned as new ones are checked. Measured on the local chain, listing with 63 upcoming windows costs about 389k gas, against 226k for an empty space; the listing that prunes 63 stale windows costs about 809k once.
- `spaceAuctions(spaceId)` returns every auction on the space, oldest first. In verified-inventory mode, a verifier binds each physical stall to one opaque identity and one on-chain calendar. Unverified spaces cannot get new auctions or bids. The local demo keeps its normal one-off listings. See [host verification](docs/host-verification.md#verified-inventory-deployments) for the operator flow and its limits.

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
| `contracts/ParkingAuctionEscrow.sol` | Parking spaces and their calendars, auctions, pull refunds, settlement, time-locked owner payout, protected bookings |
| `server/` | Express API and Node's native SQLite metadata storage |
| `shared/` | Shared types and canonical metadata normalization |
| `scripts/deploy.mjs` | Local Solidity compilation, deployment, seeded listings |
| `scripts/dev.mjs` | Cross-platform local service launcher |
| `tests/` | Isolated suites; `tests/support/` owns disposable chains, services, and temp data |
| `scripts/health.mjs` | Read-only health check for shared deployments |

### Data and restarts

SQLite metadata and the deployment descriptor live under gitignored `data/`. Metadata is hash-bound to each auction on-chain; a registration with mismatched metadata is rejected. No privileged HTTP endpoint can alter auction ownership or bids.

Listing records are keyed by chain id, contract address and auction id, and keep the exact canonical JSON that hashes to the on-chain `metadataHash`. The schema is versioned (`PRAGMA user_version`), and older databases are migrated in place on startup without losing rows. Every deployment the API serves is recorded and never deleted. Before signing the create transaction, the app stages its metadata with `POST /api/listings/stage`. If registration is lost after that, the API recovers the listing from the new auction's hash. Any on-chain auction with no matching metadata is returned under `unindexed` in `GET /api/listings` and noted in the marketplace, rather than silently hidden. The API also runs a background event indexer (every 5 s; `BIDPARK_INDEX_INTERVAL_MS`, 0 disables it). It records every auction event with its block and transaction, follows the profile's confirmation policy, and handles reorgs by orphaning replaced events. Bounded discovery queries (visit interval, area, kind, amenities, budget, sort, cursor pages pinned to one block) are at `GET /api/listings/search`; see [listing search](docs/listing-search.md). Index freshness is at `GET /api/index`, and an auction's public history at `GET /api/auctions/:id/events`, with each event's block time. `GET /api/accounts/:address/history` returns a wallet's events, plus every bid on auctions it bid on, with the chain id and contract address they were read from. My Activity uses it for a searchable, paginated history of every auction the wallet bid on or won, including lost ones. Each is labelled awaiting settlement, upcoming, in progress, completed, cancelled/refunded, disputed or expired from contract state, with times in the space's own IANA time zone (the viewer's zone, named, when the space has none). A history link carries the chain and contract (`?tab=activity&chain=&contract=&auction=`) and is refused on any other deployment. A signed-in wallet's inbox at `GET /api/inbox` has outbid, won, refund withdrawn and payout claimed entries, and, for a protected booking the wallet hosts or won, every booking change (refund, late cancellation, no-show, seller-failure report, decision, expiry). These come from canonical events only, so orphaned events never notify. Off-chain entries are merged into the same feed by time: the winner's upcoming reservation (from 24 hours before parking starts) and arrival details (from one hour before; it says whether instructions exist, never their text), both checked against the chain with the arrival API's rules and shown until parking ends, and the winner's check-in for the host. `POST /api/inbox/read`, `POST /api/inbox/dismiss` (each `{ ids }`) and `POST /api/inbox/preferences` (`{ hidden }`: any of bids, reservations, bookings, funds) need a session and only ever touch the caller's own state. The app polls it every 10 s and shows it on My Activity with an unread badge in the header, links to arrival details and the auction's history, and says when the index is behind or the inbox can't be loaded. There are no email, SMS or push notifications. Hosts can ask moderators (`BIDPARK_MODERATORS`) to verify that they control a space; listings then show a verified badge, and every decision is kept in an append-only audit log. See [host verification](docs/host-verification.md). Back up the database with `npm run backup` and restore with `npm run backup -- restore <backup> <empty-dir>`; see [backups, restore and migrations](docs/operations-backup.md).

The local Hardhat chain is **in memory**. Stopping and restarting it resets auctions, balances, and reservations. A fresh local deployment explicitly resets that local chain's listings, keeping deployment history, and recreates the samples. Persistent profiles never reset listings. SQLite persistence supports API restarts while the same chain remains running; it does not make blockchain state persistent.

For separate service terminals, run `npm run chain`, then `npm run deploy`, then `npm run api` and `npm run web`. Re-running deployment against the same active chain reuses the deployment, unless the contract source changed since; then it deploys and seeds a new one.

If a resumed demo auction can no longer accept its initial bid, deployment reports the skipped bid and finishes seeding the remaining listings without replacing the existing auction. Subsequent runs report the degraded seed status without retrying the skipped bid.

## Persistent Sepolia profile

`BIDPARK_PROFILE=local` (the default) selects Hardhat chain 31337 and the local-only seed and wallet tools. `BIDPARK_PROFILE=sepolia` selects Ethereum Sepolia L1 (11155111), native test ETH, browser wallets, and finalized chain state. An unknown profile is an error; there is no fallback to another network. Set the same profile for the API and web build. `npm run dev` remains local-only.

These are operator instructions for an authorized environment, **not authorization to deploy or run a public pilot**. Check the [pilot release gates and Sepolia support window](docs/pilot-policy.md#release-gates) first. The API still binds to loopback; see [hosted staging deployment](docs/hosting.md) for running it behind HTTPS.

| Setting | Sepolia use |
| --- | --- |
| `BIDPARK_PROFILE` | Set to `sepolia` for the deploy tool, API, and web build. |
| `BIDPARK_DATA_DIR` | Required; use a dedicated persistent directory outside the source checkout. Retain its `deployment.json`, `bidpark-sepolia.db` and `photos/` across restarts. Do not reuse it for local development. |
| `BIDPARK_SEPOLIA_RPC_URL` | Required for the deploy tool and API. Use a server-side HTTPS endpoint with `finalized`, historical transaction reads, and EIP-1898 block-hash parameters. Do not put its credentials in `VITE_*` variables or browser config. |
| `BIDPARK_SEPOLIA_DEPLOYER_KEY` | Required **only** for explicit creation. Inject a dedicated faucet-funded test key through an approved secret manager into that process; do not set it in the API or build environment, log it, or commit it. |

- `npm run deploy` verifies and reuses the persisted descriptor without a deployer key or reseeding. A missing or invalid descriptor fails closed; it never causes an automatic redeployment or SQLite reset.
- `npm run deploy -- --create` explicitly submits a new deployment only when no deployment already exists. If the invocation stops before finalization, keep `deployment.json.pending` private. Use `npm run deploy -- --resume` to recover the same journaled transaction without a deployer key; if it was not observed, the tool can rebroadcast that exact signed transaction, not sign another. Do not delete a pending journal or stale lock before reconciling the transaction and confirming no deploy process is active.
- For an authorized test of the booking restriction, use `npm run deploy -- --create --verified-inventory` in a fresh `BIDPARK_DATA_DIR`. The mode is set at construction and cannot be changed; the command refuses to treat an existing demo-mode descriptor as a verified deployment. Nothing is authorized to launch by enabling this mode.
- `npm run deploy -- --adopt <transaction-hash>` records an existing finalized deployment with the expected creation and runtime bytecode. It does not sign or send a transaction.
- `npm run api` serves the verified deployment using the same directory. `npm run build` with the Sepolia profile produces browser-wallet-only assets with no local `/rpc` proxy. Serve the built assets and route same-origin `/api` to the matching API; the development server is not hosted infrastructure.

For explorer verification, export the exact Solidity standard JSON input with `node --input-type=module -e "import {compileEscrowContract} from './scripts/helpers/compiler.mjs'; const {input}=compileEscrowContract(); console.log(JSON.stringify(input));"`. Use `project/contracts/ParkingAuctionEscrow.sol:ParkingAuctionEscrow`, the full compiler version recorded in `deployment.json`, Shanghai EVM, and optimizer 200 runs. The constructor takes a single `bool`, recorded as `verifiedInventoryRequired` in the verified deployment descriptor. Explorer links point to the Sepolia explorer only.

**Contract change:** the space inventory and protected bookings change the escrow bytecode and constructor input. A previous Sepolia descriptor cannot verify against this build; use a new authorized deployment and a new `BIDPARK_DATA_DIR`. This does not migrate or close any old escrow. Local demo chains redeploy as needed.

The API pins confirmed listings and registration checks to finalized state; mining alone is not confirmation on Sepolia. If the app reports a submitted transaction whose finality it cannot establish, check its hash in the explorer before retrying. Normal verification uses an owned local Sepolia-chain-ID fixture, not a public RPC or shared contract.

## Boundaries before real use

This is a functional local prototype, **not an audited or production-ready payment system**. It does not verify listing ownership, availability, identities, municipal permission, gate access, or parking delivery. It has no fiat payments or production authentication/operations. Protected bookings enforce cancellation and dispute deadlines on chain, but the off-chain evidence review channel does not exist yet and no protection has been independently reviewed. A wallet address is not proof of property ownership.

See the [shared testnet pilot policy](docs/pilot-policy.md) for the proposed pilot scope, the [booking and escrow policy](docs/booking-policy.md), and the approvals required before any real booking or funds. These decisions do not change the local prototype or enable a public deployment.

All listing fields are public: they appear in the UI and in `GET /api/listings`. The description is labelled **Public space description**, and the listing form shows a review step (exact normalized public metadata plus a privacy warning) that must be confirmed before anything is signed or sent; editing any field after the preview invalidates it. Safe things to enter are physical attributes of the space: size, surface, lighting, clearance height, cover, and nearby landmarks. Do not enter personal information or any private or access-related information. Private access instructions are **not supported**: there is no private instruction field, and the app does not detect or redact sensitive prose, so whatever you write is published as-is. Contract storage also publicly exposes wallet addresses, bid amounts, and auction times; only a metadata hash goes on-chain. The public test mnemonic is deliberately for local use only.

OpenStreetMap tiles and listing photography require an internet connection; the auction list and local chain do not depend on those image services. Map data © OpenStreetMap contributors. Sample photographs are illustrative, not verification of a listed property.
