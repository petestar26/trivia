# Third review follow-up: refresh and chat edge cases

The attached external review, `Pasted text(20261004-004139).txt`, verified exact commit `d3fb63c7c7fcf59c6c062078a44b446ab0f60848` and its private bundle. Its final verdict is **GO for isolated-staging acceptance**, with deployment still blocked by operational prerequisites. It reports all previous F1–F8 findings closed, with three low-severity residuals.

## Residual fixes in this revision

| Finding | Change | Regression evidence |
| --- | --- | --- |
| L1: stale refresh token consumes the live account quota | The limiter verifies the signature, then uses an indexed session lookup. The account bucket requires a matching user, unexpired stored session, ACTIVE account and matching tokenVersion. Rotated/missing/revoked sessions use the anonymous bucket. Cookie origin validation precedes that lookup; the handler still performs its own authoritative session checks and atomic rotation. Database lookup errors propagate. | Both cookie and JSON tests rotate a token, reject ten old-token requests, limit the eleventh old-token request, and still renew the live token successfully. Existing 20-account isolation, rotation quota, origin and invalid-token cases pass. |
| L2: hide retry reports an error after a lost success response | A 404 from the hide request is treated as the already-absent state. The dialog closes and messages/inbox refetch. Other failures retain the error and message. | Lost-response followed by 404 completes; a real 403 remains visible. The authorized API delete contract is unchanged. |
| L3: deletion clears every reader's older history | A validated deletion ID removes only its matching older message and pending reply. Pagination stays intact; latest messages still refetch from the authorized API. | A deletion preserves the other loaded older messages, preserves exhausted-pagination state and does not scroll a reader who is away from the newest messages. Malformed event IDs do not clear history. |

## Verification boundary

This revision's local checks pass:

- Cookie/session tests: **15/15**.
- Message-page tests: **14/14**.
- HTTP gateway identity and worker tests: **16/16**.
- Total: **45 unique cases**, with no skips. The repeated message-page run is not counted twice.
- Web TypeScript check (part of its production build), web production build and API bundle build pass.
- Full API TypeScript remains at **324 existing diagnostics**; it is not reported as green. No diagnostic remains in the modified rate-limit identity helper.

No database schema, trigger, ledger, game settlement, fee policy, or financial activation gate changes in this revision. No PostgreSQL suite or GitHub CI run was performed locally for this revision.

The external reviewer reports these results for **d3fb63c**, not the revised head:

| Suite | PostgreSQL 13 | PostgreSQL 16 | PostgreSQL 18 |
| --- | --- | --- | --- |
| Native games/gifts/social/rewards | 65/65 | 65/65 | 65/65 |
| Two-connection | 30/30 | 30/30 | 30/30 |
| Ledger | 124/124 | 124/124 | 124/124 |
| Fresh/populated migrations | 55 pass, 1 documented PG16-only skip | 56/56 | 56/56 |
| Financial | 70/70 | 70/70 | 70/70 |
| Practice staging / runtime identity / practice worker | 9/9, 3/3, 4/4 | 9/9, 3/3, 4/4 | 9/9, 3/3, 4/4 |

That reviewer also reports 728/728 broad group/chat API tests on fresh PG16, successful restricted lifecycle-role grants, moderation/gift probes, and 80 ready-versus-removal/leave races covering both orderings without stranded paid entries, deadlocks or 500s. These results are attributed external evidence; no review probes or logs were supplied as executable artifacts.

## Next step: isolated staging

The changes are ready for exact-commit CI and the existing staging acceptance process. The remaining prerequisites are:

1. Explicit authorization to publish source to the public `petestar26/trivia` repository. Automatic approval review previously rejected public-source upload because that authorization was absent. No alternate publication path was attempted.
2. Run CI on the exact new commit. The external matrix mirrored the workflow but was not GitHub CI.
3. Inspect backfill impact and runtime roles, run owner migrations, and apply only the missing lifecycle column grants using the existing documented owner procedure. Do not reset roles or use staging for destructive native tests.
4. Configure matching dedicated gateway secrets and prove Railway replaces spoofed X-Real-IP before selecting railway mode.
5. Test two accounts and real devices: refresh/reconnect, countdown, closure, moderation, gifts, microphone/voice and keyboard/IME behavior.

No source was uploaded, no deployment was performed, and financial activation remains off. The existing product gaps—finite practice balances, voice receipts, round-only removal of idle players, multi-tab polling coordination and shared rate-limit counters—remain separate follow-up work.
