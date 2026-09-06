# Railway frontend API connection

The frontend is a static SPA. Its Caddy server does not proxy `/api/v1` or `/ws`.
Set the public API origin at **build time**, then rebuild the frontend. Existing
builds cannot pick up a new Vite variable at runtime.

## Frontend service

- Source/root directory: repository root (`/`).
- Install: `pnpm install --frozen-lockfile`.
- Build: `pnpm --filter ./apps/web build`.
- Builder: Railpack; retain its generated Caddy start command (do not start the API).
- Variables:

```env
VITE_API_URL=https://api-production-5eb53.up.railway.app
RAILPACK_SPA_OUTPUT_DIR=apps/web/dist
RAILPACK_NODE_VERSION=20
```

Keep `RAILPACK_NO_SPA` unset. The public domain must target Caddy's listening port:
the generated Caddyfile uses `$PORT`, with port 80 as its fallback. Inspect the
deployed Caddy configuration/logs and match the domain's target port to it; do not
use the Vite development port. The existing production frontend already serves
HTML successfully, so a port change is not required solely to fix API routing.

`VITE_API_URL` contains no credentials. Use an origin; an existing `/api/v1` suffix
and trailing slashes are normalized. HTTP requests, multipart uploads, authenticated
voice playback, and Socket.IO all use this origin. Socket.IO still uses `/ws`.
Static SPA assets stay on the frontend. No other backend media URL consumers exist
in the current frontend; storage-provider URLs are not rendered there.

For local development, omit the variable (or leave it empty) to retain Vite's
same-origin `/api` and `/ws` proxy. Vite loads local env files from `apps/web`;
use `apps/web/.env.local` for local overrides, or export the variable in the shell.
Do not put secrets in any `VITE_*` variable.

## API service

Keep the repository build root and the API-specific Railway config file. Preserve
existing database and authentication secrets. The relevant environment settings are:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://trivia-production-f8da.up.railway.app
CORS_CREDENTIALS=true
FRONTEND_URL=https://trivia-production-f8da.up.railway.app
API_PREFIX=/api/v1
WS_PATH=/ws
NODE_ENV=production
COOKIE_SECURE=true
COOKIE_SAME_SITE=none
```

Use the actual Postgres service name in the Railway reference. Leave `COOKIE_DOMAIN`
unset to keep cookies host-only on the API. Both token cookies remain HttpOnly;
do not broaden CORS to `*`, disable Secure, or move tokens into browser storage.

These Railway service domains are cross-site because `up.railway.app` is on the
Public Suffix List. `SameSite=Lax` cannot support authenticated cross-site fetches;
`SameSite=None` requires Secure. The API already supports these settings for both
setting and clearing cookies, so no global cookie-default change is needed.
Browser third-party-cookie restrictions can still block this architecture. If that
happens, use frontend/API custom subdomains under one owned site, or a same-origin
proxy, rather than disabling browser security. Reassess CSRF protections when
allowing cross-site cookies; CORS alone is not a CSRF defense.

## Deployment and verification

1. Confirm the service source branch contains the frontend fix.
2. Apply any required API cookie settings and redeploy the API.
3. Set the frontend build variables and rebuild/redeploy the frontend.
4. Verify `/health` on the API returns `200` and `{"status":"ok"}`.
5. In browser Network, registration must POST to
   `https://api-production-5eb53.up.railway.app/api/v1/auth/register`, never the
   frontend domain. Confirm the CORS preflight succeeds and registration succeeds.
6. Check cookies in browser storage without copying their values: Secure, HttpOnly,
   SameSite=None, API host only. Verify login, `GET /api/v1/auth/me`, and page reload.
7. Verify logout clears both cookies and a subsequent `/auth/me` returns 401.
8. Verify `/ws` connects to the API and authenticated voice playback works.

A curl cookie jar does not enforce browser SameSite or third-party-cookie rules;
successful CLI authentication alone is not proof that browser authentication works.

References: [Vite environment variables](https://vite.dev/guide/env-and-mode),
[Railpack static sites](https://railpack.com/languages/node/#static-sites),
[cookie attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie),
[Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat).
