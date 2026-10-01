# Public Spin Win commitments and player verification

This is a dormant transparency phase. It adds a public read-only proof endpoint,
downloadable JSON receipts and an offline browser verifier for explicitly prepared
`sha256-quicknet-rejection-u32be-v2` financial rounds. It creates no financial
streams, starts no financial scheduler, changes no payouts and enables no gate.
Practice and historical seed-only rounds use different protocols and are excluded.

## Public contract

`GET /api/v1/games/scheduled/spin-win/proofs/:roundId` requires no login. The
identifier is 1–128 characters from letters, digits, underscore, colon and hyphen.
The endpoint is rate limited to 30 requests per minute and returns `Cache-Control:
no-store`. Reads never create or advance a round, seed, beacon, ticket or wallet.

A successful response is `{ success: true, data: proof }`. The strict proof has:

- `schema`: `playqube-spin-proof-v1`.
- `commitment`: round and rules IDs; fixed protocol and chain hash; opening,
  cutoff, pin and preparation times in epoch milliseconds; seed commitment;
  exact future beacon round and scheduled time.
- `commitmentHash`: lowercase SHA-256 of the ordered receipt frame below.
- `stage`: `PENDING` or `DRAWN`.
- `reveal`: null while pending; after a committed draw, the seed, outcome,
  drawn time and exact beacon round/signature/randomness.

An imported beacon alone does not reveal the seed. Missing, unprepared,
practice, cancelled and historical seed-only rounds return 404. Malformed IDs
return 400; IDs exceeding the router's 128-character bound return 404 before
route validation. A terminal proof that fails timing, commitment, real BLS or outcome
verification returns a safe 503 without revealing its contents.

Successful beacon-signature verifications are memoized in each API process for
at most five minutes, with a maximum of 128 entries. Identical in-flight checks
share the work; failed verifications are discarded. The key includes every
beacon-verifier input and the protocol/chain/public-key pins. Every request still
reads the current database projection, validates its receipt and timing, checks
the current seed commitment, and reproduces its outcome. Proof responses and
database rows are never cached. Per-IP rate limiting remains in place; this cache
does not provide a global CPU budget for unique proofs.

The endpoint uses the normal restricted runtime connection. A narrow STABLE,
SECURITY DEFINER function `public.house_public_spin_proof(text)` reads one
snapshot. It uses `search_path=pg_catalog,pg_temp`, qualified objects and no
writes. Its public EXECUTE privilege exposes only these intended public terms;
the runtime retains no SELECT on `house_round_randomness`. No user, ticket,
wallet, approval, capital or credential data appears in the projection. I3 checks
the function's strict search path.

## Receipt encoding

The receipt frame is UTF-8 with the following lines, joined by LF and **no final
LF**. Integer values use their base-10 representation, without padding:

```text
playqube:spin-win:public-commitment:v1
roundId
rulesId
protocol
chainHash
opensAtMs
closesAtMs
pinnedAtMs
preparedAtMs
seedCommitment
beaconRound
beaconTimeMs
```

Each item above is the field's value, not its name. Identity and hexadecimal
fields cannot contain line breaks. The hash stays identical between a saved
pending receipt and the corresponding drawn proof. It is an identifier of the
terms, not an operator signature or trusted timestamp.

Seed commitment and draw framing retain the existing v1 and v2 domain strings
and encodings from [future-beacon-recovery.md](future-beacon-recovery.md).
Protocol pins, target selection and canonical-signature rejection now live in
`packages/shared/src/spin-win-proof.ts`; the API re-exports the original names.
The production chain, public key, cutoff offset and payout rules are unchanged.

## Player workflow

The public page is `/games/spin-win/verify`; scheduled practice links to it.
It needs no account, stake or deposit. Use HTTPS (or localhost) for Web Crypto.
If browser cryptography is unavailable, the page explains this requirement and
does not label the proof invalid or verified.

1. Enter a financial round ID and load its pending public proof, or upload/paste
   a JSON proof. Files and pasted JSON are limited to 32 KiB.
2. Select **Verify locally**. A pending receipt checks structure, target,
   timing and receipt hash; it is labelled **awaiting draw**, not a verified result.
3. Download the commitment receipt before joining a future financial round.
   Retain a separate dated copy if publication timing matters.
4. After the draw, load its proof and upload/paste the earlier receipt. Local
   verification checks that receipt terms did not change, the seed matches its
   commitment, the exact pinned quicknet signature is canonical and valid
   under the shipped public key, and the rejection sampler reproduces the outcome.
5. Download the verified proof. Verification uses the supplied beacon offline;
   it does not fetch a latest beacon, accept relay metadata or place a wager.

The browser has its own Web Crypto SHA-256 implementation and real drand BLS
verification. It rejects modified fields, alternate signature encodings,
unsupported rules/protocols and conflicting receipts. This checks draw
consistency; it does not verify a ticket payout, available capital or payment.

## Migration and validation

The forward migration `20261001020000_public_spin_proofs` adds only the projection
function and its EXECUTE grant. All 71 migrations from exact merged parent
`ef3a026b6d208118932b76119fe165f866584ab0` remain byte-identical. The upgrade test
checks their framed digest, applies only the new migration, preserves customer
rows and existing private commitments, verifies runtime setup and deploy replay.

Native tests run through a separately provisioned non-superuser runtime role:
private seed SELECT is refused; pending reads return no reveal; an imported
beacon does not reveal a seed; a real-BLS draw yields matching receipt terms;
forged terminal proofs fail closed; repeated GETs leave financial fingerprints
unchanged. The historical real-beacon fixture transplants only clock metadata
in a transaction-local replica setup; production reads and draws keep all triggers.
CI includes these tests and the browser contracts on PostgreSQL 13 and 16.
It also checks that the API resolves shared types from built declarations,
preventing new shared modules from adding root-directory diagnostics. Build the
workspace packages before API typechecking. Unrelated legacy API diagnostics
remain separate from this shared-package boundary check.

## Activation prerequisites remain

Saving a receipt proves which terms a player observed. A hash or operator-supplied
timestamp alone does **not** prove independent publication before admission.
An independently retained publication acknowledgement and admission bound to
that acknowledged receipt are still required before accepting live stakes.
This phase does not implement that witness or alter admission.

Unattended financial scheduling, clock-drift monitoring, outage handling,
house-capital reconciliation, jurisdiction approval and target owner/runtime
configuration also remain separate activation gates. Keep Coin wagering off
until those controls and their independent release review are complete.
