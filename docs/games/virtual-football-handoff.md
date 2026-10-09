# Virtual Football 3D — handoff to Astra

Independent review and finalisation package for **PlayQube Virtual Football 3D** (`virtual_football_3d`, route
`/games/virtual-football`, flag `VIRTUAL_FOOTBALL_PRACTICE_ENABLED`). This is a **candidate**. Nothing here has been merged,
deployed, enabled, run against a staging or production database, or accepted on a physical device. Local evidence,
CI evidence and live evidence are kept apart below; only the first column has happened unless the PR checks say
otherwise.

## 1. Where everything is

| Item                                      | Value                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout (this session's cloud container) | `/home/user/trivia`                                                                                                                                                  |
| Branch                                    | `claude/cool-tesla-1al2el` (the session mandates this name; the requested topic name was not used)                                                                   |
| Base (stacked on)                         | `fix/derby-full-results-and-presentation` @ `86ed8d1174287bea7a703135682ff9b0d33fafb7`, tree `efd36085b90de6de69b839d819880343979420fb`, PR #47                      |
| Pull request                              | draft, base `fix/derby-full-results-and-presentation`; link and exact-head check status are in the PR description and conversation (they change with every push)     |
| Head / tree                               | read with `git rev-parse HEAD HEAD^{tree}`; the PR description records the head it was written for                                                                   |
| Review order                              | `git log --oneline 86ed8d1..HEAD` is milestone-ordered: model → schema and guards → server → rig and poses → director → stadium and engine → UI → tests, CI and docs |

`git diff --stat 86ed8d1..HEAD` is about 90 files. Modified existing files are limited to: the CI workflow
(`scheduled-rounds.yml` steps and path filters), `apps/api/build.js` (worker/script entry), `game-catalog.ts` and its tests,
`routes/index.ts` (one registration), `group-worker-runtime.ts` / `group-pvp-worker.ts` (+ test, `FOOTBALL_PRACTICE` kind),
`staging-derby-upgrade.test.ts` (one added test; **the Derby script and its allowlist are untouched**),
`vitest.scheduled-native.config.ts`, the migration matrix test, `schema.prisma` (enum value), `packages/shared`
`enums.ts`/`index.ts`, `vite.config.ts` (PWA ignore), `pwa.test.mjs`, `member-game-catalog.ts`, the catalog cards
(`home.tsx`, `games/index.tsx`, `history.tsx`, `CasinoRendererSlot.tsx`, `game-artwork.tsx`) and `App.tsx` (one route).
Everything else is new and under `virtual-football` / `football` paths.

## 2. Documents

- [`virtual-football-3d.md`](./virtual-football-3d.md): specification — evidence boundary, timing, markets, outcome model, limits,
  privacy, rollout, member client.
- [`virtual-football-visual-assets.md`](./virtual-football-visual-assets.md): asset provenance and the honest limits of the
  procedural figures (no mocap, no third-party models, no guessed GLB).
- This file: review package.

## 3. What was built

- **Rules and model** (`packages/shared/src/virtual-football/`): 20 fictional clubs, deterministic 38-week double round-robin,
  5-minute cycle (230 s selections, 28 s first half, 4 s half-time, 28 s second half, 10 s results), 94 typed selections over
  19 markets (including European three-way ±1 handicaps), one finite outcome model that produces **both** the result and
  every price (score weights ≤ 6 goals, fair halves, uniform goal order, strictly increasing times; odds = ⌊90 ÷ probability⌋
  in hundredths, offered only within 1.10–1000.00), commit/reveal seeds, pure-TypeScript SHA-256 shared by server and browser,
  `verifyMatchweek`, elapsed-only `liveFixture`, derived standings (3/1/0; points, goal difference, goals for, wins, club id).
- **Database** (three forward migrations): enum value in its own migration (PostgreSQL 13-safe), then tables, guard functions
  and deferred constraint triggers, then an **inactive `COMING_SOON`** catalog row. Matchweeks can only be created inside their own
  selection window (missed weeks are never fabricated). Accounts, tickets, lines and legs are guarded: immutable receipts,
  balance and ticket-total integrity, one selection per fixture in a multiple, deadline enforced on the database clock.
- **Server** (`apps/api/src/games/virtual-football/`): `GET /games/virtual-football` (snapshot, optional season/week pair) and
  `POST /games/virtual-football/tickets`. Idempotent receipts (`UNIQUE(user_id, idempotency_key)`): the account row is locked
  first, the request hash covers ordered lines and shown prices, a repeat returns the same receipt even after kick-off, a
  changed retry is `RECEIPT_CONFLICT`. Strict parsing refuses unknown fields. Results are `NULL` in SQL until full time.
  Worker kind `FOOTBALL_PRACTICE` creates the open week and settles each ticket exactly once.
- **Web** (`apps/web/src/pages/games/virtual-football.tsx`, `components/football/`, `lib/football/`): server-clock UI, markets,
  slip (singles + multiples of 2–5, ≤ 8 lines), review dialog, receipts recovery, results with week navigation and in-browser
  verification, league table, tickets, rules, text match centre, optional sound, lazy 3D scene.
- **3D** (`components/football/engine/`): procedural skinned 19-bone humans with two-bone IK (planted studs in stance), pose
  library, stateless `directorFrame` (decorative play plus a 4 s goal sequence per released goal), stadium with striped turf,
  deformable nets, instanced crowd, 23 actors, a renderer with a 30 fps cap, DPR ≤ 1.5, hidden/off-screen pause,
  context-loss callbacks, deterministic `renderAt`. A dev-only lab (`/football-lab.html`) is excluded from the production build.

## 4. Hard constraints and where they are enforced

| Constraint                                                                | Enforcement                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Practice credits only: no Coins, no ledger/wallet writes                  | Separate `football_accounts`; the native test asserts the service never reads or writes a wallet, Coin, ledger or payment table and creates no wallet; least-privilege grants exclude every ledger table |
| Coin wagering paused regardless of catalog or flag                        | `virtual_football_3d` is in the unconditional pause in `game-catalog.ts` with tests                                                                                                                      |
| Flag exact `true`, default off                                            | `footballPracticeEnabled()`, `group-worker-runtime.ts`, catalog `practiceAvailable`; routes return 403 otherwise                                                                                         |
| Not purchasable, transferable, redeemable; no autoplay, cash-out, jackpot | None of these exist; stated in the rules dialog and spec                                                                                                                                                 |
| No licensed assets, marks, crests, API; no equivalence claim              | Original clubs, badges, kits, sponsors; spec §1                                                                                                                                                          |
| Reference screenshot never shipped                                        | Not in the repo; the catalog image is a render of this scene                                                                                                                                             |
| Derby's staging allowlist not broadened                                   | `staging-derby-upgrade.ts` unchanged; a test proves the football migrations are "unrelated" to it                                                                                                        |
| Applied migrations never edited                                           | Three new migrations only; the migration matrix test pins the parent set                                                                                                                                 |
| Native tests only on throwaway databases                                  | The native config needs `SCHEDULED_NATIVE_DB_ACK=throwaway` and a `*_throwaway` name                                                                                                                     |

## 5. Evidence

### 5.1 Local (this container, PostgreSQL 16 only)

| Check                                                                                             | Command                                                                                                                                                 | Result                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Shared football rules, model, schedule, ticket, standings                                         | `pnpm --filter @socialplay/shared exec vitest run src/virtual-football`                                                                                 | 79 passed (6 files)                                      |
| Shared package, all                                                                               | `pnpm --filter @socialplay/shared exec vitest run`                                                                                                      | 115 passed (10 files)                                    |
| API football unit set (admission, routes, privacy, staging script, catalog rules, worker runtime) | `pnpm --filter api exec vitest run --config vitest.football.config.ts`                                                                                  | 102 passed (6 files)                                     |
| API native football, PG16 throwaway                                                               | `… vitest run --config vitest.scheduled-native.config.ts src/games/virtual-football/football.native.ts`                                                 | 31 passed                                                |
| Migration matrix (fresh, replay, populated upgrade, gates, catalog row), PG16 throwaway           | `… src/ledger/ledger-upgrade.migration.test.ts`                                                                                                         | 56 passed                                                |
| Existing suites touched by shared edits                                                           | Derby / Sky Crash / Crash Point configs, `vitest.review-unit.config.ts`                                                                                 | 67 / 49 / 24 / 298 passed                                |
| Existing native suites                                                                            | Derby, Sky Crash, Crash Point, Group PVP, keno, dice, gifts, social, agents, rewards natives                                                            | see §5.4                                                 |
| Web football contracts                                                                            | `pnpm --filter web exec vitest run src/components/football src/lib/football src/lib/football-catalog.test.ts src/pages/games/virtual-football.test.tsx` | 85 passed (7 files)                                      |
| Web, entire suite                                                                                 | `pnpm --filter web exec vitest run`                                                                                                                     | see §5.4                                                 |
| Typecheck                                                                                         | `pnpm --filter api typecheck`, `pnpm --filter api typecheck:shared-boundary`, `pnpm --filter web exec tsc --noEmit`, shared `tsc --noEmit`              | clean                                                    |
| Lint                                                                                              | `eslint` on the football API and web paths                                                                                                              | clean                                                    |
| Web production build, PWA contract                                                                | `pnpm --filter web build`; `pnpm --filter web test:pwa`                                                                                                 | built; 25 passed incl. "renderer bundled, not precached" |
| API bundle                                                                                        | `pnpm --filter api exec node build.js`                                                                                                                  | built                                                    |

Measured model facts (see `model.test.ts`): minimum probability of any listed score 0.1002 %; maximum exact-score price 897.89×; 91–94
of 94 selections available per fixture; worst shortfall against the 90 % return target below 0.8 points (from the final
floor).

### 5.2 A full matchweek, locally (not CI, not staging)

A throwaway database (`vf_local_run`), the built API with `VIRTUAL_FOOTBALL_PRACTICE_ENABLED=true`, the group worker
and the Vite dev server were run on this machine. A scripted browser session built 4 singles and a multiple, **dropped the
response to the first confirmation** (the request reached the server, the browser saw a failure), recovered it with "Check
this confirmation", watched all 60 s of the match and the results, then verified results in the browser. The visible final
score (2–1) and each Won/Lost badge matched the database; the ticket (stake 50) returned 38 (21 + 17), the practice balance went
1000 → 988, the ticket total equalled the sum of line payouts, and there were **zero** `wallet_transactions`.
A second session in a 390 × 844 phone emulation (and 360 × 740) confirmed no horizontal overflow on any tab and that a focused stake
input stays visible when the viewport shrinks for a keyboard. This is emulation in Chromium, **not** an iPhone or Safari.

### 5.3 CI

PostgreSQL 13, 16 and 18 are exercised only by `.github/workflows/scheduled-rounds.yml` on the PR. The workflow now runs the
shared football tests, `vitest.football.config.ts`, the football native test and the web football contracts, in addition
to the migration matrix (which now includes the three football migrations). **PG13 and PG18 results do not exist locally.**
Read the PR checks for the current head; if the head moved, so did the evidence.

### 5.4 Notes on the local runs

- The native tests require the database to be named exactly `playqube_scheduled_throwaway`, and several of them leave state behind. Re-running
  the whole list against a database that already ran earlier suites produced two failures (`system-dice.native.ts`: the legacy Dice row had been
  left `AVAILABLE`; `payment-readiness.native.ts`: the synthetic recovery fixture already existed). Both are state leaks between runs, unrelated to
  football; both pass, as does everything else, on a freshly migrated database in the CI order. CI creates a fresh database per job.
- Counts above are for the head that was pushed with this document; the PR description names that head. A later push invalidates them until re-run.

## 6. Previewing it

- **Page** (needs the API with the flag and a worker): `VIRTUAL_FOOTBALL_PRACTICE_ENABLED=true` on the API and
  `node dist/scripts/group-pvp-worker.js`; `pnpm --filter web dev`; sign in; open `/games/virtual-football`. A matchweek only exists if it was
  opened in its own selection window (the worker does this). Use a throwaway database.
- **3D lab** (no API needed): `pnpm --filter web dev`, then
  `/football-lab.html?scene=match&t=8.9&goals=6000H&settle=1&key=vf-s1-w01-f05&home=5&away=14&hud=0` (other scenes: `rest`, `run`,
  `sprint`, `kick`, `keeper`, `celebrate`; `reduced=1` for reduced motion). It deliberately throws `lab:match-ready` after
  exposing `window.__lab`; that is not an error.
- **Motion**: `node apps/web/scripts/football-capture.mjs --out /tmp/vf --start 5.4 --end 10.4 --goals 6000H --key vf-s1-w01-f05 --home 5 --away 14 --video /tmp/vf/goal.mp4`
  renders the real engine at an exact clock, 1/30 s apart, then encodes with ffmpeg. It needs Playwright and (for `--video`) ffmpeg;
  neither is a project dependency. Short clips and screenshots from this session are in
  [`virtual-football-media/`](./virtual-football-media/).
- **A screenshot alone does not prove gait.** The foot-contact (no skating) and kick/dive contact assertions are in
  `poses.test.ts` and `director.test.ts`; the clips show motion, rendered in software, so they are **not** frame-rate evidence.

## 7. Migrations and grants

- `20261010010000_virtual_football_game_type` adds the enum value only (its own transaction, PG13-compatible);
  `20261010010100_virtual_football_practice` uses it; `20261010010200_virtual_football_catalog` inserts one inactive
  `COMING_SOON` row (`ON CONFLICT DO NOTHING`). Nothing is dropped or rewritten.
- Runtime grants are in `apps/api/src/scripts/football-runtime-grants.ts`: `SELECT, INSERT, UPDATE` on accounts, tickets and
  lines; `SELECT, INSERT` on matchweeks, fixtures and legs; `DELETE`, `TRUNCATE`, ledger tables and every other privilege are
  checked as **absent**. `staging-football-upgrade.ts` (guarded, disposable-rehearsal target only, `--apply` required) refuses any
  other pending migration, any super-user or bypass-RLS runtime role, excess privileges, and never sets a flag. It has not been
  run against any real database.
- Suggested rollout order (none of it has happened; the order is a recommendation, not something this PR performs): deploy code with the flag off → migrations → grants → verify with
  the staging command → flip the flag in an environment of Astra's choosing. Turning the flag off removes the route and stops the worker; data stays.

## 8. Findings, open questions and limits

1. **Prisma and deferred constraints.** An interactive transaction can swallow a deferred constraint error raised at commit.
   The service therefore forces `SET CONSTRAINTS … IMMEDIATE` inside the transaction for the football triggers. The same
   hazard may exist in other games; it was not changed here.
2. **Pre-existing failures** unrelated to this PR: 17 tests in `apps/api/src/games/games.test.ts` fail on the baseline for
   environment reasons (database name, approval-key requirements); they were not touched. The football catalog tests were added
   to `game-catalog-rules.test.ts`, which passes.
3. **Not verified here:** PostgreSQL 13 and 18; any staging or production database; any physical iPhone or Safari; real GPU
   performance or thermal behaviour; the guarded staging command against a real rehearsal database; the payments gateway.
4. **Figures are stylised mannequins**, not photoreal players. Between goals, play is a decorative function of the match key; it never
   feeds a result, price or settlement. If a more realistic look is wanted, it needs a licensed, rigged asset set
   (see the provenance doc), not a change to the model.
5. **Branch name**: the session requires `claude/cool-tesla-1al2el`; rename on merge if the original topic name is preferred.
6. The football renderer shares the already-precached Three.js chunk with Derby; only the football-specific chunk is excluded from precache.
7. Decisions left to Astra: when and where to run the staging command, the flag flip, whether the catalog row becomes
   `AVAILABLE` (it is deliberately not), and whether practice credits start at 1,000 (a product choice, see `VF_LIMITS`).

## 9. Deployment status

**None.** No merge, no deployment, no database outside this container, no flag set anywhere, no payment, wagering or Coin path touched.

## 10. Progress note (milestones as committed)

| Milestone                                | Commits (oldest first)                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 rules, outcome and odds model, schema | `d509d16` model, markets, schedule, tickets · `8c01424` schema, guards, catalog gate, spec                                                                                                    |
| M2 server                                | `ad7d961` admission, settlement, privacy, worker                                                                                                                                              |
| M3 3D and UI                             | `c21759f` rig, IK, poses · `cec1229` director · `8b6f30b` stadium, players, engine · `ac600ce` page, slip, markets, results, scene wrapper · sound and web tests · camera, kits, phone layout |
| M4 validation and handoff                | CI and migration matrix · formatting · media, docs, this package                                                                                                                              |

Order of work was risk first: the model and the database guards (where a mistake costs credits) before the server, the server before the UI, and the
renderer last, so the match view could never be allowed to influence a result.
