# Temporary reset cutover barrier

This patch is based on live API commit `2b45b1b65ae7dd44dbee2c40ced51a789568da6d`.
It adds an unconditional `onRequest` deny to the actual POST password-reset
route. Matched requests return HTTP 503 with the existing API error envelope,
no-store caching, no cookie clearing, no parsing or redemption call. Existing
origin/rate controls may reject earlier. Unmatched spellings remain 404.
No environment value, header, token or operator flag enables it. Login, renewal,
logout, password change, page routes and the public layout are unchanged.

The API is the enforcement point for both its direct Railway/custom origins
and the web server's `/api/*` forwarding. A web-only deny is not sufficient.
No web production code change is needed: a synthetic test exercises the real
web gateway against the guarded API. The guard follows Fastify's resolved route,
not a duplicate string matcher, and therefore follows configured mount prefixes
and any accepted encoded spelling of that same route.

## Release ordering (not yet executed)

1. Review this guard as a separate old-code-only API release. Do not bundle v2,
   new migrations, grant changes or unrelated worker/web changes into this first
   release. Check its exact build/start/predeploy configuration: it must not run
   candidate migrations or seed/update production data as a side effect.
2. Stop owner CLI issuance operationally and inventory every API instance,
   replica, custom/provider domain, internal ingress, route prefix and alternate
   reset handler. This HTTP guard does not stop CLI calls or other deployments.
3. Deploy the guard on the old API line. A rolling/zero-downtime deploy is NOT
   instantly universal: unguarded old instances can still redeem during overlap.
   Do not start migration. Wait for every old process to retire, and verify no
   old in-flight reset/CLI transaction remains. If that cannot be established,
   stop and obtain an approved maintenance or universal ingress control instead.
   Do not infer drain from a healthy deployment or one successful HTTP probe.
4. Establish all serving API instances contain this exact guard and all traffic
   destinations point to them. Use only synthetic/invalid inputs for authorized
   production probes; never test with valid customer reset links. Check direct
   origins and web forwarding, including aliases/query/trailing/encoded paths.
   These probes complement instance/drain evidence, not replace it.
5. Keep this exact guard in the v2 candidate before performing the reviewed owner
   migration and runtime-role cutover. This six-line hunk applies to both the
   old-code route and the current integrated v2 candidate. Keep all release gates
   and the rollback plan; this patch by itself approves neither migration nor
   deployment. No fallback to publicly reachable unguarded v1 is safe.
6. Only after all serving instances are verified v2, migration/grants/signing key
   and the full release checks pass, remove the six-line guard in a separate
   reviewed v2-only release. Mixed guarded-v2/unguarded-v2 instances temporarily
   return either 503 or v2 processing, never v1. Never remove it from old code.
   Resume owner issuance only after the reviewed v2 cutover is complete.

If the requirement is to block all v1 requests starting immediately BEFORE the
first guard rollout, this patch cannot provide that guarantee. It requires an
already universal ingress control or a separately approved maintenance window.

## Local verification

From `apps/api`, run `node node_modules/vitest/vitest.mjs run --config
vitest.reset-cutover.config.ts` (single line). No database is used: redemption
is mocked and asserted uncalled. The suite includes normal cookie, phone and
Google auth regressions, direct API path variants, malformed JSON, no cookie
clearing, an unrelated health route and real loopback web-gateway forwarding.

Result on the old-code worktree: **54/54 tests passed** across four files.
An initial gateway fixture used an untrusted synthetic Origin and returned 403;
correcting the fixture to trust its own loopback origin verified the actual
503 barrier. Full API build, platform rollout/drain and production ingress
verification remain required. No denied-test launcher was retried.

## Guard-only deployment plan and stop conditions

This is a plan, not authorization to change Railway/GitHub or a claim that the
live settings were rechecked. Target project is PlayQuibe Account Test,
environment account-test, existing API serving
`account-api-account-test.up.railway.app` and the salem.bet gateway. Resolve and
verify the exact API service ID from current platform state; the known Postgres
service ID is NOT the API service. Do not touch workers, web, database settings,
secret values, runtime grants, signing keys, domains or replicas in this step.

### Source and automatic-deployment safeguards

- Recheck currently serving API SHA is still
  `2b45b1b65ae7dd44dbee2c40ced51a789568da6d`. Stop on drift and review a new base.
