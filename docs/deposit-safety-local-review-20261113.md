# Deposit safety local review — 13 November 2026

**Local, uncommitted candidate. Not release-ready. No publication or activation.**

## Verified base and preservation

Repository: petestar26/trivia. Branch: `codex/deposit-safety-revisions-20261113`.
HEAD/base: `a54696ebc3805108f25a9e1a6555dbada8252c6f`, verified against remote
`codex/casino-catalogue-20261107` again after the audit. The clean starting checkout
was `work` at `247d6eeef8e4c7342f2916c0be182abf74203ff5`; no unrelated local edits
existed. Workspace and `/workspace/trivia/.git` writes were permitted. No AGENTS.md
or checkout skills were present. No permissions, mounts or network policy changed.

Staff PR 77 remains separate. Its remote head advanced independently from
`ff3d5f728a714b803c2bed1ebdf7ab71b4889339` to
`6c38373b128aef5315986bb8be6d6cc19b44f714` during this work. Neither was applied.
The initial deposit candidate, including its original report and all untracked
files, was snapshotted before this audit. The review archive includes that snapshot,
the exact final patch, all final changed files, hashes, and test logs.

## Implemented behavior

Approved receiving destinations are append-only revisions. Editing pauses new
orders until approval while preserving prior approved destinations and existing
order snapshots. New orders pin an approved revision; destinations and revision
pins cannot be changed. Historical orders keep their snapshots and null revision
pins rather than inventing historical approval provenance.

Safety is separate from review status and dispute status. Disable conservatively
holds nonterminal orders, including disputed ones. Pre-existing open orders with
missing receiving accounts are held too. No automatic release, credit, cancellation,
expiry, refund, hold-clear or dispute-clear is introduced. A held order can enter
an investigation. Resolution remains blocked. Settled historical order records
are not rewritten; terminal recovery checks the account's current safety state.

Disable, edit and review claim the displayed expectedUpdatedAt atomically. The
original schema stores TIMESTAMP(3), exactly representable by JavaScript Date.
Every account update advances at least one millisecond, including direct SQL.
Deletion/truncation of account identities is blocked to prevent token reuse through
delete/recreate. No new authority role or provider evidence semantics is invented.

## Audit findings and fixes

| Finding | Fix and boundary |
| --- | --- |
| Late-refund recording/rejection updates recovery rows, bypassing an order-status-only guard | Service checks run before step-up/reference/audit mutation; a database recovery guard checks account and order safety even for expired/cancelled orders. Historical successful replays remain read-only. |
| Direct reservation, settlement or dispute writes could bypass order status checks | Database guards reject held reservation transitions, settlement insertion and dispute resolution. Dispute service checks safety before claiming resolution. |
| Revision UPDATE/DELETE/TRUNCATE was blocked but fabricated INSERT was not | Approval records the revision in an AFTER trigger. Each insert must match the exact current approved account row, including revision and approval metadata; the atomic unique key prevents duplicate current revisions. Native tests use a non-owner DML role for forgery/immutability checks. |
| A synthetic-fixture exception allowed new non-CREATED orders with no receiving account | Removed for every status. Synthetic purchase fixtures now create actual method/account rows. No production test bypass remains. |
| A pending account could be deleted/recreated to reuse an old timestamp | Account deletion/truncation denied. Existing disposable-test cleanup is narrowly extended, with loopback/name checks, scoped agent IDs and refusal while orders still cite those agents. |
| Submission/cancellation acquired order before account, opposite disable's order | They now lock account before order. Creation and settlement already acquire the account shared lock before their order claim. |
| Combined destination edit and disable could lose the disable safety signal | Preserve the requested disable independently of the pending-review transition. Reject explicit hold clearing before deriving state. |
| Terminal orders cannot be rewritten without altering historical evidence | Recovery checks the live account; order-room safety projection includes live account safety without modifying the historical order. |

### Release and payment path coverage

- Admission: fresh approved account under shared lock plus database insert guard;
  both create-first and disable-first orderings exercised on native PostgreSQL.
- Payment submission: account/order locks, readiness/safety check, conditional
  status change, and database status guard. Evidence is not provider verification.
