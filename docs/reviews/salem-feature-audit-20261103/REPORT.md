# Salem Bet account-test feature audit — 3 November 2026

This is a source/integration audit and a bounded web release, not certification that every platform feature is operational. Target: the separate PlayQuibe Account Test project / account-test environment, account-web at salem.bet. Original PR57 staging/recovery, financial activation and the original production services are excluded.

## Exact source

- Previously deployed website: `214c084513c581472cc84620a80d6c44ce5393af`.
- Integrated Football PR59: `06dd6be831d6b61fa253c1d4bb5f25f29420158e`.
- Integrated Derby PR60: `abc397fd09e7c9b02f036f5640a6075fe1d8ef9b`.
- Shared visual baseline: `b899e158bd84a6975011182c939ef62a6fcdc1ad`.
- Local combined code tree before these audit documents: `a9501b11614de22afb540c7025ee9098946ed537`.
- CODE_SHA256SUMS pins the 190 changed source/assets/test paths against the previously deployed website. Existing Salem Bet branding, account/domain/session and dashboard changes are retained; the older visual branches were not substituted for the website.
- The current API deployment before this release is `dc7b2351-97aa-4fde-8a8e-fa1ca5b44aba`, source `6e55fd188a21c0c290421a47ee1eac5d811b352f`. Its trusted FRONTEND_URL was already corrected to salem.bet in the preceding approved operation.

## Confirmed repairs

1. Public administrator/agent login and agent activation now remain reachable during the initial session probe; protected routes remain gated. Six negative regressions reproduced first.
2. Game catalog/API and client availability now consistently respect Dice, Crash Point and Turbo Keno practice flags. Unavailable cards remain visible without offering a misleading entry link. Three API negative regressions reproduced first. The API half is prepared but is not part of the web-only deployment below.
3. Football's displayed ball no longer scales the 0.11 m contact sphere to 0.154 m. Tests inspect actual world-space mesh vertices and preserve complete director frames for both scoring sides and normal/reduced motion. Two negative regressions reproduced first. This is not a full swept-collision or physical-device acceptance claim.
4. Wallet country details no longer unconditionally claim crypto is unavailable; they link to the existing gate-driven USDT wallet. Both deposit/withdraw views have negative regressions.
5. Rewards now report achievement/VIP/progress fetch failures explicitly instead of showing false-empty or silently missing results. Three negative regressions reproduced first.
6. Gateway cache policy now matches actual sw.js/workbox-*.js basenames, not arbitrary parent directory names. Two negative cache-policy regressions reproduced first.
7. Fixed an outdated login/register integration-test mock that omitted the Google client-ID export. This was a test-fixture failure, not a production repair.

## Feature matrix

| Feature | Verified scope | Remaining condition |
| --- | --- | --- |
| Welcome, exploration, registration/login pages | Existing routes and new account-test web regression suite | Actual email/phone registration/login smoke did not complete in this audit |
| Email/phone password authentication, sessions/logout | 46 offline route tests plus the web suite | The automated live client received HTTP 403; a subsequent health probe identified Cloudflare error 1010. No successful disposable-account creation was observed. No fingerprint/security bypass was attempted |
| Google sign-in | Implementation exists | Required browser/server Google client-ID enrollment is absent from current service variable listings; do not advertise it as operational |
| Groups/invites/membership/chat/replies/reactions | Frontend/API routes and scoped tests present | Fresh authenticated live acceptance not completed; group practice gate remains closed |
| Voice/media | Code exists | API has no attached persistent volume. Local storage is implemented, external S3/R2/MinIO adapters are placeholders. Actual provider value/current file inventory and preservation remain unverified; browser runtime inspection timed out. Do not restart API to ship the prepared catalog change before preservation is resolved |
| Profile | View and TOTP exist | No implemented profile editing or password-recovery flow |
| Competitions/challenges | Frontend/API lifecycle actions wired | Fresh live lifecycle/transaction acceptance unrun |
| Rewards/tasks/achievements/progress/notifications | Implemented; error handling repaired; tests pass | Fresh live processing/timing acceptance unrun |
| VIP/referrals | VIP status and registration referral attribution exist | No member VIP purchase or referral dashboard/share flow |
| Admin/agent/activation/wallet/history | Source routes and permissions plus focused tests | Live approved staff-account acceptance unrun |
| Agent-assisted deposits/withdrawals | Implemented quote/order/review flows | Country/account/liquidity/jurisdiction/KYC/step-up prerequisites; no financial operation attempted |
| USDT/TRON | Implemented API/UI/verifier | Separate restricted verifier service, provider key/address pool and approved activation gates; other crypto assets remain placeholders |
| Gift collection | Implemented gated API/UI | Enabling flag/migration/runtime authority and live acceptance not established; no gate changed |

