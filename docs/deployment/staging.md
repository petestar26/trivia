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

## Railway Setup

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
  SECURITY_TOTP_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
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

### 4. Deploy Worker Service

```bash
railway add --service worker
railway variables set \
  DATABASE_URL="$DATABASE_URL" \
  WORKER_SWEEP_INTERVAL_MS=300000 \
  WORKER_RECONCILIATION_INTERVAL_MS=3600000 \
  WORKER_RUN_RECONCILIATION=true \
  NODE_ENV=production \
  LOG_LEVEL=info \
  LOG_PRETTY=false
```

## Vercel Setup

### 1. Import Project

1. Go to vercel.com/new
2. Import GitHub repository `petestar26/trivia`
3. Configure:
   - Framework Preset: **Vite**
   - Root Directory: **apps/web**
   - Build Command: `pnpm install --frozen-lockfile && pnpm --filter web build`
   - Output Directory: `dist`
   - Install Command: `pnpm install --frozen-lockfile`

### 2. Configure Rewrites

After Railway API is deployed, copy its public domain (e.g., `socialplay-api.up.railway.app`).

Create `vercel.json` in the repository root:

```json
{
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "https://socialplay-api.up.railway.app/api/$1"
    },
    {
      "source": "/ws/(.*)",
      "destination": "https://socialplay-api.up.railway.app/ws/$1"
    },
    {
      "source": "/ws",
      "destination": "https://socialplay-api.up.railway.app/ws"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

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
| `SECURITY_TOTP_ENCRYPTION_KEY` | Random 32-byte base64 | Generate fresh |
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
| `WORKER_SWEEP_INTERVAL_MS` | `300000` | 5 minutes |
| `WORKER_RECONCILIATION_INTERVAL_MS` | `3600000` | 60 minutes |
| `WORKER_RUN_RECONCILIATION` | `true` | Enable detection |
| `NODE_ENV` | `production` | Fixed |
| `LOG_LEVEL` | `info` | Fixed |
| `LOG_PRETTY` | `false` | JSON logs |

## Smoke Test Checklist

### API Service

- [ ] Health endpoint responds: `curl https://<RAILWAY-API>/health`
- [ ] API prefix works: `curl https://<RAILWAY-API>/api/v1/health`
- [ ] Database migrations applied (check Railway logs)
- [ ] Auth flow works: register → login → protected endpoint

### Worker Service

- [ ] Worker starts without errors (check Railway logs)
- [ ] Worker runs timeout sweep (check logs for `withdrawal timeout sweep completed`)
- [ ] Worker runs reconciliation (check logs for `reconciliation completed`)
- [ ] Worker respects shutdown signals (deploy a new version, check graceful shutdown)

### Vercel Frontend

- [ ] SPA loads correctly
- [ ] API calls work via rewrites (network tab shows 200 from `/api/v1/*`)
- [ ] WebSocket connection established (check browser console)
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

If migration rollback is needed:

```bash
railway run pnpm --filter database exec prisma migrate reset
```

**Warning**: This destroys all data. Only use in staging.

## Known Caveats

### 1. WebSocket Rewrite via Vercel

Vercel's rewrite proxy may not fully support WebSocket upgrades. If Socket.IO falls back to HTTP long-polling, this is expected behavior for staging. For production WebSocket support, consider:

- Direct WebSocket connection to Railway API (bypass Vercel)
- Using a WebSocket-compatible proxy (e.g., Cloudflare, Nginx)

**Smoke test required**: Verify Socket.IO connection type in browser console.

### 2. Local Storage Ephemeral

`STORAGE_PROVIDER=local` stores files on the Railway container. Files are lost on:
- Container restart
- New deployment
- Scaling events

For persistent storage in staging/production, configure S3-compatible storage (e.g., AWS S3, Cloudflare R2, MinIO).

### 3. Build from Workspace Root

Railway must build from the repository root to resolve pnpm workspace dependencies. The `railway.json` configs specify:

```
pnpm install --frozen-lockfile && pnpm run build:packages && pnpm --filter api build
```

Do not change this to build only `apps/api/dist` — workspace packages must be compiled first (H-0A fix).

### 4. Prisma Migrations

Migrations run automatically via `preDeployCommand` in the API service. The worker does NOT run migrations — it expects the schema to be up-to-date.

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

## Troubleshooting

### API Won't Start

- Check `DATABASE_URL` is set correctly
- Check Railway logs for Prisma connection errors
- Verify migrations: `railway run pnpm --filter database exec prisma migrate status`

### Worker Won't Start

- Check `DATABASE_URL` is set correctly
- Verify worker config: `railway run pnpm --filter api start:worker:once`

### Vercel Build Fails

- Check build logs for pnpm errors
- Ensure `pnpm install --frozen-lockfile` succeeds
- Verify Node version is 20+ in Vercel settings

### WebSocket Not Connecting

- Check browser console for connection errors
- Verify `/ws` rewrite is configured in `vercel.json`
- Check Railway logs for Socket.IO connection attempts
- Try polling transport: `transports: ["polling", "websocket"]`

## Next Steps (Post-Staging)

1. **Production Database**: Migrate to managed PostgreSQL (AWS RDS, Google Cloud SQL)
2. **Persistent Storage**: Configure S3-compatible storage for user uploads
3. **Redis**: Add Redis for Socket.IO scaling (currently single-instance)
4. **Monitoring**: Add APM (Datadog, New Relic) and error tracking (Sentry)
5. **CI/CD**: Automate staging deployments on merge to `main`
6. **Preview Deployments**: Enable Vercel preview deployments for PRs
