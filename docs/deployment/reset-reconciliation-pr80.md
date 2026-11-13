# Password-reset changes: PR #77 versus PR #80

Status: comparison only. Neither branch is merged into the other, nothing is
applied, and PR #77's reset changes stay dormant.

## Exact heads compared

| | Branch | Head | Base |
| --- | --- | --- | --- |
| PR #77 | `claude/confident-bell-0o4zd4` | `aca6fac7a64a6d2bd5407bcc2d0ff9af26d1a1e8` (plus the documentation and test commit that adds this file) | `codex/casino-catalogue-20261107` @ `a54696e` |
| PR #80 | `codex/reset-api-security-20261113` | `5be21ebfc1884fcc5f3a4b3c1f7eae6d6c1b8c4c` | `codex/salem-monitoring-20261107` @ `3d8c979` |

- **Ancestry:** the common ancestor of the two heads is `1436fba` (2026-11-07). The two PRs target different release lines.
- **Earlier comparison superseded:** a previous note compared PR #77 against `e99c2bf` (`codex/reset-security-20261113`). This document replaces it with PR #80's current head.

**Method (read only):**
- `git show`/`git diff` at both exact heads.
- `git merge-tree --write-tree aca6fac 5be21eb`, which computes the merge in memory and updates no ref or working file. It reports 19 textual conflicts:
  - **one reset-related file:** `apps/api/src/auth/password-reset.ts`;
  - **18 other files:** PR #80's ETB and ledger fixture repairs (`apps/api/src/withdrawals/*.test.ts`, `apps/api/src/agents/{agent-orders,config,dispute}.test.ts`, `apps/api/src/ledger/flows.contract.test.ts`, `apps/api/src/test/{fixture-ledger-cleanup,ledger-integrity-fixtures}.ts`, `.github/workflows/scheduled-rounds.yml`), which collide with the release-line versions.
- **Changed by both, no textual conflict:** `.env.example`, `.github/workflows/play-together.yml`, `apps/api/src/auth/password-reset.native.ts`, `apps/api/src/ledger/ledger-upgrade.migration.test.ts` and `apps/api/vitest.staff-native.config.ts` merge textually, but differ in meaning (below).

## Behaviour, side by side

Line numbers refer to `apps/api/src/auth/password-reset.ts` at each head
unless another file is named.

| | PR #77 (dormant) | PR #80 (hotfix candidate) |
| --- | --- | --- |
| Signing key | `PASSWORD_RESET_SIGNING_KEY` (hex, 32–64 bytes), read from the environment at call time (32–41). Unset: derived from `JWT_ACCESS_SECRET`, as today. Malformed: 503 | `PASSWORD_RESET_SECRET` in the config schema (`packages/config/src/index.ts:28`, at least 32 characters, optional at boot). Unset, or equal to either JWT secret: issuance and redemption fail (22–27). No JWT fallback |
| Token | Purpose `…-v1` (11). HMAC with a key derived from the root key and the purpose | Purpose `…-v2` (10). HMAC over purpose, `\0` and body. **Every v1 link stops working** |
| How the ledger is delivered | Operator SQL `docs/deployment/owner-password-reset-issuance.sql`; nothing installs it | Prisma migration `packages/database/prisma/migrations/20261113060000_owner_reset_issuance/migration.sql`, applied by `migrate deploy` as the database owner |
| Ledger | `owner_password_reset.issuances` (nonce, user, version, expiry, `issued_by`, `consumed_at`, `consumed_by`). A trigger allows only a single consumption; no delete or truncate | `password_reset_private.issuances` (nonce, user, **role**, version, expiry, `consumed_at`). A check limits expiry to 16 minutes; no immutability trigger |
| Issuance | Records only when the SQL is installed (110–116) | Always inserts (74): requires the migration |
| Redemption | Consumes only with `PASSWORD_RESET_ISSUANCE=enforce` (180, 217–229), through `public.owner_password_reset_consume(nonce, user, version)` | Always consumes (139), through `public.consume_owner_password_reset(nonce, user, role, version, expiry)`, which also binds role and exact expiry |
| Grants | Grants nothing; the installer refuses planted objects and privileges | The migration revokes `PUBLIC` and inherited named grants; grants no runtime access |
| **Client routing** | Explicit client argument: `issueOwnerReset(db, …)` (82) and `completePasswordReset(db, …)` (143). The route passes the injected `credentialDb` (`routes/auth.ts:60`) and the CLI passes its own (`scripts/owner-password-reset.ts:9`) | **Module-level client:** `import { credentialDb as db }` (5). The route calls `completePasswordReset(request.body)` (`routes/auth.ts:33`) and the CLI calls `issueOwnerReset(userId, email)` (`scripts/owner-password-reset.ts:9`) |
| Narrow writes | `select: { id: true }` on the user and audit writes | The same (145, 156) |
| Tests | `password-reset-issuance.native.ts` (14), `password-reset-key.native.ts` (5), the reset case in `auth-restricted-identity.native.ts`, and now a reset tripwire in `no-default-fallback.test.ts` | `password-reset.native.ts` (15 cases), in its own workflow on PostgreSQL 13, 16 and 18 |

