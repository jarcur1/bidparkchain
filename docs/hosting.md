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
- Bodies are capped at 100 KB, except photo uploads (2 MB, see Photos under [host workspace](#host-workspace)), URLs at 2,048 characters, and query strings are parsed flat.
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
| `BIDPARK_KEEPER_MAX_FEE_GWEI` | Ceiling for the keeper's `maxFeePerGas` when it replaces a stuck transaction, 100 by default. |

How it works:
- **What it settles.** Candidates come from the event index: auctions with at least one bid and no indexed settlement or cancellation. It reads each one's live state first and calls `settle` only when bidding has closed and it is still unsettled. Auctions without bids are left alone, so the host can still cancel them. Protected bookings follow the contract: it settles before parking starts, calls `expire` (refunding the winner) for one still unsettled after parking starts, and calls `expireDispute` (refunding the winner) for a report still open at the end of its 72-hour resolution window. Candidates also include auctions with a report that has no decision or refund yet. A report inside its window is a dispute hold: the keeper sends nothing and a resolver decides. It never claims host payouts or resolves reports. The job row records which action it performed. The keeper relies on the indexer job, so keep `BIDPARK_INDEX_INTERVAL_MS` above 0.
- **One transaction per auction.** Each attempt is stored in `settlement_jobs` (auction, status, transaction hash, attempts, last error, next retry). The keeper signs the transaction and records its hash before broadcasting it, so a crash or a lost RPC response still leaves a transaction to check. After a restart it checks the stored transaction instead of sending again. It sends again only once that transaction has reverted, been reorged out, or been missing from the node for 5 minutes.
- **Stuck transactions.** A transaction still pending after 2 minutes is replaced: same nonce and gas limit, `maxFeePerGas` and priority fee raised by 20% (nodes reject less than 10%), clamped to `BIDPARK_KEEPER_MAX_FEE_GWEI`. The new hash is stored before broadcasting. At most 5 transactions are sent per job this way; if the cap leaves no room for a valid bump the keeper logs `replace_capped` and keeps waiting. If the original mines first, the replacement fails with a nonce error and the job confirms normally. Each replacement is one `replaced` log line.
- **Races and reorgs.** If someone settles first, including in the same block, the result counts as success (`AlreadySettled` is not a failure). If a reorg undoes a settlement, the auction becomes a candidate again and is settled again.
- **Confirmation.** A job is `confirmed` once the auction reads as settled at the profile's confirmation depth: the latest block locally, the finalized block on Sepolia. Until then it counts as pending.
- **Failures.** A failed attempt (unfunded keeper, RPC outage, revert) is retried with exponential backoff: 30 s, doubling, capped at 15 minutes. Reasons are fixed codes such as `INSUFFICIENT_FUNDS`, `NETWORK_ERROR`, `TIMEOUT` or a contract error name, never an upstream message.
- **Shutdown.** SIGTERM waits for a pass in flight, just like the indexer, before the database closes.

Visibility:
- `GET /api/settlement` returns `{ enabled: false }` when off. When on, it returns the keeper address (to fund it), interval, confirmation policy, last run time and error, pending count, job counts by status, and the 10 most recent failing jobs (auction, attempts, reason, next retry). It never returns keys or RPC URLs.
- When the keeper is on, `/api/health/ready` adds a `settlement` check: `not run yet`, `last settlement run failed`, or `keeper is out of funds`.
- Every send, confirmation and failure is logged as one JSON line with `component: "settlement"`, the auction id, the attempt count, the reason and the transaction hash. Alert on repeated `failed` lines or a `pending` count that keeps growing. For `INSUFFICIENT_FUNDS`, top up the keeper address with Sepolia ETH; retries resume on their own. For `NETWORK_ERROR` or `TIMEOUT`, check the RPC provider. Either way, users can still settle manually.

### Settlement metrics

`GET /api/settlement/metrics` returns Prometheus text (`text/plain; version=0.0.4`). It carries only counts and timings, no keys, addresses or hashes, and returns `bidpark_settlement_enabled 0` when the keeper is off. Counters (`*_total`) restart with the process; the gauges come from the database.

| Metric | Meaning |
| --- | --- |
| `bidpark_settlement_jobs{state}` | Jobs by state: `sent`, `confirmed`, `failed`, `cancelled`. |
| `bidpark_settlement_job_attempts` | Transactions sent across all jobs, replacements included. |
| `bidpark_settlement_pending` | Auctions the last pass left unfinished. |
| `bidpark_settlement_sent_total`, `_replaced_total`, `_failures_total`, `_run_failures_total` | Sends, fee-bump replacements, failed attempts and failed passes since start. |
| `bidpark_settlement_last_run_timestamp_seconds`, `_last_run_ok` | When the last pass ran (0 before the first) and whether it succeeded. |
| `bidpark_settlement_lag_seconds` | Age of the oldest job that is still `sent` or `failed`, 0 if none. |

Scrape it from the private network only, or keep it behind the reverse proxy; it is as public as `/api/settlement`. A sample alert rule is in [operations-backup.md](operations-backup.md#settlement-keeper-alerts).

## Host workspace

The My Activity tab holds a host workspace for a connected wallet:

- **Spaces.** Spaces the wallet owns or may list on (approved lister), read from contract events and state, with held windows, blocked windows and verification status. Owners can set the IANA time zone, approve or revoke listers, block or unblock dates and transfer the space; each is a wallet transaction shown in the transaction center.
- **Drafts and templates.** Saved on the server per signed-in wallet (`/api/drafts`, migration 8), private to that wallet, at most 50 each. They hold form text, a photo reference and wall-clock dates, never a signature or a secret. They are included in backups.
  The browser clears the open editor when the connected wallet, deployment, or app sign-in changes. Saved copies remain available to their owner.
- **Photos.** A photo is an https URL, a local path starting with `/`, or an upload from the workspace file picker. An upload is sent as raw bytes to `POST /api/photos`, and the declared `Content-Type` is ignored. The API accepts a JPEG, PNG or WebP of at most 2 MB, checked by its magic bytes: a larger file gets 413 and any other content gets 415. It stores the file as `<BIDPARK_DATA_DIR>/photos/<sha256>.<jpg|png|webp>` (owner-only) and returns `/api/photos/<sha256>.<ext>`, which the photo field then holds. Only a signed-in wallet that owns or lists on a space, or has saved a draft, may upload; anyone else gets 403 and is told to save a draft first. Disk use is bounded: each wallet may hold `BIDPARK_PHOTO_MAX_PER_WALLET` photos (default 20; more gets 429) and the store holds at most `BIDPARK_PHOTO_STORAGE_MB` (default 200; more gets 413). A sweep on startup and every `BIDPARK_PHOTO_SWEEP_MINUTES` (default 60) deletes photos that no draft, template or listing has referenced for `BIDPARK_PHOTO_GRACE_HOURS` (default 24), and stray temporary files; a referenced photo is never deleted, and a deleted one frees its wallet's quota. Uploaded photos are public by URL and are not part of `npm run backup`; copy `photos/` with each backup (see [backups](operations-backup.md)). An external URL is only as available as the site serving it. An empty or unreachable photo falls back to the default illustrative photo. A failed or cancelled upload leaves the previous photo unchanged.
- **Scheduling.** Cutoff, start and end are entered as wall-clock times in the space's time zone (the browser's zone while none is set), converted to UTC seconds, and checked against held and blocked windows before signing. The contract rechecks at signing and remains the authority. The quick "List a Spot" dialog uses the same explicit dates, zone and conflict check (it starts with a default window an hour out).
- **Autosave.** While signed in, the quick listing form saves one private draft named "Autosaved listing" about 1.5 seconds after the last change, shows `Unsaved changes`, `Saving`, `Draft saved.` or a failure, and restores it after a reload or sign-in. Without a session nothing is saved and the form says so. Making the listing deletes the draft.
- **Reports and moderation.** A signed-in wallet can report a listing from its detail dialog. Moderators page through the queue 25 at a time (`/api/moderation/verifications?limit&offset`).

Published auction metadata is immutable; relisting a space starts a new draft and a new auction.

## Arrival instruction encryption

Private arrival instructions are encrypted at rest with AES-256-GCM (`node:crypto`). The key is `BIDPARK_ARRIVAL_KEY`: 32 random bytes as 64 hex characters (or base64). An invalid value stops the API at startup.

- **Hosted mode** (`BIDPARK_ALLOWED_ORIGINS` set) refuses to save instructions while the key is unset (HTTP 503).
- **Local and demo mode** keep working without a key and store the text unencrypted. `GET /api/settings` reports `arrivalEncryption: "off"` with a note, or `"aes-256-gcm"`. It never returns the key.
- **Existing rows.** Rows saved before the key was set are plaintext (migration 11 adds an `encrypted` flag, default 0). Start the API once with the key set and it encrypts them in place; a repeat start finds none.
- **Binding.** Each value is authenticated with its chain, contract, scope and id, so a value copied to another row fails to decrypt.
- **Keep the key apart from backups.** The database and its backups then hold only ciphertext. SQLite may leave old plaintext in free pages of a file that held plaintext rows, so run `VACUUM` once after enabling the key, and treat backups taken before that as plaintext.
- **Losing the key** makes stored instructions unreadable; hosts must enter them again. There is no key rotation yet: to change the key, decrypt with the old one and re-save with the new one.

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
4. Gate on `/api/health/ready`. The data directory (including `photos/`), database and `deployment.json` are never touched by a deploy, so auctions, listings, uploaded photos and the contract identity carry over. `npm run deploy` without `--create` only verifies and reuses the recorded contract.

## Restart

`sudo systemctl restart bidpark` drains requests and the index job, then reopens the same database and contract. Listings and sessions survive, and the indexer resumes from its checkpoint.

## Roll back

1. Switch the `current` link back to the previous release and restart.
2. If the newer release migrated the database, the older code refuses to open it rather than misread it. Restore the pre-migration copy (`<db>.pre-v<N>-<time>.bak`) or the backup from step 1. Verify it with `npm run backup -- restore` into a separate directory, then move it into place.
3. Never point a data directory at a different contract. The deploy tool and API refuse a descriptor that doesn't match the chain and its recorded bytecode, so contract identities can't be mixed.

The restart and data-preservation behavior is covered by `tests/api/testnet-profile.test.mjs`, the restore drill in `tests/api/backup-restore.test.mjs`, and the migration tests. `tests/e2e/hosted-build.spec.mjs` builds the Sepolia app and loads it in a browser under the hosted CSP.
