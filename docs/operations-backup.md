# Backups, restore and migrations

The chain stores only each listing's metadata hash. The SQLite database is the only copy of listing details, staged metadata, deployment history, sign-in sessions and profiles. A hash cannot rebuild them, so the database has to be backed up.

**Deleting the database and running `npm run deploy` again is not a recovery.** On the local chain it recreates the demo listings and nothing else. On Sepolia the deploy tool never reseeds or clears listings.

## Backups

```sh
npm run backup                     # BIDPARK_DATA_DIR, default ./data
```

- **Consistent while running.** The database is copied with SQLite `VACUUM INTO`, a transactionally consistent snapshot, so the API can keep serving during a backup.
- **What's included.** Each backup is a timestamped directory, `<data>/backups/<UTC time>/`, unless `BIDPARK_BACKUP_DIR` points somewhere else. It holds:
  - the database copy
  - `deployment.json`
  - `manifest.json`: schema version, listing count, SHA-256 of the copy, and deployment identity (profile, chain id, contract address, deployment transaction and block). Its `indexCheckpoint` field is null until the event indexer (#15) exists.
- **Access.** Backup directories are created owner-only (0700, files 0600). Windows ignores these modes, so keep backups on a location only the operator account can read. They contain session hashes and profile data.
- **Retention.** The newest 14 backups are kept and older ones are pruned. Change this with `BIDPARK_BACKUP_KEEP`.
- **Targets for a hosted pilot:**

  | Target | Value | How it's met |
  | --- | --- | --- |
  | Recovery point (RPO) | ≤ 1 hour of off-chain data | Run `npm run backup` hourly from the host's scheduler and copy each backup off the machine. |
  | Recovery time (RTO) | ≤ 15 minutes | Restoring and verifying is one command that finishes in seconds. |

  Listings created after the last backup are not lost entirely. If their auctions exist on-chain and their metadata was staged, the API recovers them. Otherwise they are reported under `unindexed` until their owner registers the details again.

## Restore

```sh
npm run backup -- restore <backup-dir> <empty-target-dir>
```

The restore refuses to write over the live data directory or into a non-empty one, so a backup is always checked in a separate place first. It verifies:

1. the database file matches the manifest's SHA-256
2. the restored `deployment.json` names the same chain and contract as the manifest
3. the schema is supported, and older schemas are migrated forward as described below
4. every listing's stored metadata still hashes to its recorded `metadata_hash`, and the listing count matches

It only prints `Ready` when all of these pass. Then stop the API, move the verified directory into place (or point `BIDPARK_DATA_DIR` at it), and start the API again.

## Schema versions and migrations

- The database's version is `PRAGMA user_version`. Migrations live in `server/db.mjs`, run in order, and each one runs once.
- **Before migrating** a database that already holds data, the API saves a `VACUUM INTO` copy beside it named `<db>.pre-v<N>-<time>.bak`.
- **Each migration runs in its own transaction.** If one fails, it is rolled back, the database stays at the last good version, and the error names the pre-migration copy. Nothing half-applied is left behind.
- **A database newer than the code is refused,** so older code never writes to a newer schema. To roll back the code, restore the matching pre-migration copy or backup.
- New migrations must only add to the end of the list and must preserve existing rows.

## Shutdown

On SIGINT or SIGTERM the API stops accepting connections, lets in-flight requests finish (up to 10 seconds, then remaining connections are closed), and only then closes the database and RPC provider.

## Drill

`tests/api/backup-restore.test.mjs` runs in CI on every pull request. It:

- seeds a stack, backs it up through the CLI while the API runs, and restores into a separate directory
- serves the restored copy and checks that it returns the same listings
- covers damaged backups, tampered metadata, non-empty targets, the live directory, and retention

`tests/api/migrations.test.mjs` covers failed-migration rollback and the pre-migration copies, and `tests/api/shutdown.test.mjs` covers draining on shutdown.
