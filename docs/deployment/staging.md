# Staging Deployment Guide (H-0B)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Staging Architecture                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────────┐         ┌──────────────────┐                │
│   │   Vercel     │  rewrites│    Railway      │                │
│   │   Frontend   │ ────────▶│   API Server    │                │
│   │              │ /api/*   │                  │                │
│   │  (React SPA) │          │  - Fastify      │                │
│   │              │          │  - Prisma       │                │
│   │              │          │  - Socket.IO    │                │
│   └──────────────┘          └────────┬─────────┘                │
│                                      │                          │
│                                      │                          │
│                                      ▼                          │
│                               ┌──────────────┐                 │
│                               │  PostgreSQL  │                 │
│                               │  (Railway)   │                 │
│                               └──────────────┘                 │
│                                                                 │
│   ┌──────────────────┐                                          │
│   │  Railway Worker  │                                          │
│   │                  │                                          │
│   │ - Withdrawal     │                                          │
│   │   timeout sweep  │                                          │
│   │ - Reconciliation │                                          │
│   │   detection      │                                          │
│   └──────────────────┘                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Railway account with project created
- Vercel account linked to GitHub repo
- PostgreSQL database provisioned on Railway
- GitHub repo with H-0A Node 20 fixes merged to master

## Known Blocker: Frontend Build Currently Fails

`pnpm --filter web build` fails today on pre-existing frontend TypeScript errors that
predate H-0B and are unrelated to this deployment-foundation work. This does **not**
block merging H-0B itself — H-0B only adds deployment templates and documentation,
it does not touch frontend source — but it **does** block an actual successful Vercel
deployment until those errors are fixed in a separate task. Confirm the current state
with `pnpm --filter web build` (or `pnpm --filter web typecheck`) before attempting a
real Vercel deploy, and do not treat a green H-0B merge as evidence the frontend builds.

## Railway Setup

### Builder Choice: RAILPACK

Both `railway.json` configs in this repo use `"builder": "RAILPACK"`. Verified against
Railway's current config-as-code reference (`https://railway.com/railway.schema.json`
and `docs.railway.com/reference/config-as-code`) before writing this doc: Railway's
current reference lists `RAILPACK` as the default builder for new services, with
`DOCKERFILE` as the other explicit builder option. Use `RAILPACK` for both the API and
worker services rather than the older `NIXPACKS` value.

### Config File Path Per Service

Each Railway service in this project should keep the **repository root** as both its
build root and source root — do not set a per-service root directory to `apps/api` or
similar, since the pnpm workspace (and the `build:packages` step H-0A depends on)
needs to resolve from the repo root.

Instead, point each service at its own **custom config-as-code file path** in the
Railway service settings (Settings → Config as Code):

- **API service**: `deploy/railway/api/railway.json`
- **Worker service**: `deploy/railway/worker/railway.json`

This config-file-path setting is a separate concept from the service's root/source
directory — do not confuse the two. The root directory stays the repo root for both
services; only the config file path differs between them.

### 1. Create Railway Project

```bash
railway login
railway init socialplay-staging
```

### 2. Provision PostgreSQL

```bash
railway add postgres --service database
```

Note the `DATABASE_URL` from the database service environment variables.

### 3. Deploy API Service

```bash
railway add --service api
railway variables set \
  DATABASE_URL="$DATABASE_URL" \
  JWT_ACCESS_SECRET="$(openssl rand -base64 32)" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 32)" \
  SECURITY_TOTP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  JWT_ISSUER=socialplay \
  JWT_AUDIENCE=socialplay \
  COOKIE_SECURE=true \
  COOKIE_SAME_SITE=lax \
  CORS_ORIGIN="https://<YOUR-VERCEL-DOMAIN>" \
  CORS_CREDENTIALS=true \
  API_PREFIX=/api/v1 \
  WS_PATH=/ws \
  NODE_ENV=production \
  LOG_LEVEL=info \
  LOG_PRETTY=false \
  STORAGE_PROVIDER=local \
  EMAIL_PROVIDER=console \
  FRONTEND_URL="https://<YOUR-VERCEL-DOMAIN>"
```

`SECURITY_TOTP_ENCRYPTION_KEY` uses `openssl rand -hex 32`, not `-base64 32`: the app
config schema requires this value to match `/^[0-9a-fA-F]{64}$/` — exactly 64
hexadecimal characters, i.e. 32 raw bytes hex-encoded. `openssl rand -hex 32` produces
exactly that. `openssl rand -base64 32` produces a ~44-character base64 string that
does **not** match the hex pattern and will fail Zod validation at startup. The two
JWT secrets have no such format constraint (just a 32-character minimum of any kind),
so base64 remains fine for those.

Then set the service's config file path to `deploy/railway/api/railway.json` (see
"Config File Path Per Service" above).

### 4. Deploy Worker Service

```bash
railway add --service worker
railway variables set \
  DATABASE_URL="$DATABASE_URL" \
  JWT_ACCESS_SECRET="$(openssl rand -base64 32)" \
  JWT_REFRESH_SECRET="$(openssl rand -base64 32)" \
  NODE_ENV=production \
  LOG_LEVEL=info \
  LOG_PRETTY=false \
  WORKER_SWEEP_INTERVAL_MS=300000 \
  WORKER_RECONCILIATION_INTERVAL_MS=3600000 \
  WORKER_RUN_RECONCILIATION=true
```

The worker never issues or verifies a JWT, but it imports the same shared
`@socialplay/config` package the API does, and that package's env schema requires
`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` unconditionally (no default) — the worker
process fails at startup without them. Use different values than the API's if you
prefer, or the same ones; nothing depends on them matching for the worker.

If your Railway project uses a shared/team variable group for staging parity with the
API service, you may also include `SECURITY_TOTP_ENCRYPTION_KEY=<64-hex>` here even
though the worker does not read it — this is optional and purely for consistency
across services sharing one variable set, not a functional requirement.

Then set the service's config file path to `deploy/railway/worker/railway.json`.

## Vercel Setup

### 1. Import Project

1. Go to vercel.com/new
2. Import GitHub repository `petestar26/trivia`
3. Configure:
   - Framework Preset: **Vite**
   - Root Directory: **repository root** (leave blank / do not set to `apps/web`)
   - Install Command: `pnpm install --frozen-lockfile`
   - Build Command: `pnpm --filter web build`
   - Output Directory: `apps/web/dist`

The project root must be the repository root, not `apps/web`, because the pnpm
workspace needs to resolve `@socialplay/shared` and install from the root lockfile.
`apps/web/dist` in Output Directory is relative to that repository-root project root —
if Root Directory were instead set to `apps/web`, Output Directory would need to be
just `dist`, not `apps/web/dist`. Do not mix the two: this doc and
`deploy/vercel/vercel.staging.example.json` both assume repository-root as the project
root, so keep the full `apps/web/dist` path consistently.

### 2. Configure Rewrites

After Railway API is deployed, copy its public domain (e.g.,
`socialplay-api.up.railway.app`).

Copy `deploy/vercel/vercel.staging.example.json` to a repository-root `vercel.json`
**only after** replacing every `REPLACE_WITH_RAILWAY_API_DOMAIN` placeholder in it with
the real Railway API domain:

```bash
sed 's/REPLACE_WITH_RAILWAY_API_DOMAIN/socialplay-api.up.railway.app/g' \
  deploy/vercel/vercel.staging.example.json > vercel.json
```

Do not commit an active root `vercel.json` with the placeholder still in it, and do
not create one before the Railway API domain is known.

### 3. Update Railway CORS

After Vercel deployment, update Railway API with the actual Vercel domain:

```bash
railway variables set CORS_ORIGIN="https://<YOUR-VERCEL-DOMAIN>.vercel.app"
railway variables set FRONTEND_URL="https://<YOUR-VERCEL-DOMAIN>.vercel.app"
```

## Environment Variables

### Railway API Service

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | From Railway PostgreSQL | Auto-generated |
| `JWT_ACCESS_SECRET` | Random 32-byte base64 | Generate fresh |
| `JWT_REFRESH_SECRET` | Random 32-byte base64 | Generate fresh |
| `SECURITY_TOTP_ENCRYPTION_KEY` | `openssl rand -hex 32` output | Must be exactly 64 hex chars — see note above |
| `JWT_ISSUER` | `socialplay` | Fixed |
| `JWT_AUDIENCE` | `socialplay` | Fixed |
| `COOKIE_SECURE` | `true` | HTTPS only |
| `COOKIE_SAME_SITE` | `lax` | Cross-origin support |
| `CORS_ORIGIN` | `https://<VERCEL-DOMAIN>` | Update after Vercel deploy |
| `CORS_CREDENTIALS` | `true` | Required |
| `API_PREFIX` | `/api/v1` | Fixed |
| `WS_PATH` | `/ws` | Fixed |
| `NODE_ENV` | `production` | Fixed |
| `LOG_LEVEL` | `info` | Fixed |
| `LOG_PRETTY` | `false` | JSON logs |
| `STORAGE_PROVIDER` | `local` | Ephemeral on Railway |
| `EMAIL_PROVIDER` | `console` | Logs only |
| `FRONTEND_URL` | `https://<VERCEL-DOMAIN>` | Update after Vercel deploy |

### Railway Worker Service

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | From Railway PostgreSQL | Auto-generated |
| `JWT_ACCESS_SECRET` | Random 32-byte base64 | Required at import time by shared config, even though the worker never signs/verifies a token |
| `JWT_REFRESH_SECRET` | Random 32-byte base64 | Same as above |
| `NODE_ENV` | `production` | Fixed |
| `LOG_LEVEL` | `info` | Fixed |
| `LOG_PRETTY` | `false` | JSON logs |
| `WORKER_SWEEP_INTERVAL_MS` | `300000` | 5 minutes |
| `WORKER_RECONCILIATION_INTERVAL_MS` | `3600000` | 60 minutes |
| `WORKER_RUN_RECONCILIATION` | `true` | Enable detection |
| `SECURITY_TOTP_ENCRYPTION_KEY` (optional) | `openssl rand -hex 32` output | Only for staging parity if using a shared variable set — not read by the worker |

## Smoke Test Checklist

### API Service

- [ ] Health endpoint responds: `curl https://<RAILWAY-API>/health`
- [ ] Database migrations applied (check Railway logs)
- [ ] Auth flow works: register → login → protected endpoint

The server registers `/health` as a bare top-level endpoint (not under `/api/v1`) — do
not also check `/api/v1/health`, that path does not exist.

### Worker Service

- [ ] Worker starts without errors (check Railway logs)
- [ ] Worker runs timeout sweep (check logs for `timeout sweep completed`)
- [ ] Worker runs reconciliation (check logs for `reconciliation completed`)
- [ ] Worker respects shutdown signals (deploy a new version, check graceful shutdown)

### Vercel Frontend

Blocked until the frontend build failure above is fixed — do not attempt these until
`pnpm --filter web build` succeeds:

- [ ] SPA loads correctly
- [ ] API calls work via rewrites (network tab shows 200 from `/api/v1/*`)
- [ ] WebSocket connection established (check browser console) — see the WebSocket
      caveat below; this is an explicit prerequisite, not an optional check
- [ ] Auth flow works in browser
- [ ] Logout clears session

### Integration

- [ ] Create withdrawal → agent sees assignment → timeout sweep escalates if deadline passes
- [ ] Real-time updates work (Socket.IO via `/ws`)

## Rollback

### Railway

```bash
# Rollback API to previous deployment
railway rollback --service api

# Rollback worker to previous deployment
railway rollback --service worker
```

### Vercel

1. Go to Vercel dashboard → Deployments
2. Find the last working deployment
3. Click **...** → **Promote to Production**

### Database Rollback

Database rollback is **not** `prisma migrate reset` — that command drops and
recreates the entire schema, destroying all data, and is not a rollback in any normal
sense. If you need to roll back after a bad migration:

1. **Restore a known-good database backup/snapshot** (Railway PostgreSQL supports
   backups — restore from one taken before the bad migration).
2. If no backup is available or the bad migration already shipped data changes you
   need to keep, **write a forward corrective migration** that undoes the problematic
   schema change — never edit or delete an already-applied migration file.
3. Whichever path you take, **ensure the app code you roll back to is
   schema-compatible** with whatever migration state the database ends up in — rolling
   back the API/worker deployment without also reconciling the schema is how you get a
   process that boots against a schema it doesn't understand.

#### Disposable staging database recreation only

`prisma migrate reset` is acceptable **only** when you intend to fully discard the
staging database and start over — e.g. early in setup before any real data exists, or
when deliberately re-seeding a throwaway environment. It destroys all data and
reapplies the entire current migration history from scratch. Never run it against a
database anyone is relying on, and never treat it as a way to undo one bad migration.

```bash
# DISPOSABLE STAGING DB ONLY — destroys all data, reapplies full migration history.
# Do not run this as a "rollback". See the rollback steps above instead.
railway run pnpm --filter database exec prisma migrate reset
```

## Known Caveats

### 1. WebSocket Delivery Through the Vercel Rewrite Is Unverified

The frontend's Socket.IO client is configured with `transports: ["websocket", "polling"]`,
but there is no explicit fallback handler in the client and no alternate direct-to-Railway
socket URL configured. Whether Vercel's rewrite proxy correctly passes through the
WebSocket upgrade for `/ws` to the Railway API is **not yet verified** — do not assume
polling fallback is automatically expected or sufficient; if the upgrade doesn't work
and no fallback path is configured, realtime features may simply be unavailable rather
than degrading gracefully.

If WebSocket smoke testing (see the Vercel Frontend checklist above) shows the upgrade
does not work through the rewrite, the options are:

- Change the client's transport/proxy configuration to explicitly handle the polling
  case (the current config does not do this on its own).
- Connect the frontend directly to the Railway API's own domain for the socket
  connection, bypassing the Vercel rewrite entirely (reintroduces a cross-origin
  concern for that one connection).
- Put a WebSocket-compatible proxy (e.g., Cloudflare, Nginx) in front of the API
  instead of relying on Vercel's rewrite for this path.

Treat WebSocket smoke testing as a required staging prerequisite, not an optional nice-to-have,
and treat "WebSocket doesn't work through Vercel" as an accepted possible outcome to plan
around, not a documented guarantee that polling silently covers it.

### 2. Local Storage Ephemeral

`STORAGE_PROVIDER=local` stores files on the Railway container. Files are lost on:
- Container restart
- New deployment
- Scaling events

For persistent storage in staging/production, configure S3-compatible storage (e.g., AWS S3, Cloudflare R2, MinIO).

### 3. Build From Workspace Root

Railway must build from the repository root to resolve pnpm workspace dependencies.
Both `railway.json` configs specify:

```
pnpm install --frozen-lockfile && pnpm --filter api build
```

This looks like it skips building `packages/config`, `packages/shared`,
`packages/database`, and `packages/storage` first — it does not. `apps/api`'s own
`build` script (`pnpm -w run build:packages && node build.js`) already runs the
workspace packages' build step itself before bundling (an H-0A fix), so the Railway
buildCommand doesn't need to chain `build:packages` explicitly anymore. Do not remove
`--filter api build`'s dependency on the workspace packages by editing
`apps/api/package.json`'s own build script without re-verifying this chain still holds.

### 4. Prisma Migrations

Migrations run via the API service's `preDeployCommand`:

```
pnpm --filter database exec prisma migrate deploy
```

This intentionally does **not** repeat `pnpm install`/`build` — Railway's
`preDeployCommand` runs after the build step, in the same built environment, so
`prisma` (a `packages/database` devDependency) is already installed and the migration
CLI needs nothing further. The worker does NOT run migrations — it expects the schema
to already be up-to-date by the time it starts.

If migration fails:
1. Check Railway API logs for migration errors
2. Manually run `railway run pnpm --filter database exec prisma migrate deploy`
3. Fix migration file if needed, commit, and redeploy

### 5. CORS Updates

When Vercel domain changes (e.g., new preview deployment), update Railway:

```bash
railway variables set CORS_ORIGIN="https://<NEW-DOMAIN>" FRONTEND_URL="https://<NEW-DOMAIN>"
```

### 6. Worker Concurrency

Multiple worker instances may run simultaneously (Railway scaling). This is safe due to:
- `pg_try_advisory_xact_lock` (one sweep at a time)
- `FOR UPDATE SKIP LOCKED` (batch-safe)
- Deterministic `WithdrawalOperation` idempotency keys (re-runs are no-ops)

### 7. No `watchPatterns` — Every Deploy Trigger Is Intentional

Earlier drafts of both `railway.json` configs scoped `watchPatterns` to
`["apps/api/src/**"]`, meaning Railway would only redeploy on changes under that one
path. That was removed: a change to a dependency, a workspace package
(`packages/config`, `packages/shared`, `packages/database`, `packages/storage`), a
migration, `railway.json` itself, or this documentation would all silently fail to
trigger a redeploy under that narrow pattern, even though every one of them can change
runtime behavior. With no `watchPatterns` set, Railway deploys on any change in the
watched branch, which is the safer default for a staging environment still being
validated. Revisit narrowing this only once the deploy is stable and the team wants to
reduce deploy frequency deliberately.

## Troubleshooting

### API Won't Start

- Check `DATABASE_URL` is set correctly
- Check Railway logs for Prisma connection errors
- Verify migrations: `railway run pnpm --filter database exec prisma migrate status`

### Worker Won't Start

- Check `DATABASE_URL` is set correctly
- Check `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` are set — the shared config package
  requires them even though the worker doesn't use them for auth
- Verify worker config: `railway run pnpm --filter api start:worker:once`

### Vercel Build Fails

- See "Known Blocker: Frontend Build Currently Fails" above — this is likely the
  pre-existing frontend TypeScript issue, not a deployment misconfiguration
- Check build logs for pnpm errors
- Ensure `pnpm install --frozen-lockfile` succeeds
- Verify Node version is 20+ in Vercel settings

### WebSocket Not Connecting

- Check browser console for connection errors
- Verify `/ws` rewrite is configured in `vercel.json`
- Check Railway logs for Socket.IO connection attempts
- See "WebSocket Delivery Through the Vercel Rewrite Is Unverified" above — this may be
  an accepted current limitation, not a fixable misconfiguration, until one of the
  documented options is implemented

## Next Steps (Post-Staging)

1. **Production Database**: Migrate to managed PostgreSQL (AWS RDS, Google Cloud SQL)
2. **Persistent Storage**: Configure S3-compatible storage for user uploads
3. **Redis**: Add Redis for Socket.IO scaling (currently single-instance)
4. **Monitoring**: Add APM (Datadog, New Relic) and error tracking (Sentry)
5. **CI/CD**: Automate staging deployments on merge to `main`
6. **Preview Deployments**: Enable Vercel preview deployments for PRs
