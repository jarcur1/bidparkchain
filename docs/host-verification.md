# Host space verification and moderation

A wallet signature only proves control of a wallet. It does not prove the right to rent a parking space. Verification is an off-chain review of a host's proof that they control a stable on-chain space (`spaceId` and `spaceOwner` in the contract).

## States

| State | Meaning |
| --- | --- |
| (none) | No request yet. Shown as "Not verified". |
| `pending` | The space's on-chain owner submitted proof; waiting for a moderator. |
| `approved` | A moderator accepted the proof. On advisory deployments the review supplies the public badge; gated deployments require a separate on-chain approval. |
| `rejected` | A moderator did not accept the proof. The host can submit new proof for re-review. |
| `suspended` | An approval was revoked (for example after a confirmed report). The host can submit new proof for re-review. |

Public listing responses only carry `verification: "verified" | "unverified"`. `verified` means a moderator approved proof from the space's current on-chain owner. It is not a guarantee about the space's condition or availability. Pending, rejected and suspended all show as unverified to the public.

## Proof-of-control process

1. The host signs in with the wallet that owns the space on chain and opens **My Activity → Space verification**.
2. The host describes the proof in 10 to 2000 characters, e.g. a lease, deed, HOA or landlord permission, or a utility bill for the address. Ask for the least that shows control. Don't ask for ID numbers or full documents.
3. The API checks the owner and records the ownership epoch from the same chain block. A pending or approved request for the same ownership epoch cannot be submitted again. If ownership changed (even if the same wallet later regained the space), submit new proof. Older approvals without a recorded epoch need new proof before they can be signed on-chain.
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
| `GET /api/moderation/verifications/:spaceId/attestation` | moderator | Current review decision and ownership epoch, checked just before signing. Does not sign or change state. |
| `POST /api/moderation/verifications/:spaceId` `{ action, reason, note }` | moderator | Approve, reject or revoke. |

## Verified inventory deployments

The local demo and the default illustrative Sepolia deployment use advisory verification. For an authorized test with the contract gate enabled, create a fresh deployment with `npm run deploy -- --create --verified-inventory`, or deploy `ParkingAuctionEscrow(true)` on an isolated local chain. This mode cannot be switched on or off later. Do not list real inventory or fund real bookings based on this setting.

1. The deployment admin authorizes a separate reviewer wallet with `setSpaceVerifier(verifier, true)`. This does not grant dispute-resolution authority or access to funds.
2. The host calls `registerSpace()` and uses the `spaceId` from the mined `SpaceRegistered` event to submit the usual off-chain proof. The reviewer checks the current `spaceOwner(spaceId)` and `spaceOwnershipEpoch(spaceId)` against the proof they reviewed.
3. Maintain a private stall registry. Resolve spelling, address and unit aliases to the same record, distinguish separately controlled stalls at one property, and assign each genuine stall one random opaque 32-byte key. Never publish evidence, raw location identifiers, or hashes of guessable addresses as keys. The contract cannot independently tell whether two different keys refer to one real stall.
4. Review the exact public listing details as well as proof of control. Compute the same metadata hash as the listing form: keccak256 of the UTF-8 JSON returned by `JSON.stringify(validateSpotMetadata(details).normalized)` after validation succeeds. The deployer does not need to provide its key to the API.
5. Sign in with a wallet that is both an app moderator (`BIDPARK_MODERATORS`) and an on-chain verifier. In **My Activity → Moderation queue**, record **Approve** or **Revoke**, then choose **Check on-chain verification**. Inspect the owner and epoch. Enter the stall key (or reuse the bound key) and reviewed listing hash to **Sign on-chain approval**, or choose **Sign on-chain suspension**. The queue reports wallet and confirmation progress, then refreshes the chain state. A rejection or pending transaction does not change the off-chain decision or imply that bidding has changed. Check an unresolved transaction in the transaction center before sending another. On a gated deployment the public badge and bid availability come from the chain, not the queue.
6. The host or an authorized lister uses `createSpaceAuction` or `createProtectedAuction` with the approved `spaceId` and metadata hash. Quick creation that implicitly registers a new space is unavailable in this mode. Reviewing a new metadata hash pauses new bids on listings with the previous hash but does not free their windows or change their settlement rules.

The same key can never claim a second `spaceId` in that contract, even after suspension. Transfer keeps the key and calendar, drops the delegated listers, and clears approval; the new owner needs review. If a stall was bound incorrectly, suspend it and investigate rather than issuing another key to bypass its calendar. The registry must be reconciled separately on redeployment; a new contract does not see old calendars.

Suspension or lister revocation blocks new bids on affected open auctions. A prior high bid can still settle under the auction's existing rules. Existing reservations, refunds and payout rights are not rewritten; the normal cancellation and dispute rules still apply. A paused bidless auction holds its window until cancellation or its bidding cutoff, so re-approval cannot silently resurrect an auction on an already reallocated window.
