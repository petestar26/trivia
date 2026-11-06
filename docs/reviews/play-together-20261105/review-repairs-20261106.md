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
Post-replacement verification is recorded when deployment finishes.

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
