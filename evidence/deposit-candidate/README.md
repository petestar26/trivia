# Deposit candidate revisions on PR #81

| Candidate                        | Files | Manifest SHA-256                                                   | Where                                                                                                               |
| -------------------------------- | ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `v7-derived-typefix-1` (parent)  | 38    | `d0b678842e279fd1796c120f672d61befe67e6f58e3c25252ec7ffdea3e6b1ef` | Applied byte-exact as `b1f8049`; archive SHA-256 `de166e06c46400c82b5f14fbde2313b3b65863e55efffbc3950d2630633306fb` |
| `v7-derived-typefix-1-fixture-1` | 39    | `98bdd18441f915ff2941e996a02e8d72169f2b471d54b12a1d4726469b4c58fe` | Revision commit `c8e5b4b073d736b598e0363e25aebfd8f6b1e62e`                                                          |

The parent is unchanged: its 38 files still match its manifest at `b1f8049`, and the local
branch `candidate/v7-derived-typefix-1` was not modified. Its ongoing rehearsal applies to the
parent identity only.

Identity rule (same as the parent handoff): the exact base `a54696ebc3805108f25a9e1a6555dbada8252c6f`
plus the path/content hashes in `v7-derived-typefix-1-fixture-1.manifest.json`. Shell polish and
review evidence in the same branch are not part of either candidate.

## What changed in `v7-derived-typefix-1-fixture-1`

Test-only. No production code, migration, schema, database guard, ETB safeguard or existing
assertion changed.

- `apps/api/src/test/financial-policy-fixtures.ts` (modified): `mintTestPurchasedCoins` names
  its synthetic receiving method `Synthetic receiving method <per-call tag>` instead of one
  constant. All calls share the `ZLP` test country, so the constant name violated the
  `payment_method_definitions (countryId, type, name)` unique key from the second call on.
- `apps/api/src/agents/purchase-fixture-repeat.test.ts` (added, native): three calls in one
  database create three distinct approved receiving destinations on `ZLP`. Each order is stamped
  with approved revision 1 and has a matching immutable revision row. Each call credits exactly
  once. A duplicate `(country, type, name)` payment method is still rejected with `P2002`.

## Local verification (disposable PostgreSQL 16.15, loopback only)

Each run used a fresh `playqube_scheduled_throwaway` database with all 131 migrations deployed
twice (replay found nothing pending), and the same environment variables and disposable keys
as the CI jobs.

| CI step reproduced                                     | Parent fixture              | Revised fixture |
| ------------------------------------------------------ | --------------------------- | --------------- |
| `vitest run src/agents src/withdrawals` (payments)     | 182 of 643 failed, 11 files | 643/643 passed  |
| `vitest run --config vitest.together-native.config.ts` | 36 of 61 failed             | 61/61 passed    |

Every failure in the parent runs was the same `P2002` on `PaymentMethodDefinition`
`(countryId, type, name)`. The 182 parent failures are CI's 180 plus the two new regression
tests, which fail on the parent fixture as intended. The `Native ETB wallet requires ETB pricing
terms` messages in the logs come from passing negative tests such as `src/agents/config.test.ts`.

Also passed on the revision: API `tsc --noEmit` and `node build.js`; `vitest.review-unit.config.ts`
341/341; `vitest.deposit-safety.config.ts` 5/5; native `payment-readiness.native.ts` (23) and
`admin-account.native.ts` (7); ESLint and `git diff --check` on the changed files; Prettier on
the new test. The modified fixture file keeps the candidate's original formatting.

## CI on PR #81 at `46f2c25` (this revision)

- **Passed on 13, 16 and 18:**
  - `contracts`: every step. On 16 that includes the five steps previously skipped after the
    fixture failure: group/sportsbook regressions, Birr/admin/agent/reward contracts, rules
    and access checks, production builds, and interface languages with offline install.
  - `payments`, `regressions`, `capacity-layout`.
- **Passed on 13, 16 and 18 in `postgres`:** steps 1-28. That includes "Payment lifecycle,
  authorization and recovery", which failed before, and three steps that had never run: legacy
  API compatibility, predeploy runtime identity guard and ledger guard regressions.
- **Failed on 13, 16 and 18 in `postgres`:** step 29, "Fresh and populated migration
  regression" (`src/ledger/ledger-upgrade.migration.test.ts:447`). The suite's explicit
  forward-migration allow-list (`NOVEMBER_RELEASES`) does not include the candidate's
  `20261113060000_deposit_destination_revisions`, so its `beforeAll` guard fails and none of
  the 58 tests run. This omission is in `v7-derived-typefix-1` itself; the step was always
  skipped before. **Not fixed:** it changes an existing assertion's expected list outside the
  candidate and needs an explicit decision.
- **Skipped in CI after step 29:** steps 30-40.

## Local PostgreSQL 16 evidence for the CI gaps (not CI results)

- With `20261113060000_deposit_destination_revisions` temporarily appended to
  `NOVEMBER_RELEASES` (reverted, not committed), the migration regression passes **58/58**:
  fresh install, replay, populated upgrade and gate recovery.
- Steps 30-40, run with the CI commands on a fresh migrated database, all pass:
  - 30 Isolated financial admission, draw, settlement and refund: 70/70.
  - 31 Probe offline CLI entry: blocked as expected.
  - 32 Compiled practice worker lifecycle and restricted-role rehearsal: 4/4.
  - 33 Practice worker TypeScript contracts: clean.
  - 34 Scheduled practice web contracts: 422/422.
  - 35 Virtual Football web contracts: 603/603.
  - 36 Group game room and chat contracts: 245/245.
  - 37 Cookie session renewal contracts: 17/17.
  - 38 Production web build (`NODE_ENV=production VITE_API_PROXY=true`): OK.
  - 39 PWA navigation contracts: 30/30.
  - 40 Gateway and WebSocket contracts: 11/11.

These local runs cover PostgreSQL 16 only. PostgreSQL 13 and 18 for steps 29-40 remain unverified
until CI runs them.
