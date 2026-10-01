# Dormant external timestamp witness core

This phase adds offline RFC 3161 verification of the exact public Spin Win
commitment receipt hash. It does not submit anything to a timestamp service,
publish or persist a proof, start a scheduler, or change Coin admission. The
approved authority list is empty. No production authority is implicitly trusted.

The existing Quicknet protocol, rules, payout calculations, financial gates,
runtime grants and public proof response are unchanged. This core currently
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

Runtime requires Node 20+ and OpenSSL 3+ on Linux. The core never makes a network
request. It invokes fixed OpenSSL argument arrays without a shell, with a
five-second timeout and bounded captured output. Requests are capped at 4,096
bytes and responses at 65,536 bytes before copies or decoding. Files use a
private temporary directory and are removed in `finally`, including failures.
Errors expose only `Independent publication witness is unavailable`.

Test fixtures generate their own **test-only** CA and timestamp signer and use
real OpenSSL CMS/TSP signatures. These fixtures are not evidence of an approved
external provider, mainnet timestamps, or production clock accuracy.

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
2. Implement bounded submission/retry, idempotent proof persistence, public
   retrieval/retention, saved player receipts and independent verification.
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
  src/games/economics/rfc3161-codec.test.ts
```

The existing scheduled-rounds PostgreSQL 13/16 workflow also includes these pure
economics tests. No database, credentials, external provider or production
environment is needed for this focused command.

Primary protocol references:

- [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html)
- [OpenSSL timestamp query and verification](https://docs.openssl.org/3.0/man1/openssl-ts/)
- [OpenSSL CMS verification](https://docs.openssl.org/3.0/man1/openssl-cms/)
