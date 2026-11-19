# Hosted staging deployment (Sepolia testnet only)

This runs a shared **Sepolia testnet** pilot. It does not allow real bookings or real funds; the app's testnet and no-booking disclosures stay visible. Check the [pilot release gates](pilot-policy.md#release-gates) before running a public pilot. Local development (`npm run dev`) is unchanged.

## Shape

```
browser ──HTTPS──> Caddy (TLS, HSTS) ──> 127.0.0.1:3001  node server/index.mjs
                                            ├─ /        built web app (dist/)
                                            └─ /api/... API, sessions, indexer job
                                         SQLite + deployment.json in BIDPARK_DATA_DIR
```

- **One process, one origin.** It serves the built web app and the API. There is no Vite dev server and no `/rpc` proxy, so no JSON-RPC endpoint is exposed. Browsers sign with their own wallet. The API's RPC URL stays on the server.
- **No demo signers.** The Sepolia build has no local test wallets or seed bidding, and `/api/config` returns no mnemonic.

## Files

| File | Purpose |
| --- | --- |
| `deploy/Caddyfile` | HTTPS with an automatic certificate, HSTS, and a reverse proxy to the API on loopback |
| `deploy/bidpark.service` | systemd unit: restart on failure, sandboxed, write access only to the data directory, SIGTERM drains requests |
| `deploy/bidpark.env.example` | Every setting, documented. Copy to `/etc/bidpark/bidpark.env` (owner `root:bidpark`, mode 640). |

