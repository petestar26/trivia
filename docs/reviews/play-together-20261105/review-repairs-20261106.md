# Salem review repairs — 6 November 2026

The seven findings in the independent Salem.bet review are addressed by these
application changes and the storage rollout below. This is a repair record,
not certification of every authenticated or financial workflow.

## Changes

1. Local uploads use a dedicated persistent API volume. Startup on Railway
   rejects a missing volume, a relative/outside storage path, an absent kernel
   mount, or a symlink escaping the volume. The check runs at startup, when
   Railway mounts the volume, rather than during build or predeploy.
2. Configuration rejects S3, R2 and MinIO immediately with a clear explanation;
   the unimplemented provider and misleading environment examples are removed.
   No remote storage implementation is advertised as functional.
3. Chat uses one account-scoped infinite query for all loaded pages. Edits,
   reactions, reconnects and polling refresh every loaded page from authorized
   reads, deriving each cursor from the new page. Deleted rows and reply quotes
   reconcile; viewport anchors preserve the reader's position. Switching
   accounts aborts pending history reads and ignores late success/failure.
4. Game-history failures show an alert and retry action. Failed refreshes label
   retained results; only a successful empty response shows the empty state.
   The two new messages include all seven non-English translations.
5. Ticket creation and reopening enforce the same ten-open-ticket limit under
   the owner's row lock. Staff reopening applies to the owner's limit. Stable
   actor/owner lock order prevents opposing lock upgrades; an already-open
   ticket remains an idempotent no-op even at the cap.
6. Successful voice uploads notify the group after persistence commits. The
   existing broadcast layer rechecks recipients' active membership and session.
   Failed persistence and denied membership do not broadcast.
7. Password recovery offers ordinary `/login`, without trusting a client role
   or exposing recovery credentials.

## Storage inventory and rollout

Target: `PlayQuibe Account Test / account-test`, verified to serve `salem.bet`.
API service: `ffe7dd49-e409-4a46-95a8-7614d2e96095`.
Before replacement, the running Node process used `/app`; both `/app/uploads`
and `/app/apps/api/uploads` contained **zero files**. A read-only aggregate query
found **one voice-message database record**. Its audio was already unavailable
in the old container. This release does not reconstruct that recording or
delete its record. No source audio contents, credentials or member messages
were printed in the inventory.

Volume `salem-api-uploads` (`a7041511-63bc-4278-bd2d-aead15ad4940`), initially
1,000 MB, is mounted at `/data`; `STORAGE_LOCAL_PATH=/data/uploads`. Provisioning
deployment `4f6d148f-3a73-4d82-bbdf-869d8703eb7e` succeeded at source `ebfe845`.
Railway selected that branch head when applying storage configuration; it
contains the previously verified API plus the signup style and release notes.
The separate practice worker and financial activation flags were not changed.

A 59-byte disposable file was written through the real storage provider in the
private voice bucket, without a message or database record. SHA-256 before the
application replacement:
`9d003edc269f4f42c62fccd62babaaf62fad0a62393d1318be15d906b344a04b`.
The replacement API deployment `bfbe2bc1-dc37-4260-9bd8-7453e2db17bd` read exactly
the same 59 bytes and SHA-256 through the real storage provider. The private
storage URL returned HTTP 404 anonymously while the file still existed. The
probe was then removed after a second checksum check. No member message was
created. The existing voice-record count remains one and its audio remains
unavailable, as before the repair.

