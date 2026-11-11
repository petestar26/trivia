# Guest session and launch hardening

## Scope and provenance

This candidate is based exactly on the reconstructed Claude integration `b21c857201381c718fd6990aeb206b9a09acdfd1` (tree `5c23e46b3c2ce35c67c8ca8a906f1be9f2373a40`). It includes the same guest/member shell and prior R2 work. The reconstructed input and earlier review branches were not changed. This is a local review candidate, not a deployment.

No push, merge, deployment, real sign-in, provider launch, bet, payment or funds movement was performed. Browser and unit fixtures use synthetic identities/data only. No backend route, server permission, database schema, catalogue exposure or financial logic changed.

## Reproduced findings and corrections

1. **Stale casino arrival permission:** opening game A with an intent left a boolean permission usable by a later same-mounted URL selection of game B. Provider and sports launch state is now scoped to the exact router navigation, user and session revision. Pending responses, Play actions and redirects cannot cross that boundary or a page hide. A selected game without a valid permission remains an introduction with a fresh Play button.
2. **Concurrent consumption:** localStorage get/remove was not atomic across tabs. Consumption now uses an exclusive Web Lock for the nonce, then removes and validates its record. Only one consumer can win. Permission is bound to the user, target, session revision and original issue-time expiry. Lock denial, timeout, unsupported locking, malformed data, changed identity and restored navigation all fail closed. A denied consumer requires a fresh in-page click.
3. **Expiry privacy:** a definitive refresh denial previously left the member identity and cached private UI alive. A revision-guarded invalidation now clears identity, query cache and page state, and disconnects sockets. Another tab's session boundary also clears private state before reload. A successful probe proving a different identity fails closed without adopting that user. Stale read, mutation and upload results cannot publish across the boundary; writes are never replayed.
4. **Transient failures:** network errors, aborts, 5xx and malformed probe data are not treated as proven logout. They cannot authorize new actions, but do not erase an otherwise current member identity. Older denials cannot clear a newer successful login.
5. **Freshness and href reset:** a consumed permission cannot extend its original 60-second deadline while the casino catalogue loads. The sportsbook link always resets its URL when creating a new intent fails, rather than retaining a previous nonce.

## Deliberate conservative behavior

- Spent nonces and read-only game selections may remain in the address. They are not credentials and cannot authorize another launch after consumption.
- A document originally loaded by reload or browser history restoration requires an extra in-page Play/Browse click, including later SPA navigation in that document. This is a conservative fallback, not a permission bypass.
- When Web Locks or storage are unavailable, a direct in-page click still works. Automatic arrival launch does not. Storage denial can prevent cleanup, but that consumer remains denied and stored records expire.
- Pending operations are not represented as successful, and a denied or interrupted action is never automatically resubmitted.

## Evidence and remaining verification

Current command results are in `evidence/guest-shell/hardening-verification.txt`. The independent follow-up review found no remaining blocking issue in the inspected changes and independently reran 127 targeted tests successfully.

The earlier browser JSON and integration review are historical evidence, not proof of these corrections. Their expiry scenario checked only absence of writes and balance on a different page, while its guest-header result was false. The updated harness asserts guest identity and private Wallet unmount on the same page after authoritative denial, no private requests while browsing afterward, concurrent consumption, a second game selection after a spent intent, and manual fallback without Web Locks.

**The updated browser harness has not passed here.** Chromium still fails to create its required process socket (`Operation not permitted`). No new screenshots or visual pass are claimed. The harness is ready for an authorized machine where browser execution is available. Its API/provider responses are synthetic and external connections are blocked.

The anonymous API sweep is blocked in this checkout because the reused dependency installation lacks the generated Prisma client. It failed before tests or database connections ran. No database-backed suite was run. The frontend test suite exercises real ApiClient/AuthProvider/SocketProvider boundaries with synthetic transport responses.
