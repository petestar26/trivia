# Eight-language interface and casino presentation

This release translates the first-party member, group, game, wallet and staff
interface into English, Amharic, Afaan Oromoo, Tigrinya, Somali, Arabic, Swahili
and French. It adds black and emerald surfaces, gold accents, dimensional game
pieces and reduced-motion support. All twelve group games retain their saved
backend outcomes, accepted choices, fees and automatic settlement rules.

Translations are checked-in static files. No paid translation API was called.
Language changes preserve open forms, user-authored content, canonical game
selections and exact wallet amounts. Arabic uses right-to-left layout. Currency
formatting accepts integer minor-unit strings without losing large-value
precision. The install cache includes all four translation bundles and the app
entry. Provider-owned game interfaces retain their own language support.
Public sign-in, registration, recovery and welcome pages expose the same language
menu. The existing release workflow runs the strict translation audit, its tool
regressions, language/state tests and install-cache checks on future UI changes.

## Candidate validation

- The expanded import-graph audit covers 3,022 of 3,022 detected static messages,
  using 3,850 catalogue entries. No missing language entries, placeholder
  mismatches or conflicting duplicates were found. Four offline audit-tool
  regression tests pass. Dynamic metadata and raw text were reviewed separately;
  source coverage is not a claim of independent native-speaker approval.
- All 2,555 web tests in 176 files pass with two workers. These include language
  changes preserving profile/support drafts, unchanged user-authored content,
  exact minor-unit wallet values, game selection mappings and group consent.
- The final public-language controls pass 85 focused auth tests, including nine
  new regressions that use the actual menu in all eight languages and preserve
  input nodes, drafts, phone/email choices, referral codes and recovery tokens.
  No auth or API submission is made by those new checks. A full-suite rerun is
  also in progress for this last addition.
- Web and API production builds pass. All 29 install/cache checks and 27 isolated
  support-assistant unit tests pass. The assistant tests mock external calls.
- The production browser matrix passes all 120 page/language/viewport cases,
  plus an Arabic mobile drawer check: no overflow, JavaScript errors, financial
  writes or detected static English fallbacks. Data is synthetic and requests
  outside the local preview are blocked. This is not authenticated live-account
  or physical-device evidence.
- The group-language browser matrix passes 798 checks across all twelve games,
  eight languages and 1440/390/320-pixel viewports. Rules, selections, saved
  results, fees, payouts, localized crash inputs, personal replays and result
  links were checked with synthetic data. It recorded no overflow, browser
  errors, external requests or financial write attempts. The helper mocked 408
  ordinary activity heartbeats. Its initial empty-lobby selector assumption was
  corrected without changing the application; the failed report is preserved.
- Full lint remains baseline debt: 60 errors and 59 warnings compared with 61
  errors and 59 warnings at the preceding commit. No new lint errors were found.

## Preserved failures and scope

Earlier full-suite runs found outdated English toast/navigation expectations and
resource-contention timeouts. The assertions were updated for rendered content;
financial assertions and timeout limits were retained. The complete bounded
rerun above passed. An earlier development-server browser run recorded ten
hot-reload context errors while source files changed. The stable production
matrix above has none; the earlier report is preserved.

The first translated production bundle exceeded the install cache's per-file
limit. Four static translation chunks fixed that, and a release-artifact test now
checks the app entry and every language pack in the actual generated cache.

No database schema, wallet settlement, worker, cash-activation gate or payment
configuration is changed. The broader scheduled-round workflow has previously
reported native ETB hold-fixture failures, as documented in the preceding shared
view release. Those guards have not been relaxed. Seven coming-soon catalogue
titles remain unavailable. Native-speaker, physical-device, Safari and load
acceptance remain outside this release's evidence.

## Reproduction and evidence

Run `pnpm --filter web exec vitest run --maxWorkers=2 --minWorkers=2`,
`pnpm --filter web build`, `pnpm --filter api build`, and
`pnpm --filter web test:pwa`. Run the static audit with
`node apps/web/src/lib/i18n/tools/coverage.mjs --strict` and its tool tests with
`node --test apps/web/src/lib/i18n/tools/inventory.test.mjs`.

Use `scripts/review-interface-languages.mjs` and
`scripts/review-together-languages.mjs` against a built loopback preview, with
`PLAYWRIGHT_MODULE` pointing to an available local Playwright installation.
Both helpers block real financial mutations. Local logs and screenshots are
under `/private/tmp/salem-eight-language-production`,
`/private/tmp/salem-group-languages` and `/private/tmp/salem-i18n-*`.

Deployment identity will be recorded after the live checks complete.
