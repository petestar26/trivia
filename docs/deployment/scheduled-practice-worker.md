# Supervised shared-practice worker

This candidate adds health and supervision to the existing practice scheduler.
It does not activate a stream, change any migration or financial setting, or
replace the API or ordinary worker service.

## Runtime behavior

- `--once` retains its success/failure exit codes and starts no HTTP listener.
- `--loop` runs one transaction at a time, retrying failures after one second.
  A successful transaction is reported only after commit.
- Optional `SCHEDULED_PRACTICE_HEALTH_PORT` serves uncached `GET`/`HEAD /health`.
  Responses contain only status, readiness, `mode: PRACTICE` and
  `coinsAccepted: false`; no connection details, results, tickets or player data.
- Readiness is 503 before the first successful tick, after a failed tick, after
  30 seconds without success, and during shutdown. A later successful tick
  restores 200. A busy advisory lock counts as a successful database tick;
  another worker may own that interval.
- Health measures process/database progress. A paused stream can have a healthy
  worker; HTTP 200 does not promise that entries are open.
- A watchdog exits 1 after 60 seconds without a successful tick, including hung
  startup or ticks. Configure restart supervision: deployment probes alone do
  not continuously restart unhealthy processes.
- SIGTERM/SIGINT withdraw readiness and wake the between-tick wait immediately.
  An in-flight transaction may finish before disconnect. Cleanup has a
  25-second deadline, then exits 1. Configure platform termination grace of at
  least 30 seconds and rehearse it on the target.

The environment opt-in and explicitly enabled database stream remain required.
Neither switch enables Coins or starts this process alongside other services.

## Isolated staging prerequisite

The current staging API runs the unrelated older
`feat/group-moderation-notifications` candidate. Its ordinary worker performs
existing background jobs. `spin-review` points to the production API, so it is
not an isolated backend rehearsal. Do not repurpose these services.

Prepare a disposable database with candidate migrations, an API on the same
candidate, and a separate practice worker. Do not copy production player data,
signing keys or owner credentials into runtime services.

The owner/migration job must provision a dedicated worker LOGIN account and
install its connection directly in the new service's secret settings. It needs:

| Object | Permission |
| --- | --- |
| `public` schema | USAGE |
| `scheduled_game_streams` | SELECT |
| `scheduled_game_rounds` | SELECT, INSERT |
| Round columns `state`, `outcome`, `drawn_at` | UPDATE |

The account must lack superuser, BYPASSRLS, CREATEDB, CREATEROLE, ownership and
role memberships. Check effective permissions, including PUBLIC grants, and
deny ticket, user, wallet, signing-key and financial-mutation access. Do not
reuse the API account or the broad ledger runtime-grants setup. This change
does not provision or certify a deployed worker account.

## Direct Railway settings for a new staging service

Use the reviewed candidate branch in the staging environment. Configure direct
settings without touching other services or unrelated staged patches:

| Setting | Value |
| --- | --- |
| Build | `pnpm install --frozen-lockfile && pnpm --filter api build` |
| Start | `node apps/api/dist/scripts/scheduled-practice-worker.js --loop` |
| Predeploy | None; a separate owner job applies migrations |
| Health path / timeout | `/health` / 90 seconds |
| Restart policy | ALWAYS |
| Replicas / sleep / cron | 1 / disabled / none |
| Public domain | None required |
| Watch paths | `apps/api/**`, `packages/shared/**`, `packages/database/**`, workspace package/lock files |
| Termination grace | At least 30 seconds |
| `PORT` | `1444` |
| `SCHEDULED_PRACTICE_HEALTH_PORT` | `1444` |
| `SCHEDULED_PRACTICE_WORKER_ENABLED` | `true`, after restricted credentials are installed |
| `DATABASE_URL` | Dedicated staging practice-worker secret |

Start with the database stream disabled. Verify healthy ticks with no creation,
then let the owner job enable only the disposable practice stream and observe
a complete 45/10/5-second round through the same-candidate API/frontend.

## Acceptance before production activation

1. Check exact-head PostgreSQL 13/16/18 CI, including the actual compiled CLI
   with a dedicated restricted role, native lock/cutoff and immutable-result
   contracts. Passing CI is not a target rehearsal.
2. Verify a healthy paused worker without creation in isolated staging. Enable
   only its practice stream and accept one practice ticket.
3. Restart before/after closing; verify one stored result, recovered tickets and
   no historical backfill. Pause and confirm previously opened rounds finish.
4. Cause a disposable connection failure; verify 503, no partial commit,
   recovery, and a platform restart after 60 seconds without progress.
5. Rehearse deployment/SIGTERM, health withdrawal, disconnect and termination.
6. Check UI countdown, cutoff, refresh and reconnection against staging's API.
   Coin play remains unavailable.

Production activation remains a separate release decision after this evidence.
For rollback, pause the stream first and leave its worker running until all
accepted rounds are drawn; only then stop or roll back the service.

## Disposable staging owner command

`staging-practice-owner` is an explicitly owner-only job, never an API or worker
startup command. It refuses connections except the staging environment
`7de0c716-24df-4e97-a998-ed99abfa256f`, host
`spin-practice-db-20261002.railway.internal`, database
`playqube_spin_rehearsal_20261002`, and acknowledgement
`PRACTICE_STAGING_ACK=spin-practice-rehearsal-20261002`. Native CI has a separate
loopback-only throwaway acknowledgement. The connected account must own the
database. Check with `--guard` before applying any migration.

For `--setup`, set `PRACTICE_API_ROLE`, `PRACTICE_API_PASSWORD`,
`PRACTICE_WORKER_ROLE` and `PRACTICE_WORKER_PASSWORD` only on the owner job.
Use distinct role names `spin_rehearsal_api_20261002` and
`spin_rehearsal_worker_20261002`, with separate randomly generated 64-character
hex passwords installed in secret settings. The API and worker receive their
own complete restricted connection, never the owner's `DATABASE_URL`.

The owner job's first start command is:

```sh
node apps/api/dist/scripts/staging-practice-owner.js --guard &&
pnpm --filter @socialplay/database db:migrate:deploy &&
node apps/api/dist/scripts/staging-practice-owner.js --setup
```

Setup is transactional and repeatable. It refuses elevated, member or owning
roles, applies the existing API runtime-grants function, limits its practice
access to reading rounds and inserting tickets, and grants the separate draw
worker only its required tables/columns. It verifies effective table, column,
sequence, schema and security-definer access, including PUBLIC grants. Existing
excess worker privileges cause refusal and rollback. Setup does not install
an approval key, enable a practice stream or activate Coins.

After setup, `--status` prints only practice availability, recent round IDs,
states/results and an aggregate ticket count. It prints no player identity,
selections or credentials. `--enable` and `--pause` control only the disposable
Spin stream after worker deployment. All failures print a fixed `REFUSED`
status. Keep the owner connection solely in this job, with restart policy NEVER.
No owner secret belongs in the API or draw worker.

Four compiled-CLI native tests cover refused targets/acknowledgements,
repeatable setup with separate logins, effective role boundaries, excessive
privilege refusal and credential-safe output. Platform deployment and recovery
still require target rehearsal; passing these tests does not certify it.

## Candidate validation

Nine focused tests cover readiness, real HTTP health, watchdog timing,
failure/retry, non-overlap and shutdown. CI adds four compiled-worker checks:
restricted access, disabled startup, pause/restart with a stored draw, and
unhealthy-to-healthy recovery. Check the PR for exact-head native CI results.
No staging or production worker activation is included.