- Agent settlement: readiness/account lock, conditional order transition, then
  reservation/ledger/witness writes in the transaction; database guards cover the
  order, reservation and settlement paths.
- Customer/staff cancellation and expiry sweep: safety check before status claim
  or reservation release; database status/reservation guards independently enforce it.
- Disputes: opening and assignment do not clear safety; both RELEASE and CANCEL
  are checked before service mutation and protected by dispute/order/reservation/
  settlement database guards.
- Late recovery: reports and assignment/reassignment remain investigations;
  REFUNDED/REJECTED transitions on held or missing destinations are denied.
  Reference/evidence records and room messages do not clear holds or move funds.
- Crypto/provider-specific deposits and withdrawals do not reference these
  receiving accounts and are outside this candidate's authority or safety scope.

## Native evidence versus in-memory evidence

**Native:** `python3 scripts/deposit-safety-native.py` passes on PostgreSQL 16.16
(image digest `sha256:63e83b5a3dc36a917dccb76fe1bd2ac51f1ec9c1deb47ff20d4f04233bf6eae9`).
The runner creates its own network-isolated Docker container, tmpfs database,
synthetic identities and a disposable NOLOGIN DML role, and removes its container.
No host ports, production URLs, credentials or persistent database storage are used.

It applies all **131 SQL migrations** with psql transactions and tests against the
resulting real schema. It does not run Prisma migration metadata or HTTP services.
Native checks cover preserved revisions, direct forgery/deletion/truncation denial,
missing-account denial for all tested statuses, independent holds on five write
paths, rollback of a preceding synthetic side-effect marker, and actual separate
PostgreSQL sessions for:

1. Create before disable: the committed order becomes held.
2. Disable before create: creation loses and leaves no order.
3. Same-version approval/approval: one revision, one side-effect marker, +1ms token.
4. Edit/review, review/disable, disable/review: one winner; losing claims leave no
   marker, revision, approval or safety-state side effects.

These are database-boundary tests, **not** proof of end-to-end wallet credit,
HTTP authentication, provider verification or application runtime-role compatibility.
The marker rollback is not presented as a real-wallet settlement test.

**In-memory:** the earlier seven tests were PGlite, not native PostgreSQL. The
final PGlite suite now has **12 passing tests**. Five isolated safety-helper tests
also pass, including absent/unknown safety results failing closed with HTTP 409.

**Other checks:**

- 42 focused web tests pass (account setup, admin setup, order room).
- Review-unit aggregate: **103 tests pass in 15 files; 21 suites fail to load**
  the unbuilt `@socialplay/database` package. This is a partial aggregate result.
- Web typecheck and strict i18n coverage passed (3,113/3,113 used keys; zero missing).
- Changed API TypeScript syntax transpilation and `git diff --check` pass.
- Aggregate typecheck fails at missing database package output and consequent API
  type errors; aggregate lint fails because the root ignore patterns exclude
  apps/packages, leaving package lint inputs ignored.

Failures encountered and corrected during audit: the first psql harness lacked
transaction boundaries needed by migration 19; the extended native runner briefly
mistook PostgreSQL's temporary bootstrap server for the final server; a hold-clear
regression test caught silent reassertion instead of rejection; two initial helper
parameterized cases had a test-shape error. The final native/focused/aggregate logs
reflect the corrected runner, guard and tests.

## P1 independent-review follow-up

Both reported defects are fixed in this same uncommitted candidate.

- Expiry selection now excludes safety-held orders before the 200-row limit and
  orders deterministically by creation time and ID. Cancellation retains its
  locked transactional hold recheck and its conditional claim also requires no
  safety hold. A service regression uses 200 older held expired orders followed
  by one eligible expired order: the eligible order expires and its reservation
  release is invoked, while all held rows remain unchanged. A second regression
  adds a hold after selection and proves no update, release or audit occurs.
