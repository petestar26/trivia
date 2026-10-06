# Crash Point practice v1

Original Ruby Grand graph presentation inspired by the publicly described rising-multiplier/cash-out mechanic at https://eg1xbet.com/en/games/crash-point. No operator branding, proprietary artwork, timing, or payout formula is copied. No live reference session or third-party RNG certification was verified.

## Release boundary

Practice only. Dedicated 1,000-credit accounts have no relationship to Coins, Game Points, deposits, gifts, transfers, or withdrawals. The catalog row stays COMING_SOON/inactive for financial play. The public client has a practice route. API and independent scheduler are explicitly gated by CRASH_POINT_PRACTICE_ENABLED=true. Crash PVP is not available; a pool-funded contest requires separate rules.

## Rules and outcome

An epoch-minute round opens for 15 seconds, then its multiplier grows as exp(elapsedMs / 10000). One ticket per player/round, integer stakes 10–500. Optional auto target is an integer hundredth multiplier from 101 to 2000, persisted with admission. Amounts and targets cannot change afterward.

The server uses a random 32-byte seed. SHA-256(seed + ':' + counter) is rejection-sampled from its first unsigned big-endian 32-bit word, accepting values below 4,000,000,000 and mapping modulo 1,000,000,000 plus one. Crash cents are clamp(ceil(90,000,000,000 / draw), 100, 2001). For a fixed allowed auto target c, survival probability is floor(90,000,000,000 / c) / 1,000,000,000, up to the vanishingly small exact-divisibility boundary; gross expected return is approximately 90% before credit rounding. An outcome equal to the target loses. Individual returns are floor(stake * paidCents / 100); small stakes have a larger rounding effect.

Flight terminates no later than 20.01x. Manual and automatic returns are capped at 20.00x. This leaves valid max-target auto cashouts before the terminal cutoff. Results remain visible until the next minute. There is a 1.00x immediate-crash probability of 10%.

Manual acceptance uses database processing time after round, ticket and wallet locks. Client timestamps, multiplier, outcome and payout are never accepted. Cash-out at/after crash time loses even without a scheduler tick. Automatic settlement takes priority once its persisted target was reached before the crash, regardless of client connectivity or later worker delays.

## Persistence and integrity

Round seed/outcome/commitment are immutable. Ticket uniqueness, immutable fields, exact payout checks, cutoff checks and deferred account-vs-ticket balance constraints run in PostgreSQL. One transaction transitions the ticket and credits its practice account. Retry returns the saved receipt. Tick and snapshot recovery settle pending tickets from the original round, never rerolling. Snapshot reads lock the account while reading the wallet and receipts. Pending browser entry receipts preserve the exact admission payload through interrupted requests.

The public snapshot reveals neither seed nor crash point until database time reaches the crash. Commitment is SHA-256(roundId + ':' + seed). The browser verifies commitment and recomputed crash result after reveal. This is a seed-commitment check, not independent entropy certification or protection against a malicious operator who chose a seed before commitment.

## Visuals and accessibility

SVG curve with an extruded trail, dimensional CSS floor, ruby glow, rose-gold controls and accessible text. No WebGL requirement or raster game assets. Responsive stacked controls, keyboard focus states and reduced-motion beacon. Only server receipts confirm returns; interpolation is decorative, and inputs/manual cash-out pause on stale or unavailable data.

## Deployment

Forward-only migrations:
- 20261006190000_crash_point_practice (enum and guarded tables)
- 20261006190100_crash_point_catalog (dormant financial catalog row)

On the explicitly disposable staging setup service run node apps/api/dist/scripts/staging-crash-point-upgrade.js --apply. It checks the target, owner, prior checksums, allowable pending migrations and runtime roles, then grants only SELECT/INSERT on rounds and SELECT/INSERT/UPDATE on practice tickets/accounts. Run --verify afterward. It requires the existing SOCIAL_WORKER_DATABASE_URL, not the narrow Spin entropy worker role. Deploy API, web and group-pvp worker from the same reviewed commit. Enable CRASH_POINT_PRACTICE_ENABLED on API and group worker only after the upgrade succeeds.

For other environments apply these migrations as database owner and grant the dedicated runtime roles equivalent limited access. This staging script refuses other targets. Financial launch requires a separate capital/exposure model, independently reviewed randomness/publication policy, configured wallet integration and jurisdiction-specific approval.

## Verification

PGlite tests execute the actual service SQL and PostgreSQL triggers but serialize transactions. The native CI test suite uses acknowledged disposable PostgreSQL 13, 16 and 18 databases for concurrent entry, concurrent payout, cutoff after wallet-lock wait, ownership, missed worker, automatic restart recovery and immutable-history guards. React tests cover entry payload, cash-out payload without a client multiplier, interrupted admission replay, restored receipts and disconnected availability. Full web tests/typecheck/build cover surrounding navigation.
