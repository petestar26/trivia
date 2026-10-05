# Separate administrator, agent and member workspaces

## Delivered

Dedicated administrator entry `/admin/login` and `/admin` dashboard, approved-agent entry `/agent/login` and `/agent` workspace, and existing member `/login` and app. They share the established authenticated session; changing the URL never grants a role. Separate credentials should be used for separate staff identities. No agent account is automatically created or approved.

Admin dashboard has actual counts for member accounts, active agents, unexpired active groups, catalog games, pending agent applications, pending receiving accounts and enabled payment countries. Dedicated pages connect existing country/method/agent/funding controls, pricing/packages and dispute review. Accounts have bounded searchable pages and show role, member status and agent-profile status. Game catalog is read-only and excludes configuration/outcomes. Latest 100 audit events exclude raw before/after payloads, IP addresses and credentials.

Agent workspace connects only the approved agent's existing assigned deposit/payout processing and receiving-account submission. Admin and agent processing panels are explicitly separated even if an identity has both capabilities. Legacy `/wallet/operations` redirects to the appropriate workspace. Member wallet links and admin sidebar entry point to the separate portals. Login pages distinguish roles and preserve safe same-workspace deep links; ordinary login behavior remains intact.

Backend workspace access checks current active user status and current approved-agent status. Every new admin data endpoint checks current ADMIN/SUPER_ADMIN authority, not role claims in a stale token. Responses are private/no-store. UI fails closed during access-query failure and refreshes access periodically. Existing mutation services retain their own permission/ownership checks.

## Administrator bootstrap result

The previous setup completed in deployment `4215574b-1be3-48f5-86b0-232adb77e0a3` with runtime status `ADMIN_GRANTED_SIGN_IN_AGAIN` for the requested registered account. Password unchanged. Role is ADMIN, not SUPER_ADMIN; owner-only financial adjustments remain restricted. No role change is included in this dashboard release.

## Validation

API review suite: 117 tests passed across 14 files; the eight new workspace endpoint tests cover stale-role denial, suspended users, agent approval separation, field filtering, pagination and current metrics. API project typecheck and build pass after correcting explicit Fastify test callback types.

Frontend: seven new workspace tests, 13 existing wallet/onboarding tests, and 25 existing/extended login, registration and error tests passed (45 distinct focused tests total). The login return-path set has 19 tests including dedicated staff landing and admin deep links. Web typecheck and production build pass. Existing React test act/router warnings and approximately 523 kB main-bundle warning remain nonfatal. The full native CI matrix and browser results are recorded separately after publication/deployment, not assumed from local tests.

## Boundaries and pending work

No migration or new secret is required. No payment country/method activation, liquidity funding, provider integration, live transaction or production change is included. Telebirr, M-Pesa and CBE Birr remain pending configuration. Existing payment account eligibility and backed operational setup still apply.

This is a connected staff dashboard, not unlimited platform control. Account roles/password resets, member suspension/moderation, game-rule editing, advanced analytics and MFA are not implemented by this release. Super-admin-only financial operations retain that restriction. The account directory, game catalog and audit screens are read-only. Actual admin/agent mutation browser tests require appropriate signed-in sessions and approved operational data; no financial action should be fabricated for visual testing.
