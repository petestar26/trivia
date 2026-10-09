# Sky Crash practice v1

A separate PlayQube aircraft game, based on the rising-multiplier mechanics researched in the public reference T&C. Original rendered aircraft and alpine scenery; no third-party logos, source, artwork, players or currency limits. The aircraft is a 3D-style bitmap rendered within SVG, not a runtime 3D mesh. Motion is decorative and reduced-motion preferences are respected.

## Release and financial boundary

Disabled by default. `SKY_CRASH_PRACTICE_ENABLED=true` is required independently on the API and group worker. Crash Point's flag cannot enable Sky Crash. The catalog entry stays inactive/COMING_SOON for wallet play, and the generic wallet-funded handler refuses Sky Crash even if an administrator changes catalog flags or currencies. The member catalog exposes the practice link only when the API explicitly returns `practiceAvailable: true`; a direct route remains subject to API authentication and gating.

Every account starts with 1,000 nonredeemable Sky Crash credits. They have no relationship to Crash Point credits, Coins, Game Points, deposits, gifts, transfers or withdrawals. No refill or financial launch is implemented. A depleted account cannot enter another ticket without sufficient balance.

## Published rules: sky-crash-practice90-v1

One epoch-minute round, with a 15-second admission window and results retained until the next minute. Two immutable ticket slots per member/round. Whole-credit stake 10–500; optional auto cash-out 1.01×–20.00× in 0.01× increments. Each confirmed slot is independent and uses the same round outcome. Multiplier growth: floor(100*exp(elapsedMilliseconds/10000)) in hundredths, capped at 2000 for cash-out.

A server-selected random 32-byte seed is committed with SHA-256(roundId + ':' + seed) before admission. Derive a uniform draw in 1..1,000,000,000 using SHA-256(seed + ':' + counter), rejecting unsigned first 32-bit words >= 4,000,000,000, then taking modulo 1,000,000,000 plus 1. Crash cents = clamp(ceil(90,000,000,000/draw),100,2001). These are OUR practice rules, not claims about the reference operator's undisclosed algorithm.

For an allowed fixed auto target c, survival is strictly crash>c, with exact probability (ceil(90,000,000,000/c)-1)/1,000,000,000. Gross expected return is approximately 90% before whole-credit rounding. A tie loses. Immediate crash at 1.00× has 10% probability. Maximum crash 20.01× permits an auto target 20.00× to win on the capped outcome. Payout=floor(stake*paidCents/100), including stake; no promise of session profit. The page independently recomputes the commitment and outcome after reveal. This checks consistency, not independent RNG certification or protection from malicious seed selection before commitment.

Manual cash-out uses database time after locks. Requests at/after the crash lose; a server auto target reached strictly before crash still settles at its target despite disconnection or delayed workers. Client amounts cannot change after admission; client timestamps, multipliers and payout amounts are never settlement inputs.

Autoplay: explicitly started per slot for at most 10 future entries, immutable stake/auto target, at most 10*stake committed per run (maximum 5,000 credits per slot; both slots share one balance). No doubling/progression. It stops on hidden tab, refresh, disconnection, stale data, insufficient credits or errors. Stop prevents future admissions but cannot cancel a sent/accepted ticket. Server auto settlement of an accepted ticket survives disconnects.

## Integrity and recovery

Dedicated sky_crash_accounts/rounds/tickets, separate round IDs, API paths, query keys and per-user/per-slot session receipts. Database constraints enforce immutable rounds and tickets, slots 1/2, payout/time validity and deferred balance conservation. Transactional locks serialize concurrent admission and settlement. An identical retry replays its receipt; changed payload conflicts. Active-account checks and authenticated user-derived ownership cover private reads/writes; automatic settlement does not strand already-admitted tickets when an account later becomes suspended. Public activity exposes round-specific pseudonyms and settled returns, never account IDs, future results or pending auto targets. No fabricated activity.

## Deployment preparation (not deployed)

Forward migrations 20261009010000_sky_crash_practice, 20261009010100_sky_crash_dual_tickets, 20261009010200_sky_crash_catalog. Historical migrations unchanged. Restricted staging-only owner script `staging-sky-crash-upgrade.ts` accepts only these pending migrations, checks existing migration checksums/owner/target, and grants only required practice-table rights (including column-level UPDATE(id) on immutable rounds for PostgreSQL row locking) to validated API and social-worker roles. It does not invoke broader financial grants or enable flags. `--verify` is read-only. Deploy API/web/worker from one reviewed commit after migration, then separately authorize practice activation on API and worker. All production/payment/wagering gates remain unchanged.

## Validation

Service and guard tests execute actual PostgreSQL expressions in PGlite (serialized). Native PostgreSQL tests cover simultaneous admission/payout, lock-wait cutoff, ownership, restart settlement, public-data boundaries, slot immutability and cross-game balance isolation. Route tests cover JWT/auth status, exact flag opt-in, authenticated ownership and bounds. UI tests cover both tickets, reconciliation/replay, autoplay immutability/stop, stale/offline disabling and separate receipt namespaces. Native PG13/16/18 runs are wired into CI; local evidence must identify its actual version. Real-device Safari remains a new-game acceptance item, separate from the prior PWA check.

The alpine background is above the default service-worker precache size limit and loads over the network. A dark arena remains readable if the decorative asset fails; the game itself requires a live server connection.
