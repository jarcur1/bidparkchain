# Host space verification and moderation

A wallet signature only proves control of a wallet. It does not prove the right to rent a parking space. Verification is an off-chain review of a host's proof that they control a stable on-chain space (`spaceId` and `spaceOwner` in the contract).

## States

| State | Meaning |
| --- | --- |
| (none) | No request yet. Shown as "Not verified". |
| `pending` | The space's on-chain owner submitted proof; waiting for a moderator. |
| `approved` | A moderator accepted the proof. Listings on the space show **Verified space**. |
| `rejected` | A moderator did not accept the proof. The host can submit new proof for re-review. |
| `suspended` | An approval was revoked (for example after a confirmed report). The host can submit new proof for re-review. |

Public listing responses only carry `verification: "verified" | "unverified"`. `verified` means a moderator approved proof from the space's current on-chain owner. It is not a guarantee about the space's condition or availability. Pending, rejected and suspended all show as unverified to the public.

## Proof-of-control process

1. The host signs in with the wallet that owns the space on chain and opens **My Activity → Space verification**.
2. The host describes the proof in 10 to 2000 characters, e.g. a lease, deed, HOA or landlord permission, or a utility bill for the address. Ask for the least that shows control. Don't ask for ID numbers or full documents.
3. The API checks `spaceOwner(spaceId)` on chain, and only the owner can submit. A space that is already pending or approved cannot be submitted again.
4. A moderator reviews the proof against the listing address and approves or rejects it with a reason code.

## Moderators and reason codes

Moderators are the wallet addresses in `BIDPARK_MODERATORS` (comma-separated; the API refuses to start if an entry is not an address). A moderator signs in like any user. **My Activity** then also shows the moderation queue. A moderator cannot decide on a space they host.

| Action | From → to | Reason codes |
| --- | --- | --- |
| approve | pending → approved | `control-verified` |
| reject | pending → rejected | `insufficient-evidence`, `not-space-controller`, `duplicate-listing`, `fraudulent-listing` |
| revoke | approved → suspended | `control-lost`, `duplicate-listing`, `fraudulent-listing`, `policy-violation`, `host-request` |

Each decision can carry a note of up to 280 characters. Any signed-in wallet can report a space with `POST /api/spaces/:spaceId/report` (`duplicate-listing`, `fraudulent-listing` or `not-space-controller`). Reports show in the moderation queue and do not change the state.

## Audit history

Every submission, decision and report is appended to `verification_audit` with the actor wallet, time, action, resulting state, reason code and note. SQLite triggers reject any `UPDATE` or `DELETE` on that table. Hosts see the history of their own spaces, but not who reported them. Moderators see everything.

## Private evidence: access and retention

- Evidence is returned only by `GET /api/moderation/verifications`, which is limited to moderators. It is never in listings, the host's own view, on-chain records or logs, and the API does not log request bodies.
- Evidence is cleared when a request is rejected or revoked. A re-review needs new proof. Approved evidence is kept while the approval stands, so a later report can be checked against it.
- The database backups (see [operations-backup.md](operations-backup.md)) contain the current evidence and are owner-only.
- Resetting the local demo (`npm run deploy`) clears verification states, because the redeployed contract reuses space ids. The audit log is not cleared.

## API

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/verifications/mine` | signed in | The wallet's requests and history, and whether it is a moderator. |
| `POST /api/spaces/:spaceId/verification` `{ evidence }` | space owner | Request verification or re-review. |
| `POST /api/spaces/:spaceId/report` `{ reason, note }` | signed in | Flag a space for moderators. |
| `GET /api/moderation/verifications` | moderator | Queue with evidence and full history. |
| `POST /api/moderation/verifications/:spaceId` `{ action, reason, note }` | moderator | Approve, reject or revoke. |

## Not covered yet

Verification is advisory for now. The contract does not check it, so an unverified or suspended space can still get new auctions and bids, and revoking leaves open auctions and reservations as they are. Enforcing it at the authoritative layer needs a contract change, which is tracked in #12/#13.