- Safety disable now claims by ID, expected version and safetyHold=false,
  independently of review status, and preserves that review status. REJECTED
  accounts can therefore be held without rewriting their review. Native evidence
  covers approval, pinned paid order, edit, rejection, safety disable and denied
  settlement. Stale disable loses without mutation. Approval and edit cannot
  operate on held accounts. Owner/admin UI allows rejected-account safety disable;
  held accounts cannot be edited. Wallet options and operational readiness counts
  explicitly exclude safety-held accounts even if review status remains APPROVED.

Five dedicated service regressions pass with real service functions and explicitly
mocked database/inventory/economy boundaries. Command (from apps/api):
`./node_modules/.bin/vitest run --config vitest.deposit-safety.config.ts`.
The dedicated config resolves a completely mocked database module; it neither
initializes nor substitutes a Prisma engine. This is unit evidence, not native
Prisma/service integration evidence.

The native PostgreSQL runner also proves expiry progresses beyond 200 held rows,
with all 200 held orders byte-equivalent and their reservations still ACTIVE.
Native expiry assertions exercise SQL selection/status guards, not the full API
ledger path. Both new native regressions and all earlier migration/guard/contention
checks pass. The 42 web tests include rejected-account disable in owner and admin
views. The wallet-options filter assertion is in a Prisma-blocked suite and is
not claimed as passing runtime evidence; new readiness filters have syntax checks.

Final logs are included as evidence. Intermediate UI assertions assumed the old
review-status behavior and were corrected. An initial aggregate attempt loaded
22 blocked suites when the isolated service test lacked its mock-resolution
config; it was moved to the dedicated config. Final aggregate remains 103 passing
tests and 21 blocked suites. Root typecheck and lint were rerun and still fail for
the documented package-output and ignored-input problems. No denied engine request
was retried. The release remote and separate PR 77 head were reverified unchanged.

## Remaining blockers and decisions

The earlier Prisma engine/checksum request to `binaries.prisma.sh` returned HTTP
403. No compatible engine was found in installed tool/repository locations.
The denied content was not retried, fetched through Docker/another source, or
bypassed with ignored checksums or changed permissions. Docker was used only for
an independently allowed PostgreSQL image, never to obtain Prisma content.

Still unvalidated: Prisma client generation, full API/package build, service/HTTP
integration suites, complete pnpm test aggregate, actual runtime-role privileges,
application-level competing requests, and ledger/wallet effects through the API.
Full native SQL migration execution and native SQL contention are now validated,
which supersedes the initial report's absence of native evidence.

Existing authority checks accept active ADMIN/SUPER_ADMIN. No verified distinct
main-admin mapping exists. Hold release is unimplemented and fails closed at the
database boundary. Any new main-admin authority, hold release or provider-backed
settlement must await an explicit verified policy and separate validation.

Existing late-recovery code already uppercases references and uses method-scoped
claims; this candidate does not introduce, expand or validate those provider
semantics. Manual attestation is not proof of a provider transaction, reversal or
refund. Provider and authority decisions remain activation blockers. Existing
ordinary payment behavior is not claimed to be independently provider-verified.
No feature flags were enabled and this candidate must not be treated as ready
for production activation based on these partial checks.

No push, merge, deployment, live grant, production connection/data change, bet or
external funds movement occurred. Disposable local database grants and synthetic
SQL transitions were used only for the explicitly requested tests.

## Resumed Cloud validation checkpoint

The candidate is preserved on the same branch/base with 34 changed files and
seven untracked files. No code or policy changed during this checkpoint. Workspace
writes remain permitted; no AGENTS.md or checkout .agents/skills were found.
The managed environment is running with enforced restricted networking and no
configured secrets. PR 77 was neither retrieved nor integrated on this resume.

The parent reports independent verification of this exact revised candidate:
API build/typecheck, 340 review tests and five P1 service tests passed using an
already-existing compatible Prisma 5.22 engine. Those are reported independent
results, not reruns in this Cloud workspace, and do not prove native API/ledger
integration. The earlier local build/test failures below remain historical local
observations rather than evidence that the independent checks failed.

Local installed-file inspection found no native query or schema engine in
/workspace, /tmp, /opt, /usr, /root/.cache or /root/.npm. Bundled Prisma WASM
runtime assets are present but are not substituted for the missing native engine.
No engine download, alternate source, network change or permission escalation
was attempted.

