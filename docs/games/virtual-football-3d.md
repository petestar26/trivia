# Virtual Football 3D — practice specification

Game key `virtual_football_3d` · route `/games/virtual-football` · flag `VIRTUAL_FOOTBALL_PRACTICE_ENABLED`
(must be exactly `true`; default off) · rules `virtual-football-3d-practice-v1` · model `vf3d-score-model-v1`
· schedule `vf3d-schedule-v1`.

## 1. Evidence boundary

Reference inspected 2026-10-09/10 (public pages only):
<https://mohiogaming.com/games/virtual/virtual-football>, its French page and two news posts. They show broadcast-style
action with a score/minute overlay, a compact list of concurrent fixtures, pre-match odds and a countdown, league
standings, halftime scores and final-result tables; official text describes a twenty-team league, simultaneous
fixtures, a compressed matchweek and single/multiple selections; screens show ten fixtures. This is *Virtual Football*,
not the separate Flash Soccer or English Prime Football products, and none of their timing, video or jackpot features
are used.

Not public, therefore **not reproduced and not claimed**: the vendor's engine, RNG and probability tables, return
model, limits, tie-break rules and operator integration. A private demo requires vendor contact; none was made and no
proprietary API was used. PlayQube Virtual Football 3D is an **original game with the same broad mechanics**. It is not
MOHIO-equivalent, not certified, and uses no MOHIO media, marks or crests. A real MOHIO integration would be a separate
provider-integration task. The reference screenshot is evidence only and is not shipped.

## 2. Product

Free practice only. Each member has an isolated `football_accounts` balance that starts at **1,000 practice credits**.
Credits are non-purchasable, non-transferable and non-redeemable. There are no Coins, no financial-ledger writes, no
deposits, withdrawals, gifts, cash prizes, jackpots, cash-out or autoplay. The `virtual_football_3d` Coin-wager path is
paused unconditionally in `isCoinWagerPaused`, independent of catalog data and of the practice flag.

### 2.1 Five-minute server cycle (original PlayQube defaults, not vendor timing)

| Phase | Offset in cycle | Length |
|---|---:|---:|
| Selections open | 0 s | 230 s |
| First half | 230 s | 28 s |
| Half-time | 258 s | 4 s |
| Second half | 262 s | 28 s |
| Official results | 290 s | 10 s |
| Next cycle | 300 s | |

Cycle boundaries are multiples of 300 s after the anchor `2026-10-05T00:00:00Z`. Each phase is a half-open interval
`[start, end)`; at exactly kickoff the phase is *first half*, so admission is closed. All ten fixtures share the cycle.
There is no in-play admission. **The browser clock never admits a ticket or determines a score**: admission uses
PostgreSQL `clock_timestamp()` after the account lock, and every snapshot is cut at the database clock. The browser
only interpolates *presentation* between polls.

### 2.2 League, season and downtime

* 20 fictional clubs (`VF_CLUBS`), each with public immutable `attack` and `defence` ratings (100 = league average).
* One cycle = one matchweek. `index = (t − anchor) / 300 s`, `season = ⌊index/38⌋ + 1`, `week = index mod 38 + 1`.
  Identifiers: matchweek `vf-s{season}-w{NN}`, fixture `…-f{NN}` (slot 01–10).
* **Schedule** (`seasonSchedule`, pure function of the season number): (1) shuffle clubs with a public SHA-256-driven
  Fisher–Yates keyed by the season; (2) circle method for weeks 1–19, every club once per week and every pair once;
  (3) weeks 20–38 mirror weeks 1–19 with home/away reversed; (4) fixtures inside a week are ordered by a public hash so
  slot 1 varies. Result: 38 weeks × 10 fixtures, each of the 380 ordered pairings exactly once, home/away alternating
  by round so no club has more than three consecutive matches at one venue (tested for five seasons).
