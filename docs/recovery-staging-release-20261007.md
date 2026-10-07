# Recovery and security staging release — 2026-10-07

Implementation candidate: `1362cac628263474685db0030d6154dc357b2f58` (public GitHub), tree `4e59d642777f5afefe75e8d6de0da16a584d2a1a`. Local commit `e3fa7b7b82e111c6734a9d21626e7a8131fbfdd8` has the same tree. Public/local commit identities differ because publication used the connected GitHub API with an explicit parent and matching tree.

## Scope

- Separate late-payment support cases for expired/cancelled, uncredited deposit orders; member reporting, staff claim, mandatory case-specific authenticator verification and recording a verified full external refund. No money is sent and no Coins are credited by this workflow.
- Active-account checks for authenticated reads and normal actions; preserved narrow own-entry PVP reversal for suspended players, with no private reads or new play allowed. Financial withdrawal cancellation retains its existing ACTIVE-actor requirement.
- Exact currency minor units for recovery input/display; optional-auth identity clearing; production Secure cookies; generic JSON parser errors without submitted secret fragments; root React error recovery.
- Current-admin dispute claims and participant authorization before idempotent replay; explicit bounded input validation.

## Main files

| Change | Files |
|---|---|
| Recovery state and routes | `apps/api/src/agents/late-payment-service.ts`, `late-payment-routes.ts`, `apps/api/src/routes/index.ts` |
| Database models and guards | `packages/database/prisma/schema.prisma`, migrations `20261007020000_late_payment_cases` and `20261007021000_late_payment_guard_paths` |
| Owner migration rollout | `apps/api/src/scripts/staging-crash-point-upgrade.ts` |
| Recovery UI and independent retry scopes | `apps/web/src/pages/wallet-late-payments.tsx`, `wallet-payments.tsx`, `wallet-operations.tsx`, `apps/web/src/hooks/use-wallet-action.ts` |
| Auth, cookies and logging | `apps/api/src/middleware/auth.ts`, `error-handler.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/games/group-pvp/routes.ts` |
| Unexpected render recovery | `apps/web/src/components/app-error-boundary.tsx`, `apps/web/src/main.tsx` |
| CI and regressions | `.github/workflows/scheduled-rounds.yml`, migration upgrade inventory, native payment/social tests, current-permission and parser tests, scheduled practice HTTP fixtures, wallet recovery UI tests, socket/Crash Point test fixtures |

## Validation observed locally

- Complete web suite: **1,180 tests / 77 files passed**, final runtime candidate.
- API review unit suite: **263 tests / 27 files passed**.
- Scheduled practice suite: **38 tests / 4 files passed**, including JWT subject scoping and suspended-account rejection.
- API/web TypeScript checks and production builds passed.
- The new native PVP HTTP reversal test passed on PostgreSQL 13/16/18 at the preceding source-equivalent backend candidate; complete final-candidate evidence still comes from the final matrix below.

## CI and deployment evidence

Final exact-candidate run: https://github.com/petestar26/trivia/actions/runs/37580045106 . **SUCCESS**, completed on PostgreSQL 13, 16 and 18 for the exact candidate.

Target is isolated staging only: project `7c2fe63d-b734-4212-bd0b-45f01789879f`, environment `7de0c716-24df-4e97-a998-ed99abfa256f`. Production, live payment activation and PR merges are outside this rollout.

Owner migration deployment `a6a36182-9436-4274-9513-c9340a5f01db`: **SUCCESS** at the exact candidate. Runtime event `CRASH_POINT_STAGING_READY` at 2026-10-07T06:27:54Z listed both recovery migrations, mode PRACTICE and `financialPlay: false`. The helper verifies migration history and reapplies canonical runtime grants before emitting readiness. API deployment `f5319daf-4216-4948-8b2d-c1c2e8e5f3bc`: **SUCCESS**. Web deployment `1b0b2021-2a08-49b4-b044-9b7200f8b337`: **SUCCESS**. Both are pinned to the exact CI-verified candidate.

The dedicated isolated payment worker remains on its previously verified deployment `74a978a6-e2b3-4d4b-9d2c-ba6ea575f4ef`; repeated timeout/deposit/bonus sweeps were observed. The unrelated generic worker is not repurposed.

## Browser evidence

Before rollout, the existing member session loaded wallet request empty states and Crash Point, reconnected after refresh, retained its 1,000-credit practice balance with no tickets, and disabled entry controls after the window closed. After rollout, the new-version reload prompt loaded the updated app and preserved the member session and zero Coin balances. Wallet Requests displayed Late-payment recovery, the explanation that recorded external refunds do not add Coins, and the successful No recovery cases empty state. Deposit displayed all five crypto assets as provider-integration pending. Selecting Ethiopia displayed Payments are paused in this country, no approved agents, and disabled deposit creation. The administrator login route rendered its email/password form; the member session did not grant administrator access. No wager, financial transaction, refund submission or authenticator code entry was performed.

Admin browser verification requires a current administrator sign-in. Mock component tests and native database tests are not substitutes for that sign-in. Physical mobile/tablet testing remains unverified.

## Remaining release restrictions

Use `docs/opus-final-review-followup-20261007.md` for the complete unresolved-findings matrix and independent review instructions. In particular, provider settlement/crypto integration, approved destinations/rates/liquidity, late-payment incorrect/partial-claim workflows, direct-API CSRF review, media validation, financial capital and fee-ledger review, physical-device testing and operator rehearsal remain open. This is not a production-readiness approval.