Reproducible API integration collection probe (from apps/api):
`DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:1/playqube_scheduled_throwaway SCHEDULED_NATIVE_DB_ACK=throwaway ./node_modules/.bin/vitest run --config vitest.payments-native.config.ts`

Result: three suites fail at module collection because @socialplay/database has
no built entry; payment-maintenance's two mocked tests pass. Port 1 is an explicit
non-serving local placeholder for this collection-only probe. No database was
connected and no API/ledger integration test ran. The next blocked stages are
client generation/package build, then actual disposable-DB service execution,
authenticated HTTP coverage, application-level concurrency and ledger effects.
No claims of native API validation are derived from these two mocked tests.

The five dedicated P1 service regressions were rerun successfully. Native SQL
migration/guard/contention evidence was refreshed separately with the existing
PostgreSQL image; see evidence/deposit-resume-native.log. All previous policy
and activation gates remain unchanged. This candidate is not release-ready.

## Native integration review repairs (I3 and recovery fixture)

The independent reviewer reported 34 native integration tests: 25 passed and nine
failed. Eight failures identified unsafe/unset search_path configuration on the
new deposit guards; the ninth identified the obsolete synthetic recovery order
with no receiving account. These reports are distinguished from local reruns.

All eight deposit trigger functions now pin `search_path=pg_catalog,pg_temp`,
matching the existing runtime-role I3 contract. All application relations and the
account composite type use public-qualified names, and the timestamp functions
are explicitly pg_catalog-qualified. No I3 production code, assertions or
allowlists were weakened. The new native regression copies the existing I3
cascade-trigger catalog predicate and asserts zero unpinned functions across the
complete migrated schema; it also checks all eight deposit guards individually.

The owner-only synthetic recovery fixture now creates an approved synthetic
receiving-account revision and pins its cancelled order to that account and exact
snapshot. Users stay suspended, agent disabled, country and method inactive.
The baseline hashes the receiving-account rows rather than only their count, so
destination drift is detected. No production fixture was run or modified. The
native payment-readiness test now asserts matching account/snapshot/revision.
Existing previously seeded fixture baselines are not silently migrated: a mismatch
still fails closed; reviewer reruns should use a fresh disposable database.

Validation of this revised candidate:

- `python3 scripts/deposit-safety-native.py`: PASS on native PostgreSQL 16.16,
  all 131 migrations, all eight guard configurations, complete cascade-trigger
  I3 predicate, prior safety/revision/P1 checks and real multi-session contention.
- From apps/api, `./node_modules/.bin/vitest run --config vitest.review-unit.config.ts src/agents/deposit-revisions.test.ts src/agents/deposit-safety.unit.test.ts`:
  PASS, 13 PGlite tests plus five helper tests (18 total).
- `./node_modules/.bin/vitest run --config vitest.deposit-safety.config.ts`:
  PASS, five mocked-boundary service regressions.
- Same local collection-only payments-native command documented above:
  three suites still fail at unbuilt @socialplay/database module collection;
  two mocked maintenance tests pass. The repaired recovery fixture/native API
  regression and full ledger invariant runner cannot execute here and require
  independent rerun with the existing compatible engine. The native catalog
  predicate pass is not represented as a full API/ledger integration pass.
- Changed fixture/native-test TypeScript syntax transpilation and git diff check pass.

Exact logs are in evidence/deposit-i3-*.log. No engine download or PR77 retrieval
was retried, no network/permission changes were made, and no production SQL,
access grant, bet, funds movement, activation, merge or deployment occurred.
Authority, hold-release and provider-policy gates remain fail-closed. No claim
that all 34 independent integration tests now pass is made before their rerun.

## I3 ordinary-invoker correction (supersedes v3 blanket-pin claim)

Independent review verified the v3 hashes and reran 34 native tests: 26 passed,
eight still failed I3; the repaired recovery fixture passed. The v3 local check
covered only the cascade branch, so its passing result did not validate the full
I3 search-path predicate. The earlier section is retained as audit history and
must not be read as a claim that v3 satisfied full I3.

