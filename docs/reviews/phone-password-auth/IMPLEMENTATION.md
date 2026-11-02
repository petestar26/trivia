# Phone/password account access — implementation ready, live rollout blocked

User-requested behavior: choose Email or Phone for registration and password login; no SMS or OTP. Phone is an unverified identifier. It is never proof of ownership, a recovery channel, an automatic account-linking key, or a verified financial identity. Anyone who knows an unused number can reserve it; number ownership and recovery are not established by this flow.

Uses existing AuthProvider.PHONE and UserAuthIdentity(provider, providerSubject) unique constraint. Phone accounts have null email and verifiedAt remains null. No migration, fabricated email, SMS provider, credential change, or verification upgrade is introduced. Input is international +country-code format, 8–15 digits; ASCII spaces, parentheses and hyphens are removed. Exactly one email/phone is accepted per request. Identity and user/session writes remain in the registration transaction; uniqueness conflicts do not link accounts or retry identity reservations.

Member UI defaults to Email. Switching method clears form values/errors. Phone uses a password and retains safe return destinations. Existing staff login remains email-only. AuthProvider sends the explicitly selected identifier; plus-prefixed email addresses remain email addresses. Password policy, cookie/origin checks, session handling and existing auth rate limits are retained.

## Verification

Final non-overlapping suites:
- 117 frontend tests: member forms, login/signup returns and auth provider.
- 31 isolated Fastify API tests: 14 phone/schema/password tests + 17 existing cookie tests. Database operations are mocked; bcrypt/password checks and HTTP request validation are real. This does not establish native database transaction concurrency.
- 35 Node checks: 27 PWA/recovery + 8 gateway.
- Shared build, web typecheck, API typecheck, Vite production build and API build passed.
- git diff --check passed.

Failure accounting: initial pnpm invocation failed because the available pnpm wanted to reinstall an incompatible lockfile; no reinstall was permitted. Direct installed binaries were used. First API test collection failed on missing compiled workspace packages; isolated test aliases and local package builds resolved it. One frontend regression caught changed login autocomplete and was repaired to preserve username autocomplete. Test-only TypeScript annotations/options were corrected. Earlier runs overlap and are not added to final counts. Native PostgreSQL, live account creation, physical devices and current CI were not run.

## Deployment facts and remaining work

Read-only Railway inspection on 2026-11-02 found:
- Preview 9e39a3ef-b51c-4bd2-8539-5cb08c60eccd is a disconnected static design service. It is not an authentication backend.
- Staging API 62961179-a0e4-472c-98df-40d785673b06 follows feat/group-moderation-notifications and runs `pnpm --filter @socialplay/database db:migrate:deploy` before deployment.
- Staging member web 0a918c9f-9685-4a9a-804a-723e0dcb1d2d remains on the older branch/configuration.
- Their listed configuration does not establish the new production web gateway's required shared WEB_GATEWAY_SECRET or same-origin cookie integration.

Do not replace the existing staging API with this cumulative frontend branch or run its migration predeploy as part of this change. Phase A2 remains CLOSED. No service was staged or deployed, no database was contacted, and no real account was created. The existing preview stays unchanged with disabled fields.

Before live rollout: choose the exact compatible API/web baseline and target; verify existing PHONE identity schema and required grants on that target; prepare a migration-free deployment and inverse; provision the required gateway identity through protected configuration; test email and phone registration/login/logout/refresh and return paths against an isolated real database. Review the exact resulting diff before deploying. Do not enable financial features.

Unrelated local lounge.webp change was not included. The local web build used the current checkout including that pre-existing asset; no clean-artifact deployment claim is made.
