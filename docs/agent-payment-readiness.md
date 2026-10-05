# Agent payment setup readiness

Receiving-account setup previously required customer payments to be enabled. This prevented agents from preparing destinations while the country was paused. Active countries now permit receiving-account submission and correction for administrator review; customer deposits, withdrawal quotes and withdrawals retain their independent payment-enabled checks.

## Interface changes

- Receiving-account records show the owner's destination details, readable field labels, status and reference.
- Agents can edit eligible accounts through the existing owner-only endpoint. Saving returns the account to pending administrator approval.
- Disabling requires an explicit confirmation and preserves account history. Suspended agents can still disable their own eligible destinations.
- Unverified, blank and stale account drafts cannot be submitted. Timed-out requests refresh the authoritative records and clear the draft without an automatic mutation retry.
- Agent creation, temporary-credential replacement and private-password activation have bounded requests. Password fields are cleared immediately, and uncertain outcomes direct the operator to verify the current state before retrying.
- Administrator setup copy includes administrator-created agents as well as reviewed applications.

## Verification

The new paused-country setup regressions failed before the server correction. Local verification passed 145 API review tests and 36 focused frontend tests, both project typechecks, API build and web build. The existing web bundle-size advisory remains.

The GitHub PostgreSQL 13/16/18 matrix includes the new database-backed receiving-account lifecycle regression and frontend tests. Its final result and staging deployment identifiers are recorded in [pull request 33](https://github.com/petestar26/trivia/pull/33).

Read-only browser verification confirmed an authenticated approved agent workspace, the receiving-account and processing screens, and denial of administrator controls to that agent. Real destination creation, review, deposits and withdrawals were not performed during these checks.

## Configuration and deployment

These changes require no new database migration or environment variable. Deploy the API and web revision together to the isolated staging environment.

An operator must supply real receiving-account details for administrator approval, a verified current exchange rate and genuinely backed Coin inventory/fiat liquidity before opening customer payments. Telebirr, M-Pesa and CBE Birr are agent-assisted payment methods. Direct crypto provider integration remains separate, unfinished work.
