# Dormant Spin Win: future beacon and bounded recovery

This phase adds an explicitly selected randomness protocol and an owner-operated
recovery command. It does not enable Coin wagering, create financial streams,
start a financial worker, change payouts, or implement other game adapters.
The runtime API and worker must never receive the owner connection.

## Protocol

Historical rounds keep `sha256-rejection-u32be-v1`, their seed commitment,
outcome and cancellation audit. New rounds can explicitly select
`sha256-quicknet-rejection-u32be-v2` before their first accepted ticket. A round
cannot change its protocol after preparation. There is no fallback between them.

The new protocol pins the drand quicknet chain:

- Chain hash: `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`.
- Scheme: `bls-unchained-g1-rfc9380`.
- Genesis: `1692803367000` epoch milliseconds; round 1 occurs at genesis.
- Period: 3 seconds. The selected beacon is the first scheduled event strictly
  after the immutable betting cutoff plus 6 seconds.
- Public key and chain metadata are fixed in shared `spin-win-proof.ts` and
  re-exported by `round-entropy.ts`, sourced from
  the exact `drand-client@1.4.2` release. A relay cannot supply replacement pins.

The database transaction stores the future target and seed commitment before
admission. The seed is private until draw. Proof import accepts an explicit
beacon JSON object (`round`, `signature`, `randomness`) and verifies the BLS
signature offline with the official client. Before verification, it requires
canonical compressed non-infinity G1 bytes (including x below the field modulus).
Alternate encodings are rejected, never normalized, because randomness hashes
the exact signature bytes. It does not fetch a URL, choose the
latest beacon, or trust a stored `verified` flag. Import is one-time and occurs
only after the pinned beacon time according to the database clock.

Draw hashes the domain, round ID, immutable rules ID, committed seed, chain hash,
beacon number, beacon randomness and rejection counter. The first big-endian
32-bit word below `4294967289` is reduced modulo 37. At most 128 attempts are
allowed; exhaustion refuses the draw. SQL and TypeScript use the same encoding.
Tickets, stakes, house exposure and past winnings are not entropy inputs.

Draw, direct ticket settlement and recovery verify persisted beacon signatures
again. I21 checks SQL proof identity and lifecycle; I22 verifies recorded BLS
proofs in pages of 100 and verification batches of four. Invalid records fail
the invariant scan. A large history may require more scan time; this dormant
implementation does not provide a production scan-throughput guarantee.

## Delays and interrupted execution

If the expected beacon is unavailable, the round remains OPEN with its existing
stake holds and capital reservation. New admission still stops at the original
cutoff. A transport failure does not prove the beacon is globally unavailable.
The command waits for the same signed event and never uses local randomness or
another beacon. New-protocol rounds cannot be cancelled or automatically
refunded, preventing outcome-dependent void selection through these commands.

This intentionally leaves a sustained outage unresolved. An outage SLA,
customer communication and an independently reviewed terminal-outage policy
are activation prerequisites. Do not accept live stakes on this dormant design.

Once a draw is stored, recovery processes up to 100 pending tickets per call
(default 10), ordered by ID. Each ticket has its own atomic settlement. If one
fails, prior committed results remain and the command reports its ID; after the
blocker is repaired, another invocation starts with the remaining HELD tickets.
Concurrent coordinators reuse the existing settlement idempotency locks.
Only rolled-back serialization/deadlock failures receive bounded retries.

Existing seed-only CANCELLED rounds can recover their stored refunds. The
command does not create cancellations. An empty, unprepared legacy round can
still be manually cancelled without trying to derive a nonexistent seed.

## Owner commands

Apply all migrations and run the documented runtime-role setup after deployment.
The forward migration installs the new grants wrapper and denies runtime writes
to beacon pins. The prior grants entry point is renamed and remains owner-only.
No historical migration is edited. Pin records are public metadata; unrevealed
seeds remain in the separate owner-only table.

Use an independently configured owner process with only
`HOUSE_FINANCIAL_OWNER_DATABASE_URL` for the connection. There is no
`DATABASE_URL` fallback and no requirement to provide API JWT secrets.
Do not put a URL or secret directly in shell history.

