# Access-token revocation on logout

Status: implemented on the PR #77 branch; it changes member logout behaviour
for everyone once merged. It needs no configuration, migration or grant beyond
what the API's runtime login already has (`UPDATE` on `users.tokenVersion`; a
narrower auth login needs that column too).

## What logout does

`POST /auth/logout` stays all-device. When it can identify the account (stored
refresh-session cookie, or a currently valid access token), it runs one
transaction that:

1. advances `users.tokenVersion` (raw SQL, so `users.updatedAt` and staff
   optimistic concurrency are untouched), and
2. deletes every refresh session for the account.

Both commit or neither does. If either fails the response is 500 and cookies
are not cleared, so the browser does not believe it signed out. After commit
the handling instance disconnects the account's local sockets.

`POST /auth/refresh` now locks the account row (`FOR SHARE`) inside its
rotation transaction and re-checks status and `tokenVersion`. A logout that
arrives while a rotation is in flight therefore waits for it and then deletes
the session it created; a rotation that starts after logout fails.

## Every consumer that accepts an access token

| Consumer | Enforces current `tokenVersion` and status? |
| --- | --- |
| HTTP `authenticate` (`middleware/auth.ts`), used by every protected route | Yes, database read per request |
| HTTP `optionalAuth` | Yes; a revoked token is treated as anonymous |
| WebSocket handshake (`ws/index.ts`) | Yes |
| Every inbound WebSocket packet (`socket.use`) | Yes; mismatch disconnects |
| Private deliveries (`realtime/broadcast.ts` `deliver`) | Yes, per recipient socket, immediately before emit; mismatch disconnects |
| Play Together dispatcher (`games/play-together/events.ts`) | Yes, per socket |
| `/auth/refresh` (refresh tokens) | Yes, and the session is deleted |
| Rate-limit key (`plugins/rate-limit-identity.ts`) | **No, by design: it only picks a bucket and grants nothing.** A revoked but unexpired token still counts against that user's own bucket until it expires (at most 15 minutes) |
| Web gateway (`apps/web/server.mjs`) | Holds no tokens; forwards requests only |
| Workers | Do not accept access tokens |

Because the check reads the shared database, revocation takes effect on every
API instance. The only per-instance step is the prompt local socket disconnect;
sockets on other instances are refused at their next inbound packet or private
delivery, whichever comes first, and never receive another private event.
There is no cross-instance socket adapter.

## Verified on real PostgreSQL (disposable, synthetic)

`apps/api/src/database/logout-revocation.native.ts` runs two genuinely separate
instances (the test process and a child process built with the production
esbuild settings) through a column-restricted login:

- logout on one instance makes both devices' access tokens fail on both
  instances, refresh fails, the handling instance's socket disconnects, the
  other instance's sockets are refused at the next delivery (the private event
  is not received) and at the next packet, and new handshakes are refused;
- repeated logout (Bearer, other instance, cookies) is 200 every time and
  advances the version exactly once;
- an expired access cookie plus the refresh cookie revokes everything; an
  expired access cookie alone identifies no account and changes nothing;
- revoking the login's `UPDATE(tokenVersion)` or `DELETE` on sessions makes
  logout fail with 500, no cookie changes, version and sessions unchanged;
- a refresh blocked mid-rotation when logout arrives: logout waits, then the
  session that refresh created is deleted and its tokens are rejected;
- 15 concurrent refresh/logout races across both instances: version advanced
  once, no surviving session, no usable token.

Mutation checks: without the version bump 6 of 7 tests fail; without the
locked re-check in refresh the mid-rotation and concurrent tests fail (a
session survives); without the transaction the rollback test fails.

## Limits

- A client that presents only an expired access cookie and no refresh cookie
  cannot be identified, so nothing is revoked (the response still clears its
  cookies). This is unchanged behaviour.
- An active suspended account presenting only a Bearer token gets 403 from
  logout (unchanged); with its refresh cookie it is logged out normally.
- Logout also invalidates any owner-issued password-reset link issued earlier
  for that account, because the link is bound to `tokenVersion`.
- Rate-limit bucketing, above.
