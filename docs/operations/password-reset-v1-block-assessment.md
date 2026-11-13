# Read-only v1 reset-block assessment

Scope: local release source `a54696e` and reset-v2 candidate only. No production
configuration, current topology or denied PR77 source was read. No block has
been installed. This assessment cannot certify that a global control exists.

## What the available source establishes

- `apps/api/src/routes/auth.ts` registers POST `/password-reset` unconditionally.
  With the default `API_PREFIX`, the resulting route is
  `/api/v1/auth/password-reset`; a production prefix override is unverified.
- That route does not require an authenticated user. Its five-per-15-minute
  anonymous rate limit is throttling, not a shutdown control.
- `apps/web/server.mjs` proxies `/api/*` to its configured API origin. It has no
  reset-specific deny switch in this source snapshot.
- Cookie-origin protection applies to browser requests, not every direct API
  request. CORS/origin settings cannot be treated as a global reset block.
- Gateway attestations feed rate-limit identity, not exclusive permission to
  reach the reset endpoint. Blocking only the web proxy is not proven to block
  a directly reachable API origin.
- The owner CLI is explicit, not run by API startup. Stopping public requests
  does not itself stop an owner CLI process or any operator invocation.
- v1 derives reset signatures from the access JWT key. `PASSWORD_RESET_SECRET`
  and its absence are meaningful only to v2; removing it cannot disable v1.

## Options, in preference order

| Option | Could it cover v1? | Preconditions and costs |
| --- | --- | --- |
| Existing universal ingress/proxy deny rule | Yes, if it covers **all** paths to every API replica | First verify every custom/provider domain, direct origin, internal caller and prefix. Need approved temporary denial of reset requests, normalized-path matching and proof that no unfiltered origin exists. No such universal control has been verified. |
| Short full-API maintenance stop | Yes, if every API instance and in-flight process is stopped | Broad outage: login, wallets and other API features unavailable. Requires an explicit maintenance plan, exact-instance inventory and approval. Do not stop databases or unrelated workers by assumption. |
| Temporary API-level reset-disable patch | Yes after every serving instance runs it | Requires a reviewed release/deployment and drain plan. It is **not** an immediate global control during a mixed old/new rollout. A custom flag cannot affect existing v1 binaries. No patch was made for this assessment. |
| Web-gateway-only rule | Not established | Safe only after proving all API access goes through that gateway and there are no direct/internal routes. Current source does not prove this. |

**Not recommended as substitutes:** hide the web reset page, change CORS,
reduce rate limits, remove the v2 key, rotate the shared JWT key, or revoke broad
user-table privileges. The first four do not establish a v1 block. JWT rotation
has session/signing consequences and still permits new v1 signatures with the
new key. Broad database changes can disrupt unrelated auth/writes and may not
restrict an owner/superuser login.

## Minimum evidence before selecting a control

1. Exact current API/CLI versions and all serving instances, entry points and
   path prefixes, obtained through an authorized read-only inventory.
2. A supported control covering those entry points, and an approved operator
   change showing exact scope, expected error response, start/end and recovery.
3. Synthetic rehearsal demonstrating reset requests are denied from every
   relevant route while unrelated login remains available (unless a full outage
   was explicitly chosen). Include query strings, normalized/encoded paths,
   trailing slashes and direct-origin requests, without using valid customer
   tokens or sending mutation-capable probes to production.
4. New issuance stopped and all in-flight v1 reset/owner-CLI requests drained.
   An ingress deny alone does not cancel already-running requests.
5. Keep the public block in force throughout migration and mixed versions.
   Smoke-test only via a separately approved isolated path. Unblock only after
   every instance is the reviewed v2 candidate and all release gates pass.

Until these facts are available, the safest disposition is **no rollout**,
not a guessed network or credential change.

## Disposable migration recovery check

Run `node apps/api/scripts/check-reset-migration.mjs` from the repository root.
This uses in-memory PGlite only: no DATABASE_URL, network connection, external
storage, role creation or credentials. It injects a failure immediately before
COMMIT into the actual migration text, confirms rollback leaves no private
schema, then retries the unmodified migration. It verifies inherited PUBLIC
default grants are absent on the schema, ledger and consume function.

This complements, rather than replaces, the earlier native PostgreSQL
13/16/18 tests of hostile named default grants and real restricted-login
redemption. It does not establish production migration history or permissions.
