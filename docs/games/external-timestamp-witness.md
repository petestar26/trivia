# Dormant external timestamp witness and archive

This phase adds RFC 3161 verification of the exact public Spin Win commitment
receipt hash, immutable request/receipt persistence, a public read-only archive,
and an internal bounded submission core. No production caller, scheduler or Coin
admission uses that core. Approved authority and submission endpoint lists remain
empty, so default submission fails before writes or network I/O. No production
authority is implicitly trusted.

The existing Quicknet protocol, rules, payout calculations, financial gates,
existing public draw proof response are unchanged. Runtime setup additionally
denies writes to the new archive tables. This core currently
accepts the Spin proof schema; adapters for other games need their own reviewed
receipt formats. It is not an implementation of all games.

## What the evidence establishes

An independently controlled timestamp authority signs the SHA-256 receipt hash,
its time, declared accuracy, policy and request nonce. A valid token establishes
that the hash existed within that authority's asserted time interval, subject to
trust in its key and clock. The exact receipt includes the round, rules, seed
commitment, opening/closing times and pinned future beacon target.

**A timestamp is not proof of public availability.** It does not prove when a
player received the commitment, that the platform admitted tickets only after
publication, or that an operator cannot withhold a round. Public retention and
retrieval, receipt-bound database admission and monitoring remain separate work.
The verifier is not a substitute for those controls.

## Trust and cryptographic checks

`publication-authorities.ts` defines explicit source-controlled authority
configuration: authority ID, CA certificate, exact signer certificate and its
SHA-256 fingerprint, timestamp policy OID, and maximum acceptable signed
accuracy. Configuration must never come from the submitted proof, request,
database or an operator-controlled platform signing key. The optional explicit
authority argument exists for offline tests and future reviewed callers; it is
not an HTTP parameter or a production fallback.

The implementation requires:

- A canonical SHA-256 request for the current, recomputed receipt hash, an exact
  policy, `certReq`, and a positive nonce no larger than 160 bits.
- A granted response, one CMS signer/digest, SHA-256 digest, and supported
  ECDSA-SHA256 or RSA/SHA256 signature. Granted-with-modifications, extensions,
  unsupported algorithms and structures are refused.
- CMS verification using the pinned signer, explicit CA, timestamp certificate
  purpose and security level 2. Embedded certificates cannot choose the signer;
  the CMS check disables default CA files, directories and stores.
- A second OpenSSL timestamp verification of the original response/query,
  including nonce, imprint, policy and ESS signing-certificate binding. Both
  checks must pass. Certificate validation uses the signed timestamp's nominal
  time; online revocation checks are not performed by this offline core.
- An exact match between the authenticated CMS content and the TSTInfo bytes
  used for metadata validation. Parsed structures are re-encoded and compared
  with the original DER; opaque certificate/attribute values remain original
  bytes authenticated by OpenSSL. `asn1.js` is a pinned metadata decoder, not
  the cryptographic verifier. Its ANY remainder behavior is explicitly bounded.
- Nonzero signed accuracy within the authority's configured maximum (at most
  five seconds). Fractional seconds are preserved to nanosecond precision and
  rounded outward to milliseconds; fractional accuracy is also rounded outward.
  The entire resulting interval must be at or after preparation and strictly
  before the committed cutoff. Missing accuracy, invalid dates, noncanonical
  times and unsupported leap-second encodings are refused.

## Bounded offline execution

Runtime requires Node 20+ and OpenSSL 3+ on Linux. The verifier never makes a network
request. It invokes fixed OpenSSL argument arrays without a shell, with a
five-second timeout and bounded captured output. Requests are capped at 4,096
bytes and responses at 65,536 bytes before copies or decoding. Files use a
private temporary directory and are removed in `finally`, including failures.
Errors expose only `Independent publication witness is unavailable`.

Test fixtures generate their own **test-only** CA and timestamp signer and use
real OpenSSL CMS/TSP signatures. These fixtures are not evidence of an approved
external provider, mainnet timestamps, or production clock accuracy.

## Durable requests and receipts

The forward migration `20261001030000_dormant_publication_storage` creates two
append-only public-evidence tables. It leaves every earlier migration unchanged
and does not update any existing row, gate, stream or payout rule.

`prepareDormantPublicationRequest(owner, roundId, authorityId)` stores one
canonical request per round, including its original query DER, nonce, query
hash, exact commitment receipt and approved authority identity. Concurrent
preparation is serialized using the same stream lock as preparation/draw, then
the round lock. Retries return the identical request bytes; a different
authority ID conflicts with status 409. Provider retries must resend the stored
query, never create a new nonce. New requests must match the current pending
commitment and remain before its cutoff, checked by the database after query
generation. Preparation replay does not require the round to remain open.

`recordDormantPublicationReceipt(owner, roundId, responseBytes)` verifies the
raw DER offline before storing it with its hash, serial and uncertainty bounds.
It snapshots the supplied buffer before the first await, holds the round/stream
locks, and rechecks the current commitment. It accepts the same exact receipt
once, returns verified replay on identical bytes, and rejects different reuse
with 409. New imports require a currently projected OPEN or DRAWN round;
cancelled rounds cannot acquire a new receipt through this helper. Already
archived evidence remains retrievable after any terminal transition.

