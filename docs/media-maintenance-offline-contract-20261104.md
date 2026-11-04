# API media maintenance: offline implementation contract

This code does not install a production maintenance boundary. The first API
replacement remains **BLOCKED**: the currently running API has no such gate, and
replacing it could discard ephemeral uploads. Independent exclusion/drain of all
old writers, or a verified recovery copy that preserves their writes, must be
established before that first replacement. No provider, application, database,
SSH, deployment, credentials, feature flags, or financial flags were changed.

## Admission and receipt scope

The actual POST `/api/v1/groups/:id/voice-messages` and DELETE
`/api/v1/groups/:id/messages/:messageId` acquire server-owned admission in
`onRequest`, before authentication's database read, multipart parsing, or route
DB/storage work. They share one gate for the underlying Fastify HTTP server.
Every admitted request is counted. Its handler releases exactly once in
`finally`, after all awaited service/transaction/storage work, upload
compensation, DELETE notification authorization reads and postcommit storage
cleanup, and voice activity recording. Reply completion, disconnection, and
abort never release a running handler or authentication callback.

Authentication early replies/errors/aborts settle only after its actual Promise
settles; any released request is forbidden from entering a handler. An unknown
earlier asynchronous hook that replies before authentication cannot be proven
settled by a response/socket event. It conservatively retains admission and
prevents a successful drain. Current production media routes have no such
preValidation hook. Any future hook must explicitly account for its work before
supporting that lifecycle path.

An upload rejection can leave partial bytes. It records terminal uncertainty
without blind deletion. Failed upload compensation or failed DELETE cleanup
also records terminal uncertainty, despite retaining the existing request's
best-effort error semantics. A configured gate closes durably on these failures;
zero active operations cannot erase that uncertainty or yield `drained:true`.

Receipts contain only counters, outcomes, a random server incarnation and exact
available non-secret Railway identity: project/environment/service/deployment
IDs, replica ID, and replica region (missing values are null). The four primary
IDs must be UUIDs for operational readiness. Scope is explicitly
`single-api-server-instance-only`: no claim covers other processes, API servers,
replicas, workers, old deployments, other mutation surfaces, or fleet exclusion.
Read-only audio downloads and unrelated routes are not fenced.

## Configured local control

When `MEDIA_MAINTENANCE_DIRECTORY` is absent, existing application operation
continues and no operational drained receipt is possible. When configured, the
directory must already exist, be canonical and absolute, be owned by the API
UID, and deny group/other access. Linux and Node >=20.8 are required; there is no
transport fallback. All protected files must be regular, owned by that UID,
single-linked, deny group/other access, and fit the bounded input size. Files
are opened with no-follow/nonblocking flags and bounded reads.

The following is a schema contract, **not an enrollment recipe**. Independent
production credential delivery and durable enrollment remain unestablished.
Tests generate disposable, unrelated operator/server key pairs only.

| File | Required content / behavior |
| --- | --- |
| `authority.json` | Version 1, installation UUID, exact `railway` object, canonical public-only Ed25519 `operatorPublicKey`, separately enrolled `serverPublicKey`. Operator and server keys must differ. |
| `server-key.json` | Protected versioned object with `serverPrivateKey`; its derived public key must match the enrolled server public key. The API never receives the operator private key. |
| `state.json` | Version 1, installation UUID, status `enrolled` for one externally established first start; it is durably changed to `consumed` via its verified held file descriptor before admission can open. Invalid/torn/missing content is terminal. |
| `consumed.json` | Created exclusively, file+directory fsynced, binding the first incarnation and exact identity. Existing records are never overwritten or reset. Loss of this record after grant consumption cannot recreate enrollment. |
| `closed.json` | Created exclusively and fsynced before a successful close/drain; binds the same installation, incarnation and identity. Conflicts require recovery. |

All reads/record creation use a held directory descriptor through `/proc/self/fd`.
Original directory identity and authority/state/key/consumed/closed content and
file identities are revalidated at receipt boundaries, including after the last
in-flight operation settles and on repeated requests. Newly created records
must still match the owned descriptor and exact intended bytes. The code never
unlinks paths, removes stale control files, overwrites an existing record,
renames over mutable files, or resets/reopens enrollment. No force/test bypass
exists in application code.