Inspected apps/api/src/economy/ledger-invariant-checker.ts including the ELSE:
SECURITY DEFINER, privileged/strict-listed functions and cascade-trigger functions
require pg_catalog, pg_temp; other invoker functions require public, pg_temp.
Only deposit_revision_insert and deposit_recovery_safety now use public, pg_temp.
The other six keep pg_catalog, pg_temp. Application references remain fully
schema-qualified. No function security mode, invariant, allowlist, authority or
financial behavior changed.

The blanket regression was replaced. PGlite asserts the two invoker pins and six
cascade pins separately. The native runner extracts the complete unchanged
production search-path predicate and its privileged-function lists from source,
executes it across all schema functions, then temporarily gives each of the two
ordinary invokers the wrong catalog pin and a cascade function the wrong public
pin. Each must be reported by I3; each mutation is rolled back. This tests both
branches rather than assuming all deposit functions belong to one classification.

Current focused reruns: 13 PGlite + five helper tests pass; five service tests pass.
Native SQL results are recorded in evidence/deposit-i3branches-native.log, distinct
from API/ledger integration. API loading is still blocked by the unbuilt database
package/missing local native Prisma engine; no blocked download was retried.
Independent review must rerun the exact 34 integration tests on this artifact.
The prior fixture repair is preserved. All policy gates stay fail-closed; no
PR77 retrieval, production SQL/grants/data, merge or deployment occurred.

## Authenticated routes, application races and runtime-role acceptance additions

The parent reports independent verification of all v4 hashes and 34/34 native
PostgreSQL API integration tests, 18 focused tests and five P1 service tests.
Those successes apply to v4. This revision adds five native tests to the existing
payment-readiness.native.ts suite (no production code changes):

1. Real buildServer/cookie-authenticated approve, reject, owner-disable and admin-
   disable requests; unauthenticated, wrong-role, cross-agent, malformed and stale
   attempts. State comparisons include account/order, audit counts, reservations,
   inventory/ledger counts, disputes, settlements and wallet entries. Approved
   replacements leave old order snapshots/revisions frozen; safety-disable leaves
   a pre-existing dispute intact, with no release or credit.
2. Concurrent edit/approval/disable sharing one expectedUpdatedAt. A fixed future
   millisecond forces the +1ms token branch: exactly one success/audit, losing
   conflicts leave no reservation, inventory, destination or wallet effects.
3. Concurrent service creation/disable: either no order/reservation, or a pinned,
   safety-held order with its reservation still active; no settlement/credit.
4. Concurrent expiry/disable: either expiry wins first and releases once, or
   disable wins and reservation/inventory remain unchanged. No frozen destination
   changes or wallet credits are allowed.
5. Disposable NOLOGIN restricted role configured using the existing
   ledger_apply_runtime_grants function. First prove its actual identity/read
   access, then deny frozen revision/snapshot mutations, hold clearing, held
   reservation release and trigger disabling. Repeat frozen-record attempts as
   owner; unchanged state and the actual I3 result are asserted. The role is
   removed in finally. This is a direct-DML boundary test; it is not proof that a
   full API process running on a restricted connection has passed acceptance.

Existing fixture helpers, actual server authentication and services are reused;
no mocks replace them. Existing ADMIN policy is tested as-is, not declared to be
an authoritative main-admin mapping. No hold-release/provider policy is invented.
The concurrent calls start together but do not force every possible scheduling
order; the existing SQL barrier tests separately cover both commit orderings.

Independent execution: fresh disposable PostgreSQL database named
playqube_scheduled_throwaway on localhost/127.0.0.1, all migrations applied, existing
compatible Prisma engine and generated/built packages, then from apps/api:
`SCHEDULED_NATIVE_DB_ACK=throwaway DATABASE_URL=<disposable-local-owner-url> ./node_modules/.bin/vitest run --config vitest.payments-native.config.ts`
The existing config already includes the modified file. Never use production or
an existing shared database; the runtime test creates only its own random local
role with the existing grant function. Its role setup and tests have NOT executed
in this Cloud workspace because suite collection remains blocked.