## Assessment

- **PR #80 is the stronger fix** for the reset finding (`signing-authority.md`, finding 1):
  - the independent key is mandatory;
  - tokens are v2, so old links die;
  - the ledger is always enforced and binds role and expiry.

  PR #77's reset changes (`a303444`, `076cba9`) are dormant alternatives for the same finding. **Both must not ship.**
- **PR #77's explicit-client routing must survive.** PR #80's module-level import is exactly the silent default client that PR #77 removed for every auth path. PR #80's own description asks that integration preserve both the reset-v2 protections and the staff credential-routing safeguards, and not replace the reset file wholesale from either branch.
- **The new tripwire makes that enforceable.** `no-default-fallback.test.ts` now includes "routes owner reset issuance and reset completion to the injected credential client". It fails if reset completion uses a module-level client. Before this case, no test would have caught it: the restricted-login test still passes on the more privileged default client.

## Reconciliation plan (a decision; nothing here is done)

These are the code changes the reconciliation needs, and the testing each one requires.

1. **`apps/api/src/auth/password-reset.ts`:** PR #80's v2 semantics on PR #77's explicit-client signatures. Then remove `PASSWORD_RESET_SIGNING_KEY`, `PASSWORD_RESET_ISSUANCE` and the `owner_password_reset` hook. Tests to run:
   - PR #80's `password-reset.native.ts`, adapted to injected clients;
   - `auth-restricted-identity.native.ts` (its credential login then needs `EXECUTE` on `consume_owner_password_reset`);
   - `no-default-fallback.test.ts` (the reset tripwire must pass).
2. **`routes/auth.ts`, `routes/index.ts` and the owner CLI:** keep the injected clients and drop the `resetIssuance` option. Tests: the auth route suites and the route sweep.
3. **`packages/config/src/index.ts` and `.env.example`:** add `PASSWORD_RESET_SECRET` and remove PR #77's two reset variables. Tests: workspace typecheck and config tests.
4. **PR #80's migration on PR #77's line:**
   - a migration replay (`migrate deploy` twice);
   - `ledger-upgrade.migration.test.ts` (changed by both PRs);
   - the runtime-access preflight;
   - the staff identity rehearsal, whose step 6 must use the migration-installed `password_reset_private` ledger instead of `owner-password-reset-issuance.sql`;
   - the inventory's schema list.
5. **Retire PR #77's dormant reset artefacts:**
   - `docs/deployment/owner-password-reset-issuance.sql`;
   - `password-reset-issuance.native.ts` and `password-reset-key.native.ts`;
   - runbook sections 9 and 10;
   - the `signing-authority.md` recommendations that point at them.

   Optionally first port PR #77's immutability trigger and `consumed_by` column into the ledger, which would need its own review and tests.
6. **Workflows:** PR #80's `password-reset-security.yml`, plus path filters in `play-together.yml`.
7. **The 18 non-reset conflicts:** resolve them against whichever release line integrates second, then run the full payment, scheduled-rounds and contracts suites.
8. **Order:** which release line takes the reset fix first is an operator decision. Whichever integrates second carries the reconciled `password-reset.ts`. PR #80's release gates (universal v1 block, request drain, recovery checkpoint, isolated smoke test) apply whichever line it lands on.

None of the code changes in steps 1–7 has been made on this branch.