After any restart with consumed enrollment, the new incarnation is closed and
recovery-required, even if its local count is zero or the old incarnation once
issued a successful receipt. Missing/ambiguous recovery records refuse startup.
Neither restart nor timeout reopens admission. Complete disk rollback, removing
configuration, replacing authority/state with a wholly new valid enrollment,
or a compromised file owner cannot be excluded by a local journal. Durable
storage continuity and configuration enforcement are external prerequisites;
this implementation makes no global fence claim.

The transport is an abstract Unix socket named from the installation UUID.
Any process in its local network namespace can attempt a connection; abstract
sockets have no filesystem ACL. Mutual Ed25519 authentication supplies the
boundary. Sockets, frames, pending authenticated commands, and absolute
monotonic challenge lifetime are bounded. No public HTTP route, user/admin JWT,
browser flag, automatic reopen, remote relay, or arbitrary force input controls
the gate. Filesystem socket creation/deletion is unnecessary.

The operator supplies a fresh request UUID. The server signs a greeting binding
that UUID, challenge, incarnation, and exact identity. The operator signs only
after checking the greeting against an independently pinned incarnation,
identity, installation and server public key. The server verifies the full
close-and-drain command and signs the correlated result. The packaged
`media/operator-client.js` helper `closePinnedMediaTarget(target, operatorKey,
timeoutMs)` implements these checks; its input must come from trusted operator
records, never from the greeting. Wrong server keys, modified receipts, stale
request UUIDs and target mismatches are refused. It returns a verified signed
envelope, including nonready outcomes; callers must inspect `receipt.drained`.

The bounded close budget starts before any latch work, uses a monotonic clock,
and is checked after awaited work and immediately before readiness eligibility.
The signed control result additionally checks the original command budget
after complete signing/serialization and before local socket enqueue; expiry
produces a signed timeout with `drained:false`. Kernel/network delivery time is
outside that publication observation. The client also enforces its own bounded
acceptance deadline after signature verification. A receipt is a discrete
observation, not continuous filesystem or infrastructure exclusion.

## Validation and limitations

Pinned package manager: `corepack pnpm` resolves to **8.15.9**. Existing local
dependencies/generated package outputs are reused through untracked symlinks;
no dependencies, lockfiles, generated artifacts, or credentials are committed.

| Check | Result |
| --- | --- |
| `corepack pnpm --filter api exec vitest run --config vitest.media-maintenance.config.ts` | 37 focused tests pass: 9 actual-route/service regressions, 6 admission/deadline tests, 22 local-control/state/client tests. DB/storage/auth are offline fixtures. |
| First focused run | 14 passed, 8 failed: the managed runtime rejects native AF_UNIX creation/bind with EPERM (also verified with native Node and Python probes). No production fallback was added. |
| Control transport fixture | `vi.mock(node:net)` maps abstract names to actual loopback streams only in the test file; real framing, crypto, startup, journal and control logic run. Native AF_UNIX success is **UNRUN** here and must be verified in the intended runtime. A separate native test records support/refusal. |
| Development deadline regression | Independent root probe returned `drained:true` after 71.09ms for a 10ms budget. Two preserved 35ms blocking latch/validation tests initially failed with false successful receipts, then passed after monotonic checks. A 35ms signing/20ms publication test now receives signed timeout/false. |
| API production bundler: `corepack pnpm --filter api exec node build.js` | Pass. Includes the authenticated operator helper entry. |
| API `tsc --noEmit --pretty false`, same dependencies on clean bc0da84 baseline and this branch | Both report 1005 inherited diagnostics. No media-source diagnostics remain; normalized comparison differs only in property display ordering inside the same unchanged baseline error. This is not a clean full API typecheck. |
| Existing database-backed chat authority suites | Not run: they contact a database, outside this offline task. No full platform suite was run. Root will run selected existing offline suites after integration. |

Installation is still **NO-GO** pending old-process exclusion/drain or verified
recovery copy, actual local socket execution in the target runtime, durable
configuration/storage continuity, independent authority enrollment and trusted
operator target/key delivery, and independent review. A Mac-to-host SSH relay
and credential delivery are not implemented. The existing 60-test canary remains
a separate local fixture and is not integrated into application code.
