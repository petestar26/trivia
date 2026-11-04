# Standalone system-practice worker (not deployed)

This opt-in entrypoint schedules only Sky Crash, Crash Point, Thunder Derby,
Virtual Football, System Dice and System Keno. It does not start the API, accept
requests other than health probes, or import the full group worker. Number,
group PVP, social-group expiration, scheduled Spin and Trivia are excluded.
Existing gameplay, API route flags, database grants and other workers are unchanged.

The built entry is `apps/api/dist/scripts/system-practice-worker.js`; the
package script is `worker:system-practice`. The service adapter is a separate
build output next to the entry. Keep both artifacts from the same reviewed
build. The CLI's adapter import remains external during bundling so importing
the CLI, `--help`, and disabled admission do not load Prisma or game modules.
No service is enabled by this addition, its build, or an API startup.

## Admission

`SYSTEM_PRACTICE_WORKER_ENABLED` must equal the literal string `true` and at
least one of these flags must equal the literal string `true`:

| Family | Flag |
| --- | --- |
| Sky Crash | `SKY_CRASH_PRACTICE_ENABLED` |
| Crash Point | `CRASH_POINT_PRACTICE_ENABLED` |
| Thunder Derby | `THUNDER_DERBY_PRACTICE_ENABLED` |
| Virtual Football | `VIRTUAL_FOOTBALL_PRACTICE_ENABLED` |
| System Dice | `SYSTEM_DICE_PRACTICE_ENABLED` |
| System Keno | `SYSTEM_KENO_PRACTICE_ENABLED` |

An undefined family flag or literal `false` is disabled; malformed family flag
values refuse admission. Other workers' flags cannot select extra jobs. Disabled
master or all-disabled families refuse before module loading, clients, service
factories, listeners or timers. Family selection is snapshotted at startup.

`DATABASE_URL` must be a PostgreSQL URL and must reference a separately verified
restricted runtime role. URL syntax validation does not authenticate the target,
establish schema completeness or prove least privilege. Do not supply owner or
application JWT/refresh/payment/provider secrets to this worker. It does not
import the global API configuration or require those secrets. Use protected
credential delivery; diagnostics never print the URL.

The health listener uses `SYSTEM_PRACTICE_WORKER_PORT`, then `PORT`, then `3011`.
Configured ports must be integers from 1 through 65535. Bind the listener only
within the reviewed service network; no public game route is provided.

## Supervision

Each enabled family has its own sequential loop with a one-second wait between
passes. Families can progress independently; a pass never overlaps its own next
pass. A service callback reporting a per-ticket error makes the whole pass fail,
even when the existing service catches the error and resolves its tick promise.
Only fixed event/family labels are logged, never callback identifiers, raw errors,
queries, outcomes, connection strings or stacks.

`GET /health` and `HEAD /health` return 200 only after every enabled family has
completed a successful pass and remains healthy. One family's success cannot
clear another's failed/stale status. Readiness becomes stale at 30 seconds without
a successful pass; a watchdog stops the process when any enabled family reaches
60 seconds without success. A first tick that hangs is also supervised and
attributed to its family. Health reports scheduler progress, not game acceptance,
financial readiness or successful settlement of every historical record.

SIGTERM/SIGINT withdraw readiness immediately, close the health listener, prevent
new passes and wake between-pass waits. In-flight work may finish within one
25-second shutdown deadline that also covers resource acquisition, health close
and client disconnect. Startup has a separate 25-second limit. Delayed startup
resources retain ownership and are closed when available; unresolved acquisition,
work or cleanup is reported as `UNCONFIRMED`, followed by nonzero process exit.
An adapter rejection has no returned cleanup receipt and is conservatively
`UNCONFIRMED`. Timeout or process exit is not proof of remote transaction
cancellation or backend cleanup. The JavaScript supervisor cannot preempt a
blocked event loop; platform termination remains an independent boundary.

Configure a termination grace period longer than the shutdown deadline and
separately verify health probing, restart policy, resource limits and actual
backend cleanup. Do not run this alongside another scheduler for the same enabled
families without reviewing concurrency and ownership.

## Required acceptance before enabling

This worker remains undeployed. Before a future reviewed rollout, establish the
exact environment/database identity, migrations and constraints, protected runtime
credential custody, restricted effective grants for only the selected practice
families, compatible immutable runtime, capacity, one scheduler owner and failure
recovery. API route flags require their own reviewed deployment/selection; worker
success cannot make a disabled API route available.

Use disposable fixtures to verify lifecycle, callback failures, constraints,
disconnects and real database permissions before accepting an actual runtime.
Then perform separately authorized end-to-end practice validation for each
selected game. No current media preservation, maintenance, recovery or financial
gate is changed or satisfied by this offline implementation.

## Focused offline verification

`pnpm --filter api test:system-practice` covers admission, static dispatch,
per-family health, callback errors, watchdogs, deadline and startup ownership,
bounded stop, and sanitized failures using mock clients and ticks. Separate
native-local controls exercise built CLI processes with the adapter absent and a
loopback health socket. They perform no real Prisma query or game tick and are
not native PostgreSQL, deployment, device or live gameplay acceptance.
