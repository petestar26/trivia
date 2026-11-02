# Google sign-in account-test integration

Scope: port the existing feat/google-auth-6 Google Identity Services flow into the current dashboard account branch. Keep the current cookie/origin/session protections and email/phone authentication. No database schema changes, account linking, financial activation, or changes to PR57 holding services.

Google uses the verified provider subject as its ownership key, a hashed HttpOnly nonce cookie, official google-auth-library signature/issuer/audience/expiry verification, and username onboarding. Browser responses exclude bearer tokens. Credential operations use the same cross-tab session lock and identity-cache boundary. Production certificate fetches have a 10-second timeout and retries disabled. Missing GOOGLE_CLIENT_ID fails closed; the UI hides Google when VITE_GOOGLE_CLIENT_ID is absent.

Phone helper copy is now: “Use your country code and a password.” This wording change does not mark phone ownership verified or create a phone recovery flow.

## Google Cloud setup

In the existing Google Cloud project's Google Auth Platform > Clients, select the Web application client (or create a web client if none exists). Add this exact Authorized JavaScript origin, without a path or trailing slash:

https://account-web-account-test.up.railway.app

Complete the required branding/audience configuration. If the app is in testing mode and subject to test-user restrictions, add the intended test users. This integration uses a JavaScript credential callback, not a redirect callback. Supply only the public client ID ending in .apps.googleusercontent.com; no client secret is needed by this implementation.

Then set GOOGLE_CLIENT_ID on account-api and VITE_GOOGLE_CLIENT_ID on account-web to the same ID and rebuild/redeploy both exact services. Exercise real Google consent, username onboarding, returning sign-in, logout and existing-email collision handling before calling Google sign-in live-verified.

Official documentation:
https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

## Verification and limits

API: 46 focused tests passed (15 Google, 14 phone, 17 cookie), using mocked database/provider verification. Web: final focused test counts are in the execution report. Shared/config builds, API/web typechecks, API/web builds and gateway/PWA tests were run. Google provider consent is unrun because the new stack has no client ID. Tests do not prove live Google configuration.

Initial web run exposed old test mocks missing the new googleClientId export and a nonce-effect cleanup issue; mocks and cleanup were corrected. Initial API run used stale generated shared/config outputs, causing two missing error-code assertions and type errors; packages were rebuilt and tests rerun. Initial package-manager add was interrupted before it changed the package/lock; the exact Google dependency closure was carried from the existing Google branch lock, locally installed in isolation, and validated with pnpm 8.15.9 frozen-lockfile mode.

The unrelated local lounge.webp change and prior phone deployment artifacts are excluded from this commit.