These are internal owner-run helpers, not HTTP writers or automatically running
jobs. Production calls still fail closed because the authority list is empty.
Optional explicit roots are for reviewed offline/test callers; no HTTP input
supplies trust. Persisted fingerprints, policy and accuracy only compare the
archive with current approved source trust; they never establish trust by
themselves. Rotation/revocation that removes the approved identity makes reads
and imports unavailable until a separately reviewed archival-trust policy exists.

## Dormant bounded submission

`submitDormantPublication(owner, roundId, authorityId)` is an internal, owner-run
helper. It has no API/worker/CLI registration. Trust and HTTPS endpoints come from
reviewed source policy, never the archive, an HTTP argument or an environment
fallback. Explicit policy is for reviewed internal/test callers. Production
`PUBLICATION_AUTHORITIES` and `TIMESTAMP_SUBMISSION_ENDPOINTS` are both empty.
Approving either requires a separate provider/trust review.

Preparation commits the original query/nonce before network I/O. Every attempt
sends exactly those bytes. An existing verified receipt returns its exact archive
without a POST, even after cancellation/cutoff. Before each new POST, the helper
checks the current pending commitment and actual database cutoff. Cancellation
or a changed commitment stops submission. This is not a monitored clock bound
or an admission/public-availability guarantee. A cancellation racing a POST is
rechecked by the existing importer before any receipt commit.

Each RFC 3161 POST uses normal TLS certificate/hostname validation, fixed binary
content types, no redirects or URL credentials, no compressed body, an 8,192-byte
header bound and a 65,536-byte response bound while streaming. Its absolute
deadline is at most five seconds (including DNS, TLS, headers and trickling body),
shortened to the remaining database window. Requests are at most 4,096 bytes and
the supplied buffer is copied before awaiting. Safe errors expose no endpoint,
provider response, credential or TLS/socket message.

There are at most three attempts per invocation, with 100/250 ms waits. Only
selected transient transport errors and HTTP 502/503/504 are retried. HTTP 429 is
terminal until service/rate-limit policy is explicitly reviewed; untrusted
Retry-After values do not control the delay. TLS failure, redirect, invalid
headers/body or cryptographic verification failure is terminal. A later
invocation reuses the durable query, never a fresh nonce. This bounds network
attempts, not total database/cryptographic execution time or aggregate concurrency.

No database transaction/round lock is held during a POST. Every successful body
still goes through real CMS/TSA/ESS verification and the owner-only atomic
importer. Concurrent processes may receive different valid replies to the same
query; the first verified commit wins. A loser returns that exact reverified
stored archive, never overwrites it. This guarantees one archived receipt, not
one provider call or free provider retries. Multi-process rate limits, service
usage, credentials/billing and independent retention remain unimplemented.

Owner-only row triggers reject UPDATE/DELETE, and statement triggers reject
TRUNCATE. Size/hash/linkage constraints supplement service verification. SQL
cannot verify CMS/TSA signatures: an owner could insert fraudulent DER or change
derived metadata with elevated privileges. Public reads repeat real CMS/ESS,
nonce/imprint and signed-time verification and compare every stored derived
field, so neither such row is accepted as a verified witness. Runtime setup
revokes table and column writes and rejects remaining writes through inherited
or assumable roles. The archived setup function has no runtime EXECUTE grant.

## Read-only public archive

```text
GET /api/v1/games/scheduled/spin-win/proofs/:roundId/publication
```

The response is `{ success: true, data: archive }`, with schema
`playqube-spin-publication-v1`, the archived pending commitment proof, approved
authority ID/pins/policy/accuracy, the request DER as base64 and its SHA-256 hash,
and either a null receipt or verified response DER/serial/time interval. This
JSON can be saved for independent verification against separately trusted
certificates. It contains no unrevealed seed, signing key, credential or CA
selected by a submitted proof. The nested pending proof describes the original
receipt, not the current round's state or result; use the existing proof endpoint
for current draw status.

Unknown archives return 404. Unapproved trust or failed verification returns a
generic 503. GET executes only bounded parameterized SELECTs, creates nothing,
uses no owner connection, and verifies raw artifacts again on every read. It is
rate limited to ten requests per minute per the existing server rate-limit
configuration, with `Cache-Control: no-store`. Unique-proof CPU cost and retention
infrastructure still need review before activation.

Serving this endpoint makes evidence retrievable from the platform; it does not
establish independent public retention, prove earlier availability, or enforce
admission chronology. No Coin writer calls the archive or witness helper yet.

## Portable player archives and offline verification

The public Spin Win verification page offers **Load timestamp archive** and
**Download timestamp archive**. It checks strict structure, the pending
commitment hash, binary query/reply hashes, and an optional earlier saved
commitment. It never authenticates CMS/TSA signatures or labels the supplied
clock interval verified. A null reply is shown as request-only evidence. Reads
use the public GET without credentials, an eight-second deadline and a streamed
196,608-byte JSON limit plus 4,096 bytes for the response envelope. Editing inputs
clears stale download/verification results.