```sh
# Build once using the repository's pinned pnpm version.
pnpm --filter api exec node build.js

# Read-only status by default.
node apps/api/dist/scripts/house-round-recovery.js --round=STREAM:SEQUENCE

# While the already-created dormant round is OPEN, before any ticket:
node apps/api/dist/scripts/house-round-recovery.js --round=STREAM:SEQUENCE --run --prepare-beacon

# Supply a saved response for the EXACT previously pinned quicknet round.
# This imports the proof, then runs one bounded recovery batch.
node apps/api/dist/scripts/house-round-recovery.js --round=STREAM:SEQUENCE --run --beacon-proof=beacon.json --limit=10

# Resume remaining tickets without changing target, proof or outcome.
node apps/api/dist/scripts/house-round-recovery.js --round=STREAM:SEQUENCE --run --limit=10
```

Proof input must be a regular file of at most 64 KiB. The CLI opens it without
blocking on FIFOs, checks the opened descriptor, and reads at most 65,537 bytes
to detect growth beyond the limit. Pipes and devices are rejected. Exit 0 includes successful read-only status,
waiting, completed replay and a successful batch; inspect `phase`, `pending`
and `hasMore` instead of interpreting exit 0 as a fully settled round. Exit 1
means blocked; exit 2 means invalid arguments/configuration. Failed batches
report only deliberate progress metadata, never database error text or secrets.

## Trust boundaries and remaining release work

The six-second offset assumes a correctly synchronized database clock. Monitor
clock drift and beacon timing, and stop admission if the approved drift bound
is exceeded. Such production monitoring is not implemented here.

SQL validates identities, times and the signature's SHA-256 hash; it does not
perform BLS pairings. The application import/draw/settlement and I22 provide
cryptographic verification. A database owner can modify functions or bypass
triggers, choose to withhold processing, or fabricate raw SQL history. This
change does not make that privileged operator harmless.

Before activation, publish and independently retain each round's protocol,
cutoff, seed commitment and beacon target before admission; provide player
verification and monitoring; reconcile actual house backing; verify the target
owner/runtime split; review the outage policy, jurisdiction and admission
controls; and complete an independent release review. The public commitment
endpoint, receipts and player verifier UI are documented in
[public-spin-proofs.md](public-spin-proofs.md). They establish consistency, not
independently witnessed publication time. External acknowledgement,
receipt-bound admission and an unattended financial scheduler remain separate
work. The 90% RTP and payout caps remain unchanged.

## Verification

The pure suite includes a real quicknet round-1 signature and independent draw
vectors, altered proofs, invalid inputs and rejection sampling boundaries.
A synthetic-key regression demonstrates two encodings accepted by the installed
BLS dependency and verifies that the application rejects the non-canonical one
before pairing. It substitutes only the public key in the test adapter; the
production quicknet key remains fixed. File regressions cover FIFOs, devices,
the exact size boundary, and growth after the size check.
Native tests use isolated throwaway databases. To exercise the historical
public beacon without a live network dependency, one fixture transplants only
its immutable timing metadata under transaction-local replica mode; import,
draw and settlement then run with all guards enabled and real BLS verification.
The invalid-proof fixture shows that SQL shape/hash acceptance alone is not
cryptographic validation and verifies I22/draw refusal.

Recovery tests cover partial commits, resume, concurrency, stored refunds,
permission refusal and default read-only behavior. The upgrade test deploys the
exact checksummed merged seed-only migration set, proves historical draws and
customer fingerprints survive the new migration, verifies setup and replays.
CI runs the scheduled ledger matrix on PostgreSQL 13 and 16.

Protocol sources:

- https://docs.drand.love/docs/specification/
- https://github.com/drand/drand-client/blob/ef8c9260294f8699b5e8c27a6b764f8f0d768bea/lib/defaults.ts
- https://github.com/drand/drand-client/blob/ef8c9260294f8699b5e8c27a6b764f8f0d768bea/lib/beacon-verification.ts