Local current results:
- Native SQL runner: PASS all 131 migrations, full production I3 search-path CASE,
  both wrong-pin branches, and previous safety/P1/multi-session checks.
- Focused PGlite/helper tests: 18 PASS. P1 service tests: five PASS.
- New test TypeScript syntax transpilation and git diff check: PASS.
- Payments-native collection attempt: three suites FAIL to load the unbuilt
  @socialplay/database package; two mocked maintenance tests PASS. All five new
  tests are UNEXECUTED here; semantic/type/runtime acceptance awaits independent
  execution. No denied engine download or alternative fetch was attempted.

Exact evidence is included as deposit-acceptance-*.log. New tests are reviewable
candidates, not claimed passes. All authority/provider/activation gates and the
no-production/no-PR77/no-publication restrictions remain unchanged.

## Cookie-write Origin fixture repair

Independent v5 review verified all 36 hashes and passed 38/39 native tests; the
four added race/restricted-SQL tests passed. The HTTP case stopped at session-
origin middleware, so its earlier matching 403 responses did not prove role or
ownership enforcement. This revision changes only that test fixture and report.

Intended cookie-authenticated writes now send Origin derived from
new URL(config.FRONTEND_URL).origin, following the existing cookie-origin and
password-reset native test pattern. The existing payment-room test uses bearer
writes and a cookie GET, so it did not exercise cookie-write Origin validation.
No production middleware, CORS configuration, role policy or authentication mode
was bypassed or changed.