- Prepare a dedicated immutable guard commit based directly on that SHA with
  only the four files in this patch; confirm production change is six lines.
  Full normal frozen-lockfile workspace/API build and exact-SHA CI remain gates.
- Before any push, inventory branch subscriptions for every Railway service and
  CI deployment workflow. Do not push this to an existing watched branch,
  merge PR80/81/82, change a shared branch head, or rely on an unpinned branch
  selector. A new branch is safe only after confirming wildcard CI/preview
  triggers cannot deploy it. Publication remains a separate approved action.
- Prefer a verified exact-commit deploy operation against only the API service.
  If the supported interface cannot pin the source revision, stop and design a
  single-service manual deployment path with verified exact source bytes; do
  not guess a CLI flag or allow branch drift. Do not reconnect/switch tracked
  branches just to force deployment. Ensure no concurrent/staged deployment or
  automatic redeploy can replace the guard during cutover.

### Predeploy: do not let a guard release migrate

The last observed effective live predeploy was:

```sh
pnpm --filter @socialplay/database db:migrate:deploy && node apps/api/dist/scripts/practice-activation.js --check && node apps/api/dist/scripts/practice-gifts-check.js && node apps/api/dist/scripts/payment-readiness.js && node apps/api/dist/scripts/member-experience-check.js
```

This baseline contains 130 migrations. Historical source census reported those
same 130 already applied, but a fresh exact checksum/history comparison is
required; count alone is insufficient. `db:migrate:deploy` is a mutating command,
not a status check. Do not assume no-op based on old observations.

Preferred reviewed temporary effective predeploy for this guard release:

```sh
pnpm --filter @socialplay/database exec prisma migrate status && node apps/api/dist/scripts/practice-activation.js --check && node apps/api/dist/scripts/practice-gifts-check.js && node apps/api/dist/scripts/payment-readiness.js && node apps/api/dist/scripts/member-experience-check.js
```

Change only the migration step, retaining all existing readiness checks. Verify
this exact command is what the candidate deployment will execute before release.
If a pending/failed/diverged migration is reported, abort; do not run deploy to
make the guard pass. `practice-activation --check` selects only its readiness
query path, not `--apply`; other listed scripts inspect readiness. Keep current
runtime identity unchanged for this guard step. This does not endorse retaining
owner credentials permanently; the later reviewed restricted-role cutover is
separate. No raw credentials should be displayed or copied into notes.

The baseline repository's `deploy/railway/api/railway.json` differs from the
observed effective platform settings: it specifies runtime-identity + migration
status + ledger-upgrade-preflight. Do not change the service config-file path or
silently activate that file. First verify effective config precedence and the
exact build/start/health/predeploy commands on the proposed deployment. A
settings save may trigger a release or apply staged changes; use only a supported
single-service staged path with known behavior, otherwise stop. Do not weaken a
failing check to force a deployment.

### Verification and recovery

Keep the database schema/data and credentials unchanged. Require successful
build/predeploy/health, exact serving guard SHA, all routes/instances guarded,
and retirement/drain of unguarded v1 processes before the v2 migration window.
An ordinary healthcheck is not proof of drain or universal coverage. Inspect
platform lifecycle and application shutdown behavior; if evidence is missing,
obtain a verified universal ingress or approved maintenance plan.

If guard deployment fails before replacing old code: leave the existing service
running, halt the cutover, and report the guard is NOT established. If it fails
after serving: prefer repair/redeploy of the same guarded old baseline, not a
rollback that reopens reset. A return to unguarded v1 requires an independently
verified universal block and explicit review; never do it automatically. Before
migration no schema rollback is necessary because this plan forbids schema
writes. After migration, the known-good recovery artifact must remain guarded
v2, not this old baseline. Keep the guard-only artifact and deployment evidence
until the entire v2 cutover is completed; no cleanup/deletion here.

Residual risk: the first rolling release permits unguarded v1 requests until
all old instances finish. It cannot offer an immediate universal deny, cancel
already-running database transactions, or stop operator CLI issuance. An
approved bounded reset-only interruption starts once the barrier is established;
if immediate protection is required, this route-only rollout is insufficient.

## Repository override artifact and precedence audit (2026-11-16)

