# Shared live group rounds — 6 November 2026

## Member journey

A group member can watch directly in the group alongside chat, or open the full round. Watching has no wallet or entry requirement. Each player chooses and explicitly confirms their own published terms; the server alone determines whether an entry is accepted. The original deadline, capacity, fees and prediction rules remain unchanged.

New practice rounds publish presentation version 2 and their game duration in their accepted terms. At the fixed cutoff the existing engine locks the funded roster and verifies the pinned public randomness. It commits the outcome, private recording and one immutable schedule together. All viewers follow the same five-second countdown and full game. Results and proofs become public at the finish; payment commits automatically afterward. If payment is pending the interface says “Game finished—confirming payout.” Personal replay never changes the round or wallets.

| Game | Shared game duration | Progress shown |
| --- | ---: | --- |
| Spin Win | 20 seconds | Shared numbered player wheel; winner at finish |
| Turbo Keno | 44 seconds | Released draw balls |
| Dice | 40 seconds | Each accepted entry's two dice |
| Number Challenge | 18 seconds | Shared target reveal |
| Roulette Keno | 40 seconds | Released draw balls |
| Lucky Six | 72 seconds | Released draw balls |
| Thunder Derby | 45 seconds | Eight authored 3D horses, released positions |
| Neon Hounds | 32 seconds | Eight authored 3D greyhounds, released positions |
| Football Predictions | 90 seconds | Three concurrent matches, released scores, existing scene |
| Blackjack | 54 seconds | Six automated hands and dealer, card by card |
| Sky Crash | 42 seconds | Shared flight, locked target, result at finish |
| Crash Point | 42 seconds | Shared flight, locked target, result at finish |

Football remains a three-match prediction contest; Blackjack remains automated-hand predictions. Crash targets are chosen before betting closes and do not offer live cash-out. The existing pooled settlement and profit fee calculation are authoritative for every game.

## Authority and disclosure

- Existing economic states remain OPEN → LOCKED → DRAWN → PAID/REFUNDED. DRAWN now spans playback for version 2.
- Database guards pin versions/durations and prohibit late acceptance, altered terms, redraws, changed schedules, early terminal transitions and early entry closure. Outcome-based tie/no-winner refunds also wait until finish.
- API snapshots are explicit public DTOs. Before finish, outcome, proof, final ranking, settlement and future recording events are withheld. Wallet credits happen only in settlement. Downloads use the same public snapshot.
- Durable outbox events contain only round ID, revision and sequence. Delivery rechecks current account status, token version, session expiry and membership/participant authority. Clients recover with authorized snapshots after gaps/reconnects; polling remains available.
- Browser time uses server timestamps, request latency correction and a monotonic clock. A stale connection freezes to the last observed state. Reduced motion never skips to the ending. Lightweight views and renderer failure fallbacks use the same released facts.
- Horse/dog motion interpolates already released checkpoints. No standalone solo race, wallet or random outcome generator is mounted. Football receives only already released scores.
- Existing active-round uniqueness prevents overlap through playback. Accepted participants keep direct receipt/round access after the group closes or they leave. Neither viewer attendance nor owner availability controls settlement.

## Durable processing and least privilege

`play_together_jobs` provides per-round leases, bounded four-job concurrency, lease renewal and retry scheduling. A failed job does not stop healthy jobs. Transactional row locks, payload-bound receipts and ledger witnesses remain the exactly-once authority. `play_together_workers` and the administrator health endpoint expose worker readiness, delayed work and outbox backlog.

The new `shared-round-worker` is a separate Railway service in the same environment. Its new NOINHERIT database identity is registered by the database owner through `grant_together_practice_worker`. It can recover practice obligations, but cannot admit entries, read password hashes, update cash balances or access economic operations. Deferred database guards require exact entry-backed practice credits and reject unbacked points. The existing `practice-games-worker` is not modified or given additional privileges.

The API retains authorized socket dispatch. Setting `PLAY_TOGETHER_WORKER_MODE=external` delegates economic processing to the dedicated worker. The independent service needs `SHARED_ROUND_WORKER_ENABLED=true`, its restricted `DATABASE_URL`, `PORT`, and separate non-authenticating configuration secrets required by the shared configuration package. It exposes only `/health`.

## Additive migrations and rollback

1. `20261106030000_together_live_timeline`: versioned schedule/recording fields, guards, durable stream/events/jobs/heartbeat tables. Old terms hashing and old paid presentations remain compatible. Only existing active rounds receive jobs; historical rounds are not rewritten.
2. `20261106031000_together_practice_worker`: owner-controlled restricted-role grants and practice-only ledger/scope guards.

The release is practice-first. Cash and provider sportsbook gates remain disabled. `PLAY_TOGETHER_LIVE_PRESENTATION_ENABLED=false` stops creation of new v2 rounds while leaving already accepted v2 obligations understood by the current engine. Keep the new API/worker engine running until those rounds settle. Do **not** revert to an old engine that cannot process v2 or remove the additive migrations. Prefer a forward repair while retaining immutable schedules and commitments.

Before replacing the API, verify the existing `/data` persistent volume, inventory uploads, and write a uniquely named canary through the storage provider. Verify its checksum after replacement, then remove only that canary. Never treat pre-existing missing media as restored by this procedure.

## Verification boundaries

Use only the explicitly acknowledged loopback `playqube_scheduled_throwaway` database for native fixtures. `live.native.ts` exercises real PostgreSQL constraints, locks, ledgers and worker recovery with synthetic external entropy. The production-preview browser script uses synthetic accounts/responses and is not authenticated live acceptance. Deployed acceptance must use separately designated disposable practice accounts, genuine authentication and actual provider-independent public randomness; no customers or cash bets.

See `release-evidence.md` for exact completed checks, corrections, deployment identities, scoped live acceptance and remaining limits.