* **Standings** are derived from completed official results of one season only: 3 points a win, 1 a draw, 0 a loss.
  Order: points → goal difference → goals scored → wins → club name alphabetical (identical to ascending club id).
  This tie-break is original and deliberately simple; head-to-head is not used. A new season starts with zero standings
  and prior seasons stay readable through season/week navigation.
* **Standings are derived, never incremented.** There is no mutable counter table, so a result can neither be applied
  twice nor partially. Completed fixtures are immutable rows; repeated worker ticks, snapshots or restarts cannot change
  a table.
* **Missed matchweeks.** A matchweek is created (seed generated, commitment published, ten fixtures priced) *only
  during its own selection window*; the database guard rejects any insert outside `[opens_at, kickoff_at)`. If every
  API instance and the worker are down for a whole window, that week simply has **no row**: nothing is fabricated
  later, standings skip it (a club's *played* count counts real matches), and navigation labels it "not played".
  Catch-up after downtime is therefore bounded to (a) creating the *current* matchweek if its window is still open and
  (b) settling accepted tickets of already-played weeks in chronological order, 300 per tick. A downtime spanning
  week 38 into week 1 of the next season cannot repeat results, change a commitment or leak the previous season into
  the new table, because identities and the season filter come from the cycle index, not from wall-clock "latest".

## 3. Markets

Every selection has a canonical typed identifier validated against one catalog (`VF_SELECTIONS`, 94 identifiers).
Aliases, case changes, padding and unknown lines are rejected both by the shared parser and by a database regular
expression. All markets settle at full time on the official timeline.

| # | Market (key) | Selections | Notes |
|---|---|---|---|
| 1 | Full-time result `FT` | `FT:1` `FT:X` `FT:2` | |
| 2 | Half-time result `HT` | `HT:1/X/2` | settled at full time |
| 3 | Half-time/full-time `HTFT` | `HTFT:a/b`, nine | |
| 4 | Double chance `DC` | `DC:1X` `DC:12` `DC:X2` | |
| 5 | Match goals `OU` | `OU:{1.5,2.5,3.5}:{O,U}` | 3.5 is the explicitly priced extra line; 0.5 and 4.5 are not offered (price outside the window for most fixtures) |
| 6 | Both teams to score, full time `BTTS_FT` | `BTTS:FT:Y/N` | goal/no-goal and yes/no are one market |
| 6b | Both teams to score, first half `BTTS_HT` | `BTTS:HT:Y/N` | |
| 7 | Team goal/no goal `TG_H` `TG_A` | `TG:{H,A}:{Y,N}` | |
| 7b | Team goals over/under 1.5 `TOU_H` `TOU_A` | `TOU:{H,A}:1.5:{O,U}` | |
| 8 | Odd/even `OE`, exact total `TOT`, exact score `SCORE` | `OE:O/E`, `TOT:0..6`, `SCORE:h-a` (28) | 0 is even |
| 9 | First goal `FIRST` | `FIRST:H/A/N` | `N` for 0-0 |
| 10 | Result + both teams to score `FT_BTTS`; result + over/under 2.5 `FT_OU` | `FTBTTS:r:Y/N`, `FTOU:r:2.5:O/U` | |
| 11 | European handicap `EH_M1`, `EH_P1` | `EH:-1:r`, `EH:+1:r` | see below |

**European three-way handicap (original settlement choice).** The displayed signed handicap is *added to the home team's
score*, then the adjusted score decides 1 / X / 2. Home −1: `1` needs a win by two or more, `X` (the "handicap draw") is a
one-goal home win, `2` is a home draw or defeat. Home +1: `1` is a home win or draw, `X` is an away win by exactly one,
`2` is an away win by two or more. There are no pushes, voids or refunds: this is a three-way market, so the public
reference's vague handicap description (which does not define Asian-handicap pushes) is not implemented.

A selection is **unavailable, never invented**, when its exact probability is 0, or its derived price falls outside
1.10×–1000.00×. Across all 380 ordered fixtures 91–94 of 94 selections are available; the unavailable ones are the
shortest prices (for example "home to score" for a strong home side).

## 4. One finite outcome model

Everything — official results, live events and every price — comes from the same model; nothing is drawn per market and
3D physics never chooses a result.

1. **Full-time score.** Cells `(h, a)` with `h + a ≤ 6` (28 cells). The six-goal bound is an explicit practice
   simplification. Weight (positive integers, BigInt):
   `W(h,a) = 1000·P(h,a) + Σ P`, where `P(h,a) = λH^h · λA^a · 1000^(6−h−a) · (720/h!) · (720/a!)`, an integer scaling
   of an independent truncated Poisson with `λH = round(1450·atkH/defA)/1000`, `λA = round(1150·atkA/defH)/1000`. The
   additive `Σ P` term is documented **tail smoothing**: every cell has probability at least `1/(1000+28) ≈ 0.0973 %`
   (measured minimum over all 380 fixtures: 0.1002 %), so every exact score is priceable below the 1000× ceiling.
2. **Halves (the 50/50 rule).** Each of the `h + a` goals is independently placed in the first half with probability ½.
   Half-time score `(h1, a1)` has probability `C(h,h1)·C(a,a1)/2^(h+a)`, so half-time never exceeds full time.
3. **Order.** Inside each half the scoring sides are in a uniformly random order.
4. **First scorer.** First goal of the first non-empty half. `P(home first | h1,a1) = h1/(h1+a1)`; none for 0-0.
5. **Times.** Strictly increasing within a half, on a 500 ms grid, at least 1.5 s from each half boundary and at least
   4 s apart (first half 1.5–26.5 s, second half 33.5–58.5 s after kickoff). Times affect no market, so pricing needs
   only `(full time, half time, first scorer)`; they exist for the broadcast.

**Exact enumeration.** `buildDistribution` lists the 295 reachable atoms `(FT, HT, first scorer)` over the common
integer denominator `ΣW · 64 · 60` (64 = 2⁶ half assignments, 60 = lcm(1..6) for the first-scorer ratio). A selection's
probability is the exact sum of its atoms. Tests prove, with exact BigInt arithmetic and for several fixtures: atoms sum
to the denominator; every partition market sums to exactly 1 (and double chance to exactly 2); an independent
enumeration of the feasible outcomes is *identical* to the model atoms (295); exactly one selection of each partition
wins for every possible outcome; and the generator's empirical frequencies match the model within 5σ.

**Prices.** `oddsCents = ⌊90·D / N⌋` for probability `N/D` (hundredths, stake included), i.e. a 90 % return factor with
rounding down. Therefore `0.90 − p/100 < p·odds/100 ≤ 0.90` for every offered selection (measured worst shortfall
across all 380 fixtures: 0.80 percentage points). Winning returns are `⌊stake · Π odds / 100ⁿ⌋`: one floor, whole credits.
**Compounding:** a multiple multiplies independent legs, so its expected return is `Π(pᵢ·oᵢ/100) ≤ 0.9ⁿ` — 81 % for two
legs and 59 % for five — strictly lower than any single. This is stated in the member-facing rules.

## 5. Tickets, receipts and limits

A *ticket* is a bundle of 1–8 independent *lines*, each a **single** (1 selection) or a **multiple** (2–5 selections,
**one per distinct fixture of the same matchweek**, so correlated same-match markets are never naively multiplied), each
with its own stake. Total stake is debited atomically.

| Limit (UI + rules + database) | Value |
|---|---:|
| Line stake | 5–500 whole credits |
| Ticket stake | ≤ 1,000 |
| Lines per ticket | ≤ 8 |
| Selections per multiple | 2–5 |
| Selections per ticket | ≤ 20 |
| Tickets per member per matchweek | ≤ 10 |
| Single-selection odds | 1.10×–1000.00× |
| Combined multiple odds | ≤ 10,000.00× |
| Return per line | ≤ 50,000 |
| Return per ticket | ≤ 100,000 |

Duplicate legs, contradictory shapes (single with two selections, multiple with one or six, two selections from one
match), duplicate lines, stale fixtures (another matchweek), impossible/unavailable selections and moved prices are
rejected **before debit**. A limit breach is a refusal; a winning return is never silently capped.

* **Idempotency.** `UNIQUE(user_id, idempotency_key)`. The request identity is the SHA-256 of canonical JSON over the
  matchweek, rules id and the ordered lines (kind, stake, each leg's fixture, selection and *shown* price). An exact
  retry — including after kickoff — returns the same accepted receipt with no second admission or debit. The same key
  with any change returns `409`; a pending request is never silently replaced.
* **Receipt** (`football_tickets`, immutable): request hash, receipt hash (request + rules digest + each fixture's
  *offer digest* + totals), rules id/digest, line/leg counts, stake. Lines and legs are immutable and carry the exact
  priced odds product. The client sends the price it saw; the server recomputes it from the fixture's stored strength
  parameters and refuses a mismatch (`PRICE_CHANGED`). Client odds/payout fields are never trusted.
* **Settlement** (per ticket, atomic, exactly once): lock ticket → lock account → set each line payout → set the ticket
  return and `settled_at = full_time_at` → credit the balance → flush deferred checks. Concurrent workers, retries,
  crashes and member snapshots converge on the same rows. Accepted tickets settle even if the member is suspended,
  because settlement needs no member session.

## 6. Commitment, privacy and verification

* Per matchweek the server draws a 256-bit seed with `crypto.randomBytes`. Each fixture uses an independent stream:
  `fixtureSeed = SHA256(domain | fixture-seed | matchweek | fixture | matchweekSeed)`, so fixtures are independent (a
  prerequisite for multiple pricing) and one fixture's stream never reveals another's.
* `fixtureCommitment = SHA256(domain | fixture-commitment | model | fixtureId | offerDigest | fixtureSeed)` binds the
  fixture identity, the model version, the public strength parameters and every offered price (via the offer digest) and
  the seed. `matchweekCommitment` hashes the ordered fixture commitments with the rules digest. Both are stored before
  the first ticket can exist and published in every snapshot. Changing a parameter after the fact changes the commitment.
* **Before full time** snapshots contain only elapsed goals and the current score: no future goal times, no final score,
  no seed, no script, and nothing derived from unreleased events. `liveFixture(goals, elapsed)` is the only function
  used to build a fixture view, and a non-interference test shows its output is identical for any two timelines that
  agree on the already-elapsed events. Elapsed goals *are* shown when they occur, and the public six-goal bound permits
  ordinary deductions from the current score — that is expected. The same rule applies to reduced-motion, fallback and
  replay renderings.
* **At full time** the matchweek seed is revealed. `verifyMatchweek` (shared, pure TypeScript, also used in the
  browser) recomputes every fixture seed, commitment, offer digest and timeline and compares them with the stored
  results. Pure SHA-256 is verified against `node:crypto` in the tests.

## 7. Rollout and safety

* Flag: `VIRTUAL_FOOTBALL_PRACTICE_ENABLED === 'true'`, exact, default off, gates routes, public practice availability
  and the worker alike. It is independent of every other game's flag and of every financial gate.
* Migrations (forward only, PostgreSQL 13+): `20261010010000_virtual_football_game_type` (enum value only),
  `20261010010100_virtual_football_practice` (tables, guards), `20261010010200_virtual_football_catalog` (inactive
  `COMING_SOON` row). Runtime grants and the guarded staging command are described in
  [`virtual-football-handoff.md`](./virtual-football-handoff.md).
* Local, CI and live evidence are different things; this document asserts none of the staging, device or
  production acceptance steps has happened.
