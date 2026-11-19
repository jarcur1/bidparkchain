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
- Responses carry `nosniff`, `no-referrer`, `DENY` framing and `no-store`. The API gets a `default-src 'none'` CSP, and the web app a CSP limited to its own scripts, Google Fonts and https images.
- With `BIDPARK_TRUST_PROXY=loopback`, client IPs come from Caddy and the session cookie is marked `Secure`.

## Health

- `GET /api/health/live`: the process answers. Use it for restarts.
- `GET /api/health/ready`: 200 only when the database, the chain id, contract code at the deployment address and (if `BIDPARK_MAX_INDEX_LAG` is set) index freshness all pass. Each check reports `ok` or a fixed reason, never an upstream error. Use it to gate traffic after a deploy.

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
