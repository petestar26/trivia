# Follow-up to the external baseline review

Historical evidence for `63e07bd`. See `review-revision-2-20261004.md` for the subsequent exact-head review, corrections and current verification boundary.

The attached reviewer could access `6bbba5f`, not local `7f6997d`. Its missing-feature matrix therefore does not describe the local social-group/reward implementation. This follow-up addresses findings still present on that local head. It is not a deployment or financial-activation approval.

| Finding | Current disposition |
| --- | --- |
| H1: one rate-limit bucket behind the gateway | Authenticated keys now use a verified JWT subject, including cookie sessions. Anonymous gateway addresses require a dedicated signed, short-lived attestation. Two real HTTP clients behind one gateway each receive their own 90/min allowance. Deployed ingress and secret configuration still need verification. |
| M1: practice depends on the PVP flag | PVP, Keno and Dice loops use independent switches. All eight switch combinations have a regression test. |
| M2: moderation strands a paid player | `7f6997d` blocks membership removal/ban/mute for paid active entries at the database. A suspended account can now refund its own OPEN entry without acquiring any right to play. Unstarted entries can also be withdrawn after the lobby deadline. New native regression is pending execution. |
| L1: ignored route limits | Text/voice limits were corrected in `7f6997d`; the remaining game-play limit is now under `config`. Removed the unsupported global `errorMessage` option. |
| L2: confusing group deletion error | Owner deletion explicitly returns 409 for PVP or collectible-gift history, explaining that records are retained and personal archive is available. New HTTP assertion is pending execution. |
| L3: gross returns look like profit | Winner rows show points returned plus net result after the original entry. A tied 100-point entry returning 93 displays -7 net. |
| L4: discarded worker errors | Workers report sanitized diagnostic codes, database SQLSTATE where available, and safe reason text with the affected ID. Raw SQL/errors, connection strings and stacks are excluded. |
| L5: unchecked Keno payout | A forward migration validates picks/draws, prevents early draws/late admission, and enforces payout = hits × stake-per-number / 5 × 18. Native and migration verification remain pending. |
| L6: winning-looking Dice placeholders | Awaiting dice now have no pips; the accessibility label remains accurate. |
| Ticket scanning | Added user and pending-retry indexes for Keno and Dice in the forward migration. |
| PVP snapshot locking | Snapshots now take compatible SHARE locks; mutations retain their existing write lock and lock order. The new two-connection regression is pending. |
| CI path gaps | Added auth, plugins, WebSockets, rewards, realtime, worker helper, config and affected route-test coverage to the PostgreSQL workflow trigger. |

Dice PVP now also discloses the different chances of each exact total and that a winner's returned points can be below the entry after the fee.

## Gateway deployment contract

- Configure the same newly generated `WEB_GATEWAY_SECRET` (at least 32 unpredictable characters) on API and web. This is a dedicated identity key, never the JWT signing key. Do not put it in source, VITE variables, logs or this report. Production web startup refuses to run without the key.
- `WEB_CLIENT_IP_SOURCE=socket` is the safe default for a directly exposed gateway. It ignores client-supplied forwarding headers.
- `WEB_CLIENT_IP_SOURCE=railway` is an explicit trust choice only for a web service publicly reachable solely through Railway HTTP ingress. Railway documents `X-Real-IP` as the client's remote address: https://docs.railway.com/networking/public-networking/specs-and-limits . This documentation is not a formal anti-spoofing guarantee. Before enabling this mode, verify on isolated staging that forged inbound `X-Real-IP` is replaced and that there is no public direct/TCP bypass to the web port. If that cannot be established, do not enable this mode; obtain a trusted ingress contract first.
- The gateway strips incoming attestation/forwarding headers and signs the selected address, method, raw path and timestamp. The API accepts only a matching signature within 30 seconds; it never blindly enables `trustProxy`. Direct API requests and invalid proofs use the socket IP fallback. Anonymous clients of the direct public API may still share its ingress-address allowance; browser sign-in is intended to use the configured first-party gateway.
- Login/register/refresh-specific limits remain anonymous-client based even when another valid access cookie is present. Authenticated general/game routes use verified user identity. Current counters remain per API process, as before; multiple replicas would require a shared counter store.

## Verification and remaining scope

The current sandbox cannot access the prior disposable PostgreSQL cluster. A requested permission escalation was rejected by the active approval policy, which disables sandbox approvals. No database test is reported as passing on this new patch. Added native coverage and the fresh/populated migration suite must run in an authorized disposable PostgreSQL environment or CI on the exact new commit before deployment.

The old local database, ledger and financial results remain evidence for `7f6997d`, not a substitute for validating this patch. Current checks pass: 14 HTTP identity/worker tests, 14 PVP/Dice interface tests, 11 cookie-session tests, 7 gateway tests and 3 PWA tests (49 total, no skips). Workspace packages, the web typecheck/production build and the complete API bundle build pass. Whole-API TypeScript checking remains blocked by existing repository errors.

Practice credit replenishment is still a product gap: Keno and Dice have a finite 1,000-credit initial practice grant and no refill flow. This patch does not invent a refill policy or weaken the balance-conservation invariant. Track an explicit, auditable nonredeemable refill/reset policy separately before treating practice as an unlimited experience.

An idle JOINED participant can stall a lobby until the owner cancels or the 15-minute lobby expires; it is not indefinite. Removing an unpaid player from the round without removing them from the group is a possible later refinement. The paid-member protection must remain intact.

Public source permission is still absent. No push or deployment was attempted. A private self-contained Git bundle is provided to let the next reviewer inspect both the original local changes and this follow-up without needing a GitHub publication. After code review and database/CI verification, isolated staging still requires migrations, runtime grants, the gateway configuration above, and real two-account/voice/reconnection acceptance. All financial gates remain off.