Persistent storage is not a backup. Keep the volume attached during rollbacks,
retain the absolute path, and use a single API replica. Railway documents a
brief interruption during volume-backed replacements and does not support
replicas with a volume. See [Railway volume guidance](https://docs.railway.com/volumes)
and [volume limits](https://docs.railway.com/volumes/reference).
For a future migration with existing files, stop accepting uploads, preserve and
checksum the files before replacing the old container, restore onto the mounted
volume and verify the database references before reopening uploads. Do not
switch to a currently rejected provider just by changing its environment name.

## Local verification

- Full web run: **2,572 tests in 178 files passed**. The final focused run has
  **35 tests passed**, including two additional late-account-response cases
  added after the full run. Counts overlap; they must not be added as separate
  complete suites.
- Backend repair suite: **36 tests passed**, including three actual concurrent
  PostgreSQL 16 cases on a newly initialized, loopback-only scratch database.
  The remaining checks use PGlite, injected Socket.IO recipients and real
  Fastify multipart routing. No production support tickets were created.
- Configuration/storage package tests: **6 passed**. These cover fail-fast
  providers and byte/metadata retention across provider recreation on disk.
- Both type checks and production builds passed. Gateway/install/recovery:
  **40 passed** against the new web build. Strict translation coverage:
  **3,024/3,024 detected messages**, no missing translations or placeholder issues.
- A dedicated workflow runs the repair suite with Node 20 and PostgreSQL 18,
  plus type, language, build and gateway checks on future relevant changes.
- The production-preview browser checks pass at 390 and 1,440 pixels with
  synthetic data and outside requests blocked. After an older edit, a missed
  deletion and a new message, the reading anchor remains at exactly 391/391 px
  on mobile and 431/431 px on desktop. History outage/retry/empty-state checks
  also pass. The initial fixture returned an object instead of the inbox array;
  correcting that fixture resolved its error-boundary failure without an app
  change. See [browser checks](review-repairs-browser.mjs) and
  [results](review-repairs-browser.json). Run against a local production preview;
  set `PLAYWRIGHT_MODULE` to an installed Playwright module when it is not on
  Node's module path, and optionally `REVIEW_ORIGIN` and `REVIEW_OUTPUT`.

## Hosted verification

[Chat, support and upload regressions 42157301706](https://github.com/petestar26/trivia/actions/runs/42157301706)
passed at exact application commit `e362ca5a613cf2c29baf720689064a939fffbd03`.
Node 20/PostgreSQL 18 passed all 36 backend repair tests (including three native
concurrency checks), six storage/configuration tests, 35 focused UI tests, both
type checks, the strict 3,024-message audit, production builds and 40 gateway/PWA
checks. [Play Together contracts 42157301632](https://github.com/petestar26/trivia/actions/runs/42157301632)
also passed all PostgreSQL 13, 16 and 18 jobs at that exact source.

Both application services now deploy `e362ca5a613cf2c29baf720689064a939fffbd03`:

- API: `bfbe2bc1-dc37-4260-9bd8-7453e2db17bd`, SUCCESS, Node 20.20.2.
- Website: `4e42e849-290c-4711-936a-93c3cacbdb23`, SUCCESS.
- Website and API health endpoints return HTTP 200 with `status: ok`; home,
  ordinary sign-in and recovery return HTTP 200. Anonymous game-history access
  remains HTTP 401. The mounted storage path is `/data/uploads`.
- All four hosting services are online, no staged changes remain, and the
  database and practice-worker deployment identities are unchanged.
- Live `PLAY_TOGETHER_CASH_ENABLED=false` and
  `SOFTAGGREGATOR_SPORTS_LIVE_ENABLED=false` remain unchanged.
- All 32 anonymous public-page checks passed across eight languages at 390 px
  (ordinary/admin/agent sign-in and registration): no overflow, wrong direction,
  unexpected redirect or JavaScript error. Inputs remained empty; 32 refresh
  attempts and 32 outside requests were blocked. No account or financial
  submission was made. See [live public results](review-repairs-live-public.json).

Persistence details are saved in [storage evidence](review-repairs-storage.json).
The final saved synthetic browser harness explicitly blocks WebSocket traffic
as well as outside HTTP requests; its complete rerun passed the same four cases.

The broader [Scheduled rounds run 42157301634](https://github.com/petestar26/trivia/actions/runs/42157301634)
remains red at its native two-connection step on PostgreSQL 13, 16 and 18.
The PostgreSQL 16 logs contain 14 failing and 16 passing native tests. All 14
failing names and the `Native ETB wallet requires ETB pricing terms` error match
the previously inspected [baseline run 42148886579](https://github.com/petestar26/trivia/actions/runs/42148886579).
See the [comparison](review-repairs-ci-baseline.json). This pre-existing fixture
failure remains open; production financial guards were not weakened to pass it.

The first chat run caught a leftover reference during the pagination refactor;
the first type checks caught three test typing issues. These were corrected.
One focused web run timed out at the unchanged five-second limit while the
full web suite and build ran concurrently. The same final 35 tests then passed
alone with unchanged assertions and timeout. Initial local database setup was
blocked from allocating shared memory; rerunning outside that restriction
enabled the isolated native checks. Local Node is 24.15.0, separate from the
hosted Node 20 runtime.

No authenticated live multi-member chat, real password reset, actual payment,
provider wager, financial activation or physical-device acceptance was performed.
