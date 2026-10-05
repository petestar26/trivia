# Administrator-created agents

Administrators can use `/admin/agents/new` to create separate accounts repeatedly with a unique username, email, display name, active country and temporary password. The account is a plain USER with an approved Agent profile, not an administrator. The form is ready for another account after each success. No wallet, funds or receiving account is provisioned.

The temporary password is bcrypt-hashed separately, expires in 24 hours, is never returned and cannot establish a session. The account stays PENDING_VERIFICATION with no login password. At `/agent/activate` the agent exchanges the temporary password once for a different private password, then signs in at `/agent/login` using their email. Pending credentials can be replaced from the same administrator page. Activated private passwords cannot be reset through this feature. Share credentials through an appropriate private channel.

Authorization checks current active administrator status both at the route and service boundary, with a transaction lock before writes. Creation is atomic; duplicate usernames/emails produce conflicts without partial profiles. Activation uses a user row lock and a conditional, single-use credential claim. Hashes are limited to bcrypt's 72-byte input capacity. Credentials do not enter browser query caches or logs; database credential queries use a logger-free client and sanitize errors. Endpoint responses use private/no-store; activation and creation are rate limited.

## Database and deployment

Migration `20261005130000_admin_agent_onboarding` adds the restricted-FK setup table and `activate_provisioned_agent(text,text,text)`. PUBLIC cannot execute the function. It only transitions a pending plain USER with an active Agent profile and a matching unexpired setup credential; normal user role/status protections remain unchanged. Runtime needs SELECT/INSERT/UPDATE on the setup table and EXECUTE on that function. The exact-target staging upgrade helper applies these additive grants and verifies them. Run that helper before deploying API/web. Do not apply unrelated pending Railway changes or use this helper against production.

## Validation

Local focused UI/workspace tests: 11 passing. API route authorization/rate-limit and staging-target checks: 7 passing. API typecheck and build pass. Web typecheck and production build pass (existing large-chunk advisory remains). Added disposable native PostgreSQL tests covering restricted-role provisioning/activation, duplicate rollback, single-winner concurrent activation, expiry/reissue, administrator suspension, inactive countries and byte limits. The four native onboarding tests passed on PostgreSQL 13/16/18 in run 37310425140. That run then caught missing explicit parameter annotations in the route test harness; these are corrected in the follow-up. Full replacement CI and live deployment verification must complete before this feature is called deployed.

No real agent account, receiving destination, funds, deposit or withdrawal was created as part of this implementation. An operator must still configure verified receiving accounts, an approved rate and backed liquidity before country payments are enabled.

## Staging browser verification

Application `bcb88de5d62fbb7b919c7e750986517e90c57bfd` deployed successfully: API `d86cc1eb-d22c-4616-91c6-0d746f97915c`, web `a5ba4ffb-937c-47b5-adcf-bee6e6f2193e`. Helper apply `10aaa374-2e2a-4932-b02e-45cb61a9ecf8` and read-only verification `c32cf159-d2a9-4948-bcb4-c8b24b393a91` confirmed onboarding migration/grants; zero payment countries enabled. Staging has no pending changes.

Live browser retained the admin session after the app-update reload. Create agent is visible in navigation; the form loads Ethiopia and the pending-activation endpoint returns its empty state. The separate activation page renders all four credential fields and the agent login link. Both desktop layouts were visually inspected. No credentials were entered and no real account was created.

Run 37311251702 passed onboarding, authorization, API typecheck and payment tests, then its historical migration inventory rejected the newly added migration because its expected list was not updated. The follow-up explicitly includes the new forward migration while preserving the historical fixture boundary. Replacement full CI remains required; this correction changes tests/documentation only.