Wrong-role responses must contain Permission required: agent:review; cross-agent
responses must contain Not your payment account; malformed versions must contain
the route's displayed expectedUpdatedAt requirement. Each denial retains complete
state comparisons. Separate cookie requests with missing Origin and an explicitly
untrusted Origin must return Untrusted session origin and leave all tracked state
unchanged. Successful and stale requests retain their destination/reservation/
hold assertions. These cases remain within the existing native test (39 total
integration tests expected in the reviewer's unchanged suite scope).

Local checks: syntax transpilation and diff check PASS; 18 focused SQL/helper tests
PASS; five P1 service tests PASS. Attempted existing cookie-origin suite fails at
unbuilt database-package collection (one failed suite, not a middleware behavior
failure). Payments-native again has three collection failures and two mocked
maintenance passes. The repaired HTTP assertions are UNEXECUTED locally; independent
native rerun remains required with the command in the preceding section. Native
SQL was not redundantly rerun for this test-only change; v5 SQL evidence is retained.
Full API operation using a restricted database connection and unresolved policy
gates remain open. No denied download, PR77 retrieval or production action occurred.

## Genuine non-owner API pool acceptance test

The parent reports v6's 39/39 native PostgreSQL tests and all 36 hashes passed
independent review. This revision adds one native test plus a child harness;
production code and grants are unchanged. The preceding 39 tests' results must
not be attributed to the new child-process acceptance test until it executes.

The owner seeds only disposable fixtures, creates a unique restricted LOGIN role
and invokes the existing ledger_apply_runtime_grants function (same supported
grant setup used by the prior passing role test). Only database CONNECT/TEMPORARY
are explicitly granted as in the repository runtime-role harness. No broad grants
are added and no permission failure is caught and bypassed. The owner Prisma
singleton is disconnected before spawning the child and reconnects only after
child exit for observation/cleanup. Role removal runs in finally.

New child: apps/api/src/test/deposit-runtime-http-harness.ts. It receives a
whitelist environment with only the runtime DATABASE_URL, synthetic JWT secrets,
local frontend Origin and existing engine/library paths if configured. It receives
no owner/direct URL, preload, signing key, inherited Prisma singleton or credentials
file. Imports are delayed until target/identity checks. It asserts config and
process datasource equality and that the actual database singleton is the new
runtime client. Real pool queries before/after HTTP requests prove current_user
and session_user match the runtime role, no superuser/BYPASSRLS flags, no database/
table owner membership and no reachable elevated/table-owner role. No SET ROLE is
used in the child. No runtime fallback or alternate owner client is constructed.

The actual server uses cookie auth and trusted Origin for six requests: wrong-role
approval denial, cross-agent disable denial, successful approval, stale disable,
and simultaneous owner/admin disables sharing one version (one 200, one 409).
Assertions cover exact denial messages, unchanged losing state, one audit per
success, pinned revision/snapshot, safety hold, unchanged order status/reservation/
inventory, no settlement and no wallet-entry changes. Synthetic reserved funds
stay reserved throughout. Parent independently observes held/pinned order after
child exit. Approval/disable permission problems must fail with captured child
output; they are not interpreted as acceptable least-privilege success.

Independent command: with a fresh local playqube_scheduled_throwaway database,
all migrations and built packages using an already available compatible Prisma
engine, from apps/api:
`SCHEDULED_NATIVE_DB_ACK=throwaway DATABASE_URL=<local-disposable-owner-url> ./node_modules/.bin/vitest run --config vitest.payments-native.config.ts`
The existing config includes the parent test; expected scope increases from 39 to
40 tests. To isolate the new test add `-t 'separate non-owner Prisma pool'`.
The parent constructs the runtime URL; do not manually supply an owner URL to the
child. This test grants no live identity and must never target a shared database.

Local current validation: 18 focused tests PASS, five P1 service regressions PASS,
both changed TypeScript files syntax-transpile and git diff check PASS. Native API
attempt again stops at unbuilt @socialplay/database collection (three suites fail;
two mocked maintenance tests pass). The new process, role setup, identity queries
and HTTP acceptance are UNEXECUTED locally. No exact missing SQL permission can
honestly be named until independent execution; the established local blocker is
package loading, not demonstrated role denial. No denied dependency fetch was
retried. Unchanged SQL migrations were not redundantly rerun for this test-only
addition. Full runtime-pool acceptance and all policy/rollout gates remain open.

## Final changed files

- `apps/api/src/agents/agents.test.ts`
- `apps/api/src/agents/config-service.ts`
- `apps/api/src/agents/deposit-p1-regression.test.ts`
- `apps/api/src/agents/deposit-revisions.test.ts`
- `apps/api/src/agents/deposit-safety.unit.test.ts`
- `apps/api/src/agents/dispute-service.ts`
- `apps/api/src/agents/late-payment-service.ts`
- `apps/api/src/agents/order-lifecycle.test.ts`
- `apps/api/src/agents/order-lifecycle.ts`
- `apps/api/src/agents/order-service.ts`
- `apps/api/src/agents/payment-account-service.ts`
- `apps/api/src/agents/payment-account-setup.test.ts`
- `apps/api/src/agents/payment-readiness.native.ts`
- `apps/api/src/agents/payment-room-service.ts`
- `apps/api/src/agents/payment-setup.ts`
- `apps/api/src/agents/routes.ts`
- `apps/api/src/routes/wallet-options.test.ts`
- `apps/api/src/routes/wallet.ts`
- `apps/api/src/scripts/payment-readiness.ts`
- `apps/api/src/scripts/staging-recovery-fixture.ts`
- `apps/api/src/test/deposit-runtime-http-harness.ts`
- `apps/api/src/test/financial-policy-fixtures.ts`
- `apps/api/src/test/fixture-ledger-cleanup.ts`
- `apps/api/src/workspaces/service.ts`
- `apps/api/vitest.deposit-safety.config.ts`
- `apps/api/vitest.review-unit.config.ts`
- `apps/web/src/lib/i18n/catalogues/staff-phase2.ts`
- `apps/web/src/pages/wallet-agent-setup.test.tsx`
- `apps/web/src/pages/wallet-agent-setup.tsx`
- `apps/web/src/pages/wallet-order-room.test.tsx`
- `apps/web/src/pages/wallet-order-room.tsx`
- `apps/web/src/pages/wallet-setup-admin.test.tsx`
- `apps/web/src/pages/wallet-setup-admin.tsx`
- `docs/deposit-safety-local-review-20261113.md`
- `packages/database/prisma/migrations/20261113060000_deposit_destination_revisions/migration.sql`
- `packages/database/prisma/schema.prisma`
- `scripts/deposit-safety-native.py`