### Every catalog game

| Game | Source / deployment assessment |
| --- | --- |
| Spin Win / current Lucky Spin label | Implemented scheduled practice route; legacy /games/lucky-spin is retired. DB stream/scheduler readiness must be established |
| Dice | Implemented system practice route; SYSTEM_DICE_PRACTICE_ENABLED and scheduler readiness required |
| Turbo Keno | Implemented system practice route; SYSTEM_KENO_PRACTICE_ENABLED and scheduler readiness required |
| Crash Point | Implemented practice route; CRASH_POINT_PRACTICE_ENABLED and runtime readiness required |
| Number Challenge | Implemented practice route; NUMBER_CHALLENGE_PRACTICE_ENABLED and ticking worker required |
| Sky Crash | Implemented practice visuals/routes; SKY_CRASH_PRACTICE_ENABLED/runtime acceptance required |
| Thunder Derby | Latest reviewed visual repairs integrated; THUNDER_DERBY_PRACTICE_ENABLED/runtime/device acceptance required |
| Virtual Football | Latest one-selected-player visuals and bounded ball fix integrated; VIRTUAL_FOOTBALL_PRACTICE_ENABLED/runtime/device acceptance required. Whole-roster realism is not implemented |
| Trivia | Standalone restricted-reward source flow exists; live dataset/admission acceptance unrun |
| Neon Hounds, Turbo Circuit, Starfall Nebula, Jungle Dash, Crystal Trail, Heat Vault, Strait Rush | Seven genuine catalog placeholders without standalone implementations; a deployment cannot make them functional |
| Coin Flip | No standalone implementation/route found |

API service listings contain no practice-enable flags and there are only web/API/Postgres services in account-test. Some snapshot handlers can lazily advance rounds, so absence of a worker is not proof that every route fails; it is not a verified continuous operational deployment either. No enabling flags, odds, payouts, balances, clocks or server outcomes were changed.

## Validation and accounting

- Final complete web suite: **2,053 passed**, zero failures/skips.
- Web TypeScript/Vite production build: PASS; existing chunk-size warnings retained.
- Gateway + generated PWA/recovery: **36 passed** (9 gateway + 27 PWA/recovery), zero failures/skips.
- API/database/config/shared/storage compilation: PASS. Prisma client generation is local; no live migration or database test was run.
- Offline API review suite: **299 passed**. Auth route suite: **46 passed**. Focused catalog suite: **27 passed**. These groups may overlap; do not sum them into unique platform coverage.
- Earlier focused web runs overlap the final complete suite and are not added to its count.
- First complete web run: 2,048 passed / 2 failed because the Google client-ID mock export was absent. Focused corrected tests passed before the final full run.
- Installer accounting: an accidental unpinned nested pnpm command changed generated dependencies/lock/workspace files; source lock/workspace were restored, generated dependency directories were rebuilt with pinned pnpm 8.15.9 and a clean frozen install passed. A subsequent nested build launcher needed the same pinned wrapper; that launcher failure preceded compilation. An API test command initially resolved a duplicated config path and failed before collection; corrected command passed. None is silently relabeled as a product pass.
- Development preview failed because the managed preview could not resolve monorepo dependencies; the compiled static welcome loaded, but static direct SPA URLs were not a usable staff-route browser test. Staff loading routes are covered by the regression suite, not a claimed successful local live-API test.
- Browser connection timed out during runtime storage inspection. No source/media capture, actor exclusion, staging operation, betting/payment, credential use, or financial activation occurred.
- Native PostgreSQL/full API integration, physical Android/iPhone/Safari, thermal/GPU, 1,000-user load, full live staff/group/media/game acceptance and financial recovery/security closure remain unrun. CI results for parent visual commits are historical; they do not automatically certify this combined candidate.

## Deployment boundary

Release only account-web after terminal SUCCESS is observed for the exact published candidate. Preserve current API/database deployments and financial/maintenance gates. The prepared API catalog correction must remain explicitly NOT DEPLOYED until existing media is inventoried/preserved or durable storage is established safely. This prevents the audit from silently putting ephemeral uploads at risk.

The next operational work is concrete: establish protected media persistence; complete Google client enrollment; define approved practice-only worker/flag setup and its tests; then perform authenticated/device acceptance. None of these prerequisites is established by a green mocked suite.