A SHA-256 match is integrity evidence, not authentication. The browser can accept
arbitrary reply bytes whose declared hash matches. Use the offline verifier for
actual CMS/TSA/ESS, nonce/imprint, policy, certificate and signed-time checks:

```sh
pnpm build:packages
pnpm --filter api exec node build.js
node apps/api/dist/scripts/publication-receipt-verify.js \
  --file=downloaded-archive.json --commitment=EARLIER_SAVED_COMMITMENT_HASH
```

The hash must be the 64 lowercase hexadecimal characters from a commitment the
player saved independently earlier, not a hash copied from the archive being
verified. Otherwise consistency alone cannot establish continuity with the
original observed terms. The file is capped at 196,608 bytes and read from one
nonblocking regular-file descriptor; growth and special files fail safely. Query
DER is capped at 4,096 bytes, response DER at 65,536, and base64 must be canonical.

The CLI performs no database or provider request. It uses the same real offline
CMS/TSA/ESS verifier and separately approved source certificates as the server.
Uploaded pins, PEM certificates, endpoints and ambient CAs cannot supply trust.
No CLI option overrides trust. Production trust remains empty, so the shipped
command returns safe `BLOCKED` metadata until a provider is separately approved.
With approved trust it exits 0 only for `VERIFIED_TIMESTAMP`; a request-only
archive is `REQUEST_ONLY`, exit 1. File/verification failures also exit 1 with
`BLOCKED`; invalid arguments exit 2. Neither failure includes the path, archive,
provider data or credential.

A player download is portable evidence, not independent public retention or a
promise of service availability. External retention, source trust approval,
clock monitoring and receipt-bound financial admission remain separate tasks.

## Pure admission precondition

`requireWitnessedAdmission` accepts only a frozen witness returned by this module
in the current process, for the same recomputed receipt hash and a pending round.
A copied/deserialized object must undergo full verification again. It requires
an explicit database clock error bound between zero and five seconds.

Let `witnessUpper` be the latest time permitted by the signed uncertainty and
`clockError` the independently enforced error bound. It requires:

```text
witnessUpper < databaseNow - clockError
opening <= databaseNow - clockError
databaseNow + clockError < closing
```

This helper is currently **unused by Coin writers**. A future integration must
lock and re-read the current round and commitment, enforce a monitored clock
bound, verify against the current approved trust policy, bind the exact receipt
to the ticket, and commit admission and financial holds atomically. Calling this
pure helper alone does not meet that release contract.

## Before any financial activation

1. Approve a genuinely independent TSA, service usage, policy, clock accuracy,
   certificate chain/pin rotation and revocation/compromise handling. Add pins
   through a reviewed change; missing or unavailable authority must stop new
   admission rather than fall back to local time/signatures.
2. Review and integrate the dormant bounded submission core with an approved
   provider, multi-process rate limits and service usage. Implement independent
   public retention. Portable player downloads and offline verification now
   exist, but the browser does not authenticate TSA signatures. Local
   persistence/retrieval and downloads do not prove independently witnessed
   public availability.
3. Integrate receipt-bound admission transactionally, with database clock
   monitoring, concurrent recheck and rollback/replay regressions.
4. Re-review runtime-role enforcement, jurisdiction/gates, capital reservation,
   per-round exposure limits, settlement/refund recovery and unattended workers.

These are remaining tasks, not conditions verified by this PR. Coin wagering
remains disabled.

## Focused validation

```sh
pnpm build:packages
pnpm --filter api exec vitest run --config vitest.economics.config.ts \
  src/games/economics/publication-witness.test.ts \
  src/games/economics/rfc3161-codec.test.ts \
  src/games/economics/publication-transport.test.ts
```

The existing scheduled-rounds PostgreSQL 13/16 workflow also includes these pure
economics tests and the native publication archive tests. No database,
credentials, external provider or production environment is needed for the pure
command above. Native tests use an acknowledged loopback throwaway cluster:

```sh
NODE_ENV=test SCHEDULED_NATIVE_DB_ACK=throwaway \
DATABASE_URL=postgresql://OWNER@127.0.0.1:5432/playqube_scheduled_throwaway \
pnpm --filter api exec vitest run --config vitest.scheduled-native.config.ts \
  src/games/economics/publication-store.native.ts
```

After deploying the migration, run the documented owner-run
`ledger:runtime-access` setup before starting the API/worker with its restricted
role. That setup applies the forward archive restrictions and verifies them
transactionally. Never provide the owner credential to the API/worker. Nothing
in this phase authorizes wagering activation.

Primary protocol references:

- [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html)
- [OpenSSL timestamp query and verification](https://docs.openssl.org/3.0/man1/openssl-ts/)
- [OpenSSL CMS verification](https://docs.openssl.org/3.0/man1/openssl-cms/)