**Secrets:**
- `BIDPARK_SEPOLIA_RPC_URL` lives only in the root-owned environment file, never in `VITE_*` variables, the repo or logs.
- The deployer key is never set on the server. It is injected only for the one-time `npm run deploy -- --create` (see the README's Sepolia profile section).

## Public-endpoint protections

Hosted mode is on whenever `BIDPARK_ALLOWED_ORIGINS` is set:
- CORS is given only to those exact `https://` origins.
- A write coming from any other origin gets 403.
- Writes are limited per client, 60 per minute by default (`BIDPARK_WRITES_PER_MINUTE`).

These apply in every mode:
- Writes to listing details need a signed-in wallet that owns the auction (#11).
- Host verification review is limited to the wallets in `BIDPARK_MODERATORS`; see [host verification](host-verification.md).
- Bodies are capped at 100 KB, URLs at 2,048 characters, and query strings are parsed flat.
- Every RPC call times out after `BIDPARK_RPC_TIMEOUT_MS` (10 s).
- `GET /api/listings/search` returns at most 50 listings a page, reads at most `BIDPARK_SEARCH_SCAN_LIMIT` (500) candidates from the chain (422 beyond that), and gives up after `BIDPARK_SEARCH_DEADLINE_MS` (20 s) with 503. See [listing search](listing-search.md).
- Responses carry `nosniff`, `no-referrer`, `DENY` framing and `no-store`. The API gets a `default-src 'none'` CSP, and the web app a CSP limited to its own scripts, Google Fonts and https images.
- With `BIDPARK_TRUST_PROXY=loopback`, client IPs come from Caddy and the session cookie is marked `Secure`.

## Health

- `GET /api/health/live`: the process answers. Use it for restarts.
- `GET /api/health/ready`: 200 only when the database, the chain id, contract code at the deployment address, (if `BIDPARK_MAX_INDEX_LAG` is set) index freshness and (if the keeper is on) [settlement](#automatic-settlement) all pass. Each check reports `ok` or a fixed reason, never an upstream error. Use it to gate traffic after a deploy.

## Automatic settlement

An optional keeper in the API process settles auctions whose bidding has closed, so a won auction is not left unsettled only because nobody clicked **Settle**. It is off by default. Manual settlement in the UI stays available either way.

| Setting | Meaning |
| --- | --- |
| `BIDPARK_SETTLEMENT=1` | Turn the keeper on. Anything else, or unset, leaves it off. |
| `BIDPARK_KEEPER_KEY` | Private key of a dedicated, lightly funded keeper account. Required on Sepolia. The API refuses to start with a public demo account key, or with the deployer key if `BIDPARK_SEPOLIA_DEPLOYER_KEY` is also set. On the local profile it falls back to the demo deployer (account 0). |
| `BIDPARK_SETTLEMENT_INTERVAL_MS` | Time between passes, 30 s by default (minimum 1 s). |

How it works:
- **What it settles.** Candidates come from the event index: auctions with at least one bid and no indexed settlement or cancellation. It reads each one's live state first and calls `settle` only when bidding has closed and it is still unsettled. Auctions without bids are left alone, so the host can still cancel them. Protected bookings follow the contract: it settles before parking starts, calls `expire` (refunding the winner) for one still unsettled after parking starts, and calls `expireDispute` (refunding the winner) for a report still open at the end of its 72-hour resolution window. Candidates also include auctions with a report that has no decision or refund yet. A report inside its window is a dispute hold: the keeper sends nothing and a resolver decides. It never claims host payouts or resolves reports. The job row records which action it performed. The keeper relies on the indexer job, so keep `BIDPARK_INDEX_INTERVAL_MS` above 0.
- **One transaction per auction.** Each attempt is stored in `settlement_jobs` (auction, status, transaction hash, attempts, last error, next retry). The keeper signs the transaction and records its hash before broadcasting it, so a crash or a lost RPC response still leaves a transaction to check. After a restart it checks the stored transaction instead of sending again. It sends again only once that transaction has reverted, been reorged out, or been missing from the node for 5 minutes.
- **Races and reorgs.** If someone settles first, including in the same block, the result counts as success (`AlreadySettled` is not a failure). If a reorg undoes a settlement, the auction becomes a candidate again and is settled again.
- **Confirmation.** A job is `confirmed` once the auction reads as settled at the profile's confirmation depth: the latest block locally, the finalized block on Sepolia. Until then it counts as pending.
- **Failures.** A failed attempt (unfunded keeper, RPC outage, revert) is retried with exponential backoff: 30 s, doubling, capped at 15 minutes. Reasons are fixed codes such as `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `TIMEOUT` or a contract error name, never an upstream message.
- **Shutdown.** SIGTERM waits for a pass in flight, just like the indexer, before the database closes.

Visibility:
- `GET /api/settlement` returns `{ enabled: false }` when off. When on, it returns the keeper address (to fund it), interval, confirmation policy, last run time and error, pending count, job counts by status, and the 10 most recent failing jobs (auction, attempts, reason, next retry). It never returns keys or RPC URLs.
- When the keeper is on, `/api/health/ready` adds a `settlement` check: `not run yet`, `last settlement run failed`, or `keeper is out of funds`.
- Every send, confirmation and failure is logged as one JSON line with `component: "settlement"`, the auction id, the attempt count, the reason and the transaction hash. Alert on repeated `failed` lines or a `pending` count that keeps growing. For `INSUFFICIENT_FUNDS`, top up the keeper address with Sepolia ETH; retries resume on their own. For `NETWORK_ERROR` or `TIMEOUT`, check the RPC provider. Either way, users can still settle manually.

## Host workspace

The My Activity tab holds a host workspace for a connected wallet:

- **Spaces.** Spaces the wallet owns or may list on (approved lister), read from contract events and state, with held windows, blocked windows and verification status. Owners can set the IANA time zone, approve or revoke listers, block or unblock dates and transfer the space; each is a wallet transaction shown in the transaction center.
- **Drafts and templates.** Saved on the server per signed-in wallet (`/api/drafts`, migration 8), private to that wallet, at most 50 each. They hold form text, a photo reference and wall-clock dates, never a signature or a secret. They are included in backups.
- **Photos.** A photo is only a reference: an https URL or a local path starting with `/`. There is no upload and no storage service, so the host keeps the image online. An empty or unreachable photo falls back to the default illustrative photo.
- **Scheduling.** Cutoff, start and end are entered as wall-clock times in the space's time zone (the browser's zone while none is set), converted to UTC seconds, and checked against held and blocked windows before signing. The contract rechecks at signing and remains the authority.
- **Reports and moderation.** A signed-in wallet can report a listing from its detail dialog. Moderators page through the queue 25 at a time (`/api/moderation/verifications?limit&offset`).

Published auction metadata is immutable; relisting a space starts a new draft and a new auction.

## First deployment

1. Create a `bidpark` user and `/var/lib/bidpark` (mode 700). Install Node 24 and Caddy.
2. Put the release in `/opt/bidpark/releases/<git sha>` and run `npm ci && BIDPARK_PROFILE=sepolia npm run build` there. Point `/opt/bidpark/current` at it with `ln -sfn`.
3. Fill in `/etc/bidpark/bidpark.env` from the example.
4. Record the contract once, with the deployer key injected only for this command. Use `npm run deploy -- --create`, or `--adopt <tx>` for an existing deployment. This writes `deployment.json` into the data directory.
5. Install the systemd unit and Caddyfile, then start both. Wait for `curl -fsS https://<host>/api/health/ready` to return `"ready": true`.

## Deploy a new version

1. `npm run backup` (with `BIDPARK_DATA_DIR` set). See [backups](operations-backup.md).
2. Build the new release in its own `releases/<sha>` directory, then switch the `current` link to it.
3. `sudo systemctl restart bidpark`. In-flight requests drain first. On start, pending schema migrations run after a pre-migration snapshot.
4. Gate on `/api/health/ready`. The data directory, database and `deployment.json` are never touched by a deploy, so auctions, listings and the contract identity carry over. `npm run deploy` without `--create` only verifies and reuses the recorded contract.

## Restart

`sudo systemctl restart bidpark` drains requests and the index job, then reopens the same database and contract. Listings and sessions survive, and the indexer resumes from its checkpoint.

## Roll back

1. Switch the `current` link back to the previous release and restart.
2. If the newer release migrated the database, the older code refuses to open it rather than misread it. Restore the pre-migration copy (`<db>.pre-v<N>-<time>.bak`) or the backup from step 1. Verify it with `npm run backup -- restore` into a separate directory, then move it into place.
3. Never point a data directory at a different contract. The deploy tool and API refuse a descriptor that doesn't match the chain and its recorded bytecode, so contract identities can't be mixed.

The restart and data-preservation behavior is covered by `tests/api/testnet-profile.test.mjs`, the restore drill in `tests/api/backup-restore.test.mjs`, and the migration tests. `tests/e2e/hosted-build.spec.mjs` builds the Sepolia app and loads it in a browser under the hosted CSP.