A fresh read-only Railway `describe_service` confirmed API service
`ffe7dd49-e409-4a46-95a8-7614d2e96095`, baseline SHA above, successful deployment
`ee568464-867e-4db6-a213-3ea1db50c2ec`, and no staged changes. Root directory `/`,
branch `codex/salem-monitoring-20261107`, build command
`pnpm install --frozen-lockfile && pnpm --filter api build`, start command
`node apps/api/dist/server.js`, `/health` timeout 300, restart retries 3, one iad
replica and `/data` volume remain unchanged. Its effective predeploy still uses
`db:migrate:deploy`. The response does NOT expose/confirm the selected custom
config-file path. The existing repository API config differs on start command,
health timeout, retries and predeploy, so do not activate it wholesale.

Prepared `deploy/railway/api/reset-cutover.railway.json` deliberately overrides
ONLY `deploy.preDeployCommand`, with status plus the four existing checks. It
has no environment/PR section or build/start/health/replica/network changes.
It is NOT automatically active merely because it is in this repository. Select
it only through an independently verified supported config path for this exact
API service, with explicit authorization. Nothing was selected or changed live.

Current official Railway docs say code-defined fields override dashboard fields
without updating dashboard values; deployment details identify source files.
They also now warn that Config as Code is deprecated, supported only for existing
users until 2026-12-01, and new services cannot opt in. Thus this service's actual
eligibility/selected config path and candidate deployment effective settings
must be established before relying on this file. If unsupported, use the same
single predeploy override via supported service settings instead, reviewed
separately. Do not silently convert the project to Infrastructure as Code or
fall back to the baseline automatic migration command.
Source: https://docs.railway.com/config-as-code (read 2026-11-16).

### Prisma status limitations on the unchanged history

The installed lockfile-pinned Prisma CLI is 5.22.0. Its local migrate-status code
calls diagnoseMigrationHistory with optInToShadowDatabase=false and lists local
migrations; it does not call applyMigrations. Equal, finished 130-file history
should return success. Pending local migrations, failed migration records,
divergent histories or connectivity/engine problems must stop predeploy.

IMPORTANT: the pinned CLI's status implementation does not handle
editedMigrationNames or databaseIsAhead as failure cases. Therefore status alone
is NOT a checksum equality gate, nor a guarantee the database has only these 130
migrations. Separately require a fresh exact-name/checksum census, successful
finished states and no extra/failed/duplicate history before guard release.
Do not downgrade this to count-only or the status success message. No production
status/census was run in this config task; no earlier denied native migration
test was retried. No mutation was made to any migration SQL or history.

The new `node --test deploy/railway/api/reset-cutover-config.test.mjs` passes 4/4:
minimal keys, exact command chain/no deployment mutation, all four script paths,
and exact 130-file baseline manifest. This is source/config validation, NOT a
Railway deployment or a native Prisma/database execution test. The manifest's
serialization is `name space sha256 newline`, resulting SHA256
`bce3be9647860349edc8266ddf0b3ecf10c034a59d270aae2fa222ea5103ef1e`.
Do not carry this baseline-specific 130-manifest test or old predeploy override
into the 133-migration v2 candidate. Only the six-line HTTP barrier belongs there.

## Dedicated guard CI (prepared, not published)

`.github/workflows/password-reset-cutover-guard.yml` checks out and verifies the
exact PR head SHA (or workflow-dispatch SHA), not a synthetic PR merge commit.
It uses repository-consistent version-pinned actions/checkout@v4 and
setup-node@v4, Node 20, pnpm 8.15.9 and frozen dependencies. These action tags follow
existing conventions but are not immutable action commit pins. Contents-only
read permission, no persisted checkout credentials, no production secrets,
no external database and no deployment job. Tests use a deliberately unreachable
loopback placeholder DATABASE_URL, synthetic signing values and mocked DB calls.
Stages cover package build, the exact 130 migration/config tests, all 54 guard/auth
tests, API typecheck and normal API build, and tracked-source/lockfile integrity.
The exact tested SHA is recorded in the job summary; require it to match the
approved immutable release SHA before release. Full CI has NOT run remotely.
Local YAML parse/structural safety checks and config suite 4/4 passed after adding
this workflow. Existing local guard 54/54 and API bundle result remain separate
from the new clean-install/typecheck/normal-build CI gate.
