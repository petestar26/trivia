# Roulette Keno practice

Salem's original implementation uses a 72-number board and an 18-number draw, inspired by the public MOHIO product overview at https://mohiogaming.com/games/lotteries/roulette-keno. No vendor code, images, branding, licensed media, or proprietary payout table is included. The wheel and card are original SVG artwork with dimensional shading; this is not a WebGL simulation or a licensed MOHIO integration.

## Published rules: roulette-keno-90-v1

- Server rounds last 90 seconds. Entry closes after 60 seconds, followed by 18 one-second ball reveals and 12 seconds for results.
- Node's cryptographic random generator chooses 18 distinct numbers without replacement, using a partial Fisher–Yates shuffle. No future ball is returned in a snapshot.
- Number bets select 1–10 numbers. The specified amount applies to each number. Each match anywhere in the 18-ball draw returns 3.6 times its amount.
- All other markets use only the first ball: red/black, odd/even and low/high return 1.8 times the amount; six rows return 5.4 times; four columns return 3.6 times. The first-ball scope is stated above the controls, in the confirmation, and in the rules.
- Rows are A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Columns are 1–18, 19–36, 37–54, 55–72. Red numbers use the usual 18-number European red set twice, with the second set shifted by 36; the other numbers are black. Color is not equivalent to odd/even.
- Stakes are whole practice ETB in steps of five. A bet totals at most 500 ETB. Ten independently confirmed bets are allowed per user per draw. No automatic repeat, edit, cancellation, or jackpot.
- Returns include the stake. Every supported selection has a mathematical expected gross return of 90%. Returns settle after the final reveal. This is practice math, not a certified real-money game.

## Persistence and isolation

`rk_accounts`, `rk_rounds`, and `rk_tickets` contain only non-redeemable practice balances and receipts. A new account starts with 1,000 practice ETB. No cash-wallet, payment, provider, gift, or game-point balance is read or credited. The catalog key is `roulette_keno`; cash admission is unconditionally paused even if catalog state is changed.

Admission validates active membership and uses database round and account locks, a unique round/user/slot receipt, and cutoff checks after acquiring locks and immediately before commit. Identical retries return the existing receipt without another debit; altered requests for that slot fail. Database triggers validate selections, immutable outcomes, exact returns, append-only history and balance conservation. Worker retries are bounded and settlement locks the account and receipt before paying once.

The browser stores an unresolved request before posting. A refresh checks server receipts; uncertain requests can only retry the same payload. Confirmed choices remain highlighted and locked. Stale or failed polling, unsupported rules, exhausted balances and storage failures stop admission. Payouts and balance changes cannot disclose unreleased results.

## Deployment

The forward-only migration creates the isolated tables and catalog row. If Salem's marked restricted practice worker role already exists, it grants SELECT/INSERT/UPDATE on only the three new tables; unexpected privileged or unmarked roles are refused. No new roles, passwords, broad default grants, financial privileges, or deployment command changes are introduced. The provisioning allowlist includes the new practice tables for future checks.

Deploy migration/API first, then the worker with `ROULETTE_KENO_PRACTICE_ENABLED=true`, then the web client. The API uses the same flag. Worker health includes the new draw loop. The game route is `/games/roulette-keno`.

## Validation

Focused service tests run the migration and actual SQL in disposable PGlite databases: draws, all market calculations, ten tickets, duplicate retries, insufficient balances, active-account and cutoff checks, database guards, restricted grants, hidden future balls, and a full timed settlement. Cash-wallet sentinels stay unchanged. PGlite serializes connections, so this does not constitute native PostgreSQL contention testing.

Authenticated route tests cover gates and schema checks. UI tests cover selection visibility, all market coverage, separate drafts, review, immutable confirmed bets, draw history, insufficient funds, stale updates, receipt recovery, exact retry and storage failure. Desktop and 320/375-pixel layouts are checked with local fixture accounts. No production bet or real-money transaction is performed for QA. Physical-device performance remains unmeasured.

The API typecheck also required explicit `string` types on the existing Derby/Dog Racing rules-ID parameters; this changes no runtime math or outcomes.
