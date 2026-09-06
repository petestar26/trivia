# H-0D staging activation runbook

Status: **waiting for Railway API domain**. This commit prepares documentation only.
No Railway/Vercel deployment, database operation, or production promotion is part
of this task. All activation and smoke-test boxes remain pending until performed.

## Before activation

- [ ] Confirm the deployment targets are isolated staging resources, with no
      production database, credentials, domains, or branch deployment targets.
- [ ] Use Railway project **playqube-staging**, with **PostgreSQL**, **API**, and
      **worker** services.
- [ ] Keep root/source directory at the **repository root** for API, worker, and
      Vercel; do not set it to `apps/api` or `apps/web`.
- [ ] Set API config path to `deploy/railway/api/railway.json`.
- [ ] Set worker config path to `deploy/railway/worker/railway.json`.
- [ ] Set secrets only in Railway/Vercel dashboards, scoped to staging. Never
      commit credentials, tokens, keys, connection strings, or any `.env` file.
      Use the variable-name reference in [staging.md](staging.md); do not execute
      its historical CLI variable-setting examples for secrets.
- [ ] Run `pnpm --filter web build` and `pnpm --filter api build` from repo root.

The existing API and worker configs both build with
`pnpm install --frozen-lockfile && pnpm --filter api build`. The API starts with
`pnpm --filter api start`; the worker starts with `pnpm --filter api start:worker`.
The API config runs existing migrations through
`pnpm --filter database exec prisma migrate deploy` before deployment. Confirm
those migrations succeed against staging before starting the worker. Do not create
or modify migrations, reset the database, or change application logic in H-0D.

## Domain gate and later Vercel activation

- [ ] Obtain the actual public domain from the staging Railway API service.
- [ ] Verify HTTPS `https://<actual-api-domain>/health` returns a healthy response.
      `/health` is a top-level route, not `/api/v1/health`.
- [ ] Only after the domain is known, copy
      `deploy/vercel/vercel.staging.example.json` to root `vercel.json`, replacing
      every `REPLACE_WITH_RAILWAY_API_DOMAIN` with that verified hostname.
      Do not use a guessed hostname or commit an unresolved placeholder.
- [ ] Preserve `framework: vite`, install command
      `pnpm install --frozen-lockfile`, frontend build command
      `pnpm --filter web build`, and output directory `apps/web/dist`.
- [ ] Preserve `/api/(.*)` to Railway `/api/$1`, `/ws/(.*)` to Railway `/ws/$1`,
      bare `/ws` to Railway `/ws`, and the final SPA fallback to `/index.html`.
- [ ] Review that future config change separately before activating staging.
- [ ] Configure the Vercel staging/preview target and set the actual frontend URL
      and CORS origin in the Railway dashboard. Keep secrets out of frontend bundles.

Until this gate is satisfied, root `vercel.json` must remain absent. This runbook
does not authorize a production deployment or branding/package rename.

## Required staging smoke tests

Use staging-only test accounts and test data. Record pass/fail and non-secret
evidence for each check; a successful local build is not a staging smoke-test pass.

- [ ] API `/health` responds successfully over HTTPS.
- [ ] Existing database migrations are applied successfully (API deployment logs).
- [ ] Register and login work, including an authenticated request.
- [ ] The authenticated wallet endpoint returns the expected staging test account data.
- [ ] Games catalog loads.
- [ ] Play one game with staging test data and verify completion/result.
- [ ] Worker logs show `timeout sweep completed` and `reconciliation completed`;
      allow for the configured intervals and check for errors.
- [ ] Vercel frontend loads, and refreshing a SPA route works.
- [ ] Vercel `/api` rewrite works for an actual `/api/v1/*` request.
- [ ] Test the actual WebSocket upgrade and realtime delivery through `/ws` from
      the Vercel frontend. The Vercel rewrite is unverified and may need follow-up;
      a successful HTTP request or polling connection alone does not prove that
      WebSocket works. Record a failure as a readiness blocker and open a separate
      follow-up for transport/proxy/client changes.

## Stop or recover

If builds, migrations, health, or required smoke tests fail, stop activation and
record the failure without secrets. Restore a known-good staging application
revision only after checking database compatibility. Do not promote production,
reset a database, or edit already-applied migrations as a rollback shortcut.

## Commit scope

H-0D currently changes only `docs/deployment/staging.md` and this runbook. Leave
`docs/withdrawal-w1-w2-design.md`, nested `trivia/`, all `.env` files, application
code, Prisma schema/migrations, and money/withdrawal logic untouched and unstaged.
