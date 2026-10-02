# Railway frontend and first-party API gateway

The frontend can serve its built SPA and forward `/api/v1`, `/health` and `/ws`
through `apps/web/server.mjs`. Authentication cookies then belong to the frontend
host and no longer depend on third-party-cookie access between Railway domains.
The upstream API remains a separate service with its existing authentication,
database identity and game activation settings.

## Recommended frontend configuration

- Source/root directory: repository root (`/`).
- Railway config file: `deploy/railway/web/railway.json`.
- Build: `pnpm install --frozen-lockfile && pnpm --filter web build`.
- Start: `node apps/web/server.mjs`.
- Healthcheck: `/health` (forwards the API health response).
- Public-domain target port: the gateway's `$PORT`, default `1443`.

```env
VITE_API_PROXY=true
WEB_API_ORIGIN=https://api-production-5eb53.up.railway.app
RAILPACK_NO_SPA=1
RAILPACK_NODE_VERSION=20
```

`VITE_API_PROXY` is a build-time setting, so rebuild after changing it. When true,
HTTP requests, multipart uploads, authenticated voice playback and Socket.IO use
the frontend origin. The server pins one HTTPS upstream origin, preserves
HttpOnly cookies and idempotency headers, disables API response caching, and
rejects browser writes and WebSocket upgrades from other origins.

`WEB_API_ORIGIN` is a runtime setting. It must contain only an origin, without
credentials, paths, queries or fragments. Do not put secrets in `VITE_*` variables.
Do not retain the generated Caddy start command when using the gateway. Existing
`RAILPACK_SPA_OUTPUT_DIR=apps/web/dist` can remain, but SPA mode must be disabled.
Do not accept unrelated staged Railway changes as part of this update.

For local development, leave `VITE_API_PROXY` and `VITE_API_URL` unset to retain
Vite's `/api` and `/ws` development proxy. Local env files belong in `apps/web`.

## API service

Preserve the API-specific Railway config, build and predeploy commands, restricted
database role, authentication secrets, and financial activation gates. The
gateway does not activate Coin wagering or the scheduled practice worker.

Keep both auth cookies HttpOnly and Secure. Leave `COOKIE_DOMAIN` unset so cookies
received through the gateway are host-only on the frontend. Setting and clearing
cookies must use matching attributes. Keep the configured API prefix `/api/v1`
and Socket.IO path `/ws`. Never broaden CORS to `*` or store tokens in browser
storage. The API's configured CORS origin can remain the production frontend.

## Verification and rollback

1. Run `pnpm --filter web test:gateway`, focused Spin/browser request tests, and
   `pnpm --filter web build` on the exact candidate commit.
2. Deploy the frontend gateway with the variables above. Verify frontend
   `/health`, a deep SPA route, and a missing asset (404).
3. In a real browser, sign in through the frontend; verify `/api/v1/auth/me`,
   `/api/v1/games`, `/api/v1/wallet` and page reload remain authenticated. Inspect
   cookie attributes without copying token values.
4. Verify `/ws` connects through the frontend, then verify logout clears the
   cookies and subsequent `/auth/me` returns 401. Cross-origin writes must return
   403 without reaching the API.
5. Check solo practice selections, undo, rebet, result animation and the displayed
   balance. Shared practice must show the server state and remain paused if its
   worker/stream are disabled; it must never manufacture a countdown or result.

A CLI cookie jar does not enforce browser cookie policy; successful CLI requests
are not proof of browser sign-in persistence.

To roll back, restore the previous frontend deployment and its static Caddy start
configuration, unset `VITE_API_PROXY` and `RAILPACK_NO_SPA`, and restore
`VITE_API_URL=https://api-production-5eb53.up.railway.app` with
`RAILPACK_SPA_OUTPUT_DIR=apps/web/dist`. Rebuild. This restores the cross-site API
transport and may restore the original browser cookie issue. The API and database
need no rollback for this frontend-only change.

The legacy direct-origin route remains available when `VITE_API_PROXY` is not
`true`: `VITE_API_URL` accepts an HTTPS origin or a normalized `/api/v1` suffix.
Railway service domains are cross-site because `up.railway.app` is on the Public
Suffix List. Direct-origin transport needs suitable Secure/SameSite=None cookie
settings, and browser third-party-cookie restrictions can still block it. Owned
custom subdomains under one site are another deployment option.

References: [Vite env variables](https://vite.dev/guide/env-and-mode),
[Railpack Node/static sites](https://railpack.com/languages/node/),
[cookie attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie),
[Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat).
