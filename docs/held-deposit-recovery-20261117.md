# Held-deposit recovery (local candidate, 2026-11-17)

Branch `fix/held-deposit-recovery-20261117`, based on `faed9b7`. Not merged, not
deployed, no production data touched. **Every outcome ships switched off.**

## The gap

Disabling a receiving account puts its open deposit orders on a safety hold.
The database then refuses every way of finishing them, so a held order stays
open forever, and three held unpaid orders use up a member's three-order limit.
The hold is deliberate (a payment may have gone to a destination nobody can now
vouch for), so this work never clears it and never expires held orders.

## What was built

- **One adjudication per held order, ever.** A row in `held_deposit_adjudications`
  is the only thing that lets a held order reach a final state. The database
  authorises it at insert and the authority lasts only for that transaction.
  `safetyHold` stays `true` on the order before and after.
- **Who:** an active `SUPER_ADMIN` who is not the buyer or the agent, who has
  claimed the case, is looking at its current version, and has just confirmed
  with an authenticator code bound to that one order. All of this is rechecked
  by a database trigger, not only by the API.
- **Outcomes**
  | Outcome | Order | Agent reservation | Member Coins | Money moved by the platform |
  |---|---|---|---|---|
  | Payment claimed / unknown | stays held | stays reserved | none | none |
  | Verified payment received | COMPLETED | consumed | credited once (PURCHASE + settlement witness) | none |
  | Verified external return | CANCELLED | released to the agent | none | none — records a return that already happened |
  | Verified unpaid | CANCELLED | released to the agent | none | none |

  Releasing a reservation gives stock back to the **agent**. It is never called
  a refund anywhere in the API, screens or records.
- **Unpaid is never inferred.** It needs the member's own "I did not pay"
  statement, no "marked paid", no payment record, no dispute and no late-payment
  report. Silence, missing screenshots or an old order are not enough.
- **Idempotency:** same key + same payload returns the first result; a different
  payload, key or second outcome is refused. Transfer references are unique per
  payment method across both this workflow and late-payment recovery.
- **Completeness:** a deferred database check refuses any adjudication that
  commits without its full effect (order, reservation, settlement, case, claims,
  disputes, trail).
- **Order limit:** held unpaid orders still count. An approved exception of 0–3
  (default 0, capped by the database) lets that many held orders be ignored, so
  a member's open exposure is at most 3 + the exception. The staff queue shows
  open held orders, reserved coins, the oldest case and the most held by one member.
- **Visibility:** members and agents see a plain status only. Reasons, evidence
  and the trail are readable by main administrators who are not a party.
  Ordinary administrators see the queue (amounts, ages) and nothing else.

## Approved nonfinancial reassignment (local implementation)

Peter approved another active, non-party SUPER_ADMIN taking over when the
assigned administrator is unavailable, including an administrator who is still
active. This is explicit self-assignment, not automatic expiry or assignment to
an arbitrary third party. A reason of 10–4000 characters and the displayed case
version are mandatory. The service locks the actor, receiving account, order,
and case in the existing order, then verifies that the order remains held/open
and the case is assigned to somebody else. A stale version is refused.

The same transaction changes only case assignee/time, records an immutable
`CLAIMED` case event with `detail.action = REASSIGNED`, and writes an
`HELD_DEPOSIT_CASE_REASSIGNED` audit entry containing the prior/new assignee,
prior/new version, and reason. It does not clear the hold, change classification,
consume a step-up, resolve the order, or move money/inventory. Old-assignee
commands fail their assignment/version checks after takeover. No new migration
is required. Financial outcomes remain disabled and require separate approval.

The local readiness repair requires the held-policy read used by new deposit
admission, recovery-table SELECT/INSERT capabilities, and mutable case-column
UPDATE capabilities. Missing capabilities block predeploy; this does not apply
grants automatically. The owner grant step is still required after migrations.
The payment CI also covers the held-case screen and the added runtime tests.

## Decisions needed from Peter (nothing below is activated)

1. **Who is the "main admin"?** Implemented as `SUPER_ADMIN`. Should it be a
   narrower named group, or need two people for a credit?
2. **Acceptable evidence** for each outcome (bank statement, provider
   confirmation, agent statement…). Today the form requires at least one item and
   a personal "I checked this" confirmation, but no rule says which kinds suffice.
3. **Is the member's "I did not pay" statement enough** to close an unpaid
   order, or must the agent also confirm nothing arrived?
4. **Wrong amounts.** Under/over-payments and partial returns are refused and
   stay under investigation. What should happen to them?
5. **Who bears a loss, and who performs an external return** (agent, platform)?
   The system only records a return that someone has independently confirmed.
6. **Escalation timing:** how long may a case sit unclaimed or unresolved
   before someone is alerted? No timer exists yet.
7. **Order-limit exception:** keep 0, or approve 1–3?
8. **Settlement label:** a credited case reuses the existing
   `ADMIN_DISPUTE_RESOLUTION` settlement type. A dedicated type needs an enum
   change touching the existing proof guards — wanted?
9. **Notification wording/type** (currently a generic "Payment order update").

## Before any release

- Re-run the owner's runtime-grant step so the application role can read the new
  tables. Without it, **new deposit orders would fail**, because order admission
  reads the policy row.
- Policy changes are owner-only SQL with `approvedBy` and `approvalReference`.
  Where the API itself connects as the table owner, that separation does not
  exist and needs another control.
- Translations in `catalogues/held-deposit-recovery.ts` are drafts and need a
  native-speaker review.
- Recovery: `docs/operations/held-deposit-recovery-rollback.sql` is an emergency
  schema-reversal reference, **not a routine rollback procedure**. Its safety
  guards refuse any adjudication or enabled outcome, but that does not make
  schema reversal compatible with Prisma migration history or application code.
  Never mark a successfully applied migration rolled back, or edit migration
  history manually. Stop and obtain a separately reviewed, tested and approved
  forward-recovery plan, preserving financial and investigation records. That
  plan must cover incompatible writers, backup/restore, application and grant
  compatibility, and post-recovery checks. No recovery execution is authorized
  by this document.
