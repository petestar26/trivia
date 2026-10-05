# Payment administration follow-up — 4 October 2026

## Scope

The user selected Ethiopia / ETB as the first country, then clarified that no crypto provider account exists yet. Crypto remains disabled until a provider is chosen, configured and integrated. No credentials should be sent in chat.

Implemented in this candidate:

- Admin country creation and activation/pause controls, inactive-by-default Ethiopia form, payment-method creation and activation controls.
- Country setup status using current rate selection, matching approved accounts, unreserved Coin inventory and exact fiat-liquidity balances. This view is advisory; existing transaction admission remains authoritative.
- Agent application and payment-account approval/rejection queues, suspension/reactivation, approved-account disable, and the latest 100 deposit orders.
- Initial inventory/fiat allocation and reasoned adjustment forms backed by existing services, locks, ledger and audit mechanisms. Adjustments remain super-admin-only; inactive super-admin authority is now rejected at the service boundary.
- Funding retries retain their exact amount/key across uncertainty and use a separate browser storage namespace from customer wallet requests.
- Authenticated owner-only agent onboarding profile, agent application and payment-account submission screens. Failed profile lookup cannot be mistaken for permission to create an application.
- USDT, USDC, BTC, ETH and SOL catalog entries shown as unavailable. Native asset networks are labeled; stablecoin network selection explicitly awaits provider mapping. No addresses, payment creation, webhook settlement or manual crypto crediting exist in this candidate.
- New admin API responses are private/no-store. Fiat amounts are parsed as integer minor-unit strings before reaching existing liquidity services.

## Verification

API review suite: 98 passed across 12 files. Focused wallet/admin/onboarding/frontend suite: 18 passed across four files. API and web strict typechecks and production builds passed. Vite reports the existing large main bundle warning (approximately 511 kB minified); no build failure.

All PostgreSQL 13, 16 and 18 jobs completed successfully in [run 37209045858](https://github.com/petestar26/trivia/actions/runs/37209045858) for application commit `fbe9a7c07211739cc482394428fe73c9518d9e85` (local `1519bca`, identical tree `747c7209cd2929db7a0a015d40ca632b28d74179`). The matrix includes payment lifecycle, concurrency, legacy compatibility, ledger, migration, financial settlement/refund, frontend and builds.

The user applied the staging patch. API deployment `7aef126c-e25d-44d9-958e-d7104c2bc19a` and web deployment `2f7a1931-7fc1-4724-963d-e791a7f16adf` succeeded at `bc9251151dd8bba68555527b6f0bd2828385f278` (documentation-only changes after tested application `fbe9a7c`). No staged changes remained after that rollout.

Browser verification retained the signed-in session after the app-update reload, displayed all five unavailable crypto options, and denied an ordinary user's access to the processing desk. Agent onboarding exposed a frontend response-contract defect: `/agents/me/setup` returned HTTP 200 with `data:null` for no existing profile, but shared `unwrapData` rejects null. The original test mock incorrectly bypassed that real decoder.

A frontend-only correction now accepts explicitly successful null on this one endpoint, preserves errors for unsuccessful/missing data, and uses the real response decoder in regression tests. Thirty focused frontend/API-client tests passed, as did web strict typecheck and production build. Backend and schema are unchanged from the successful native matrix. The corrective web release is now deployed and browser verified: deployment `50ff884e-c566-45fa-bdb9-05e6b62cc0c4` succeeded at exact commit `3ab300ac15a541a13fcf57ca58da56fb0428e120`. All PostgreSQL 13, 16 and 18 jobs passed in [run 37210507491](https://github.com/petestar26/trivia/actions/runs/37210507491). After the app-update reload, the signed-in agent setup form loaded correctly. It explains that an administrator must activate a country, and submission remains disabled while no country is active. No application or financial transaction was submitted. No staging changes remain pending. Full admin controls cannot be browser-verified with the current ordinary-user session; no privileges were changed.


## Configuration still needed

No real country flags, agents, backed funding, exchange rate or customer balances have been created or changed by this implementation. The Ethiopia form is a default value, not a live activation.

Operational order: create country; activate its directory; configure/activate bank or mobile methods; publish a verified current USD/ETB rate; enable agent payments when operations are ready; agents apply and submit receiving accounts; administrators verify/approve; record actual backed Coin inventory and fiat liquidity; complete the existing jurisdiction/account eligibility controls and supervised settlement rehearsal. Enabling a country does not override any ledger/jurisdiction checks.

The live agent identity, verified account details, backing and rate source cannot be invented. Admin funding records represent backing; they do not transfer bank funds.

Crypto integration requires selecting and setting up a provider account. Once selected, verify its supported asset/network pairs and sandbox API contract, then implement persisted payment intents, authenticated notifications, reconciliation, exact verified crediting, replay/race protection and admin exception handling against the existing Coin ledger. Provider credentials belong in secure deployment configuration. Actual crypto deposits/withdrawals are not implemented merely by listing these five assets.

No new database migration is required for this administration candidate. Existing schema/grants and service financial protections are reused. Production remains untouched.

## Staging administrator bootstrap — 5 October 2026

The owner requested `playqube@admin.com` for payment administration. A separate owner-run command, `node apps/api/dist/scripts/staging-payment-admin.js --apply`, grants only ADMIN to that exact already-registered, active password account. It never creates credentials, changes a password, grants SUPER_ADMIN, changes balances or activates payments. `--verify` performs no writes. The existing exact staging environment/host/database/acknowledgment guard is shared in `staging-payment-target.ts`; importing it cannot execute another bundled CLI command.

The command requires the database owner, locks the target user, and commits role change, session deletion, token-version increment and an operator-attributed audit entry in one transaction. Repeated execution does not revoke sessions again, and a consumed bootstrap cannot restore a later-demoted or replacement account. Production is rejected. This is an explicit setup-helper command, not API startup behavior.

Validation: 13 focused bootstrap/target-guard tests passed; package-scoped API typecheck and build passed. The built CLI rejected execution outside the staging target. An initial root-level TypeScript command used the shared base config rather than an application config and failed on unrelated web aliases/JSX; the proper API project check was then used. No claim of a live database grant is made until helper deployment logs confirm success. The current request authorizes Telebirr, M-Pesa and CBE Birr as initial methods, but those configuration changes and backed operational setup remain pending.
