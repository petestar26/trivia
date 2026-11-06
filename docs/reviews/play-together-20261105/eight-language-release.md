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
- All 2,566 web tests in 178 files pass with two workers at `4722a24`. These include language
  changes preserving profile/support drafts, unchanged user-authored content,
  exact minor-unit wallet values, game selection mappings and group consent.
- The final public-language controls pass 85 focused auth tests, including nine
  new regressions that use the actual menu in all eight languages and preserve
  input nodes, drafts, phone/email choices, referral codes and recovery tokens.
  No auth or API submission is made by those new checks. The full-suite result
  above includes these additions and the subsequent styling regressions.
- Web and API production builds pass. All 29 install/cache checks and 27 isolated
  support-assistant unit tests pass. The assistant tests mock external calls.
- The production browser matrix passes all 120 page/language/viewport cases,
  plus an Arabic mobile drawer check: no overflow, JavaScript errors, financial
  writes or detected static English fallbacks. Data is synthetic and requests
  outside the local preview are blocked. This is not authenticated live-account
  or physical-device evidence.
- After the final styling corrections, the complete 120-case matrix passed
  again on `4722a24`, alongside eight sign-in style cases. Four languages at
  320/390 pixels preserve selected and unselected button styling after language
  and sign-in-method changes. An additional 48 public-page cases and six profile
  cases passed for the preceding public-menu and username corrections.
- The group-language browser matrix passes 798 checks across all twelve games,
  eight languages and 1440/390/320-pixel viewports. Rules, selections, saved
  results, fees, payouts, localized crash inputs, personal replays and result
  links were checked with synthetic data. It recorded no overflow, browser
  errors, external requests or financial write attempts. The helper mocked 408
  ordinary activity heartbeats. Its initial empty-lobby selector assumption was
  corrected without changing the application; the failed report is preserved.
- Full lint remains baseline debt: 60 errors and 59 warnings compared with 61
  errors and 59 warnings at the preceding commit. No new lint errors were found.

## Hosted release checks

[Play Together run 42148886545](https://github.com/petestar26/trivia/actions/runs/42148886545)
passed on PostgreSQL 13, 16 and 18 at exact source commit
`4722a24ae3df7fee23f4c06fbf810bff2f58ec4f`. On each database version, the native
group, prior group, sportsbook, Birr, staff and reward contracts passed. PostgreSQL
16 also passed production builds, 80 language/style/form checks, four inventory
checks, the strict 3,022-message audit and all 29 install/recovery checks. The
production entry was 1,233.88 kB and the generated worker precached 41 files.

The final signup styling follow-up `f2d3940351d02299ff62775b8fa4d4f2185b4991`
changes only the existing registration method wrapper's styling class.
[Play Together run 42152610104](https://github.com/petestar26/trivia/actions/runs/42152610104)
also passed all three PostgreSQL jobs, production builds, 80 language/style/form
checks, four inventory checks, the strict audit and 29 install/recovery checks.
The follow-up passed 11 focused local tests and 16 production-preview browser
cases covering both sign-in and signup methods in all eight languages.

[Scheduled run 42148886579](https://github.com/petestar26/trivia/actions/runs/42148886579)
retains the pre-existing native stake-hold fixture failure: each database version
reported 14 failures and 16 passes at that step. All 14 failing test names and
the `Native ETB wallet requires ETB pricing terms` error were compared against
the preceding baseline run 42114834277 and matched. This broader workflow remains
red; its financial safeguards were not changed to make it pass.

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

The first hosted workflow at `e40b49a` then caught a separate release-check
configuration mistake: its global `NODE_ENV=test` also applied to the production
build step, generating an oversized development entry and omitting it from the
cache. A paired reproduction failed in test mode and passed in production mode.
The production build step now explicitly uses `NODE_ENV=production`; tests keep
their test environment. The 2 MiB cache limit and its assertion are unchanged.

Visual review also found styling tied to English accessible labels, which lost
the sign-in selection highlight in translated languages. Those selectors now use
stable classes. A regression parses every stylesheet and rejects value selectors
for translated `aria-label`, `title` or `placeholder` text. Relevant controls
passed 125 focused tests before the full 2,566-test rerun above.

No database schema, wallet settlement, worker, cash-activation gate or payment
configuration is changed. The broader scheduled-round workflow has previously
reported native ETB hold-fixture failures, as documented in the preceding shared
view release. Those guards have not been relaxed. Seven coming-soon catalogue
titles remain unavailable. Native-speaker, physical-device, Safari and load
acceptance remain outside this release's evidence.

## Reproduction and evidence

Run `pnpm --filter web exec vitest run --maxWorkers=2 --minWorkers=2`,
`NODE_ENV=production pnpm --filter web build`, `pnpm --filter api build`, and
`pnpm --filter web test:pwa`. Run the static audit with
`node apps/web/src/lib/i18n/tools/coverage.mjs --strict` and its tool tests with
`node --test apps/web/src/lib/i18n/tools/inventory.test.mjs`.

Use `scripts/review-interface-languages.mjs` and
`scripts/review-together-languages.mjs` against a built loopback preview, with
`PLAYWRIGHT_MODULE` pointing to an available local Playwright installation.
Both helpers block real financial mutations. Local logs and screenshots are
under `/private/tmp/salem-eight-language-final`,
`/private/tmp/salem-group-languages` and `/private/tmp/salem-i18n-*`.

## Live deployment

- API: source `4722a24ae3df7fee23f4c06fbf810bff2f58ec4f`, deployment
  `7c0df2ea-6738-4c8c-bd94-8af9a2d3f185`, successful.
- Web: source `f2d3940351d02299ff62775b8fa4d4f2185b4991`, deployment
  `3b5b6691-f4d6-4521-87c0-eb362d524167`, successful.

The web follow-up adds the signup selection highlight and changes no API code.
The preceding web release `07748c65-204c-4744-9e03-75d1e81149cf` served `4722a24`.

The target is Railway project **PlayQuibe Account Test**, environment
**account-test**. Railway confirms that the `account-web` service serves
`https://salem.bet`. The environment name is historical; this is the public site.
All four services are online with no pending changes or reported issues. The
worker and database deployments were not replaced.

Anonymous browser GETs to `https://salem.bet/health` and the current API at
`https://account-api-account-test.up.railway.app/health` returned HTTP 200.
The basic Python client was rejected by Cloudflare on the custom domain with
code 1010; the ordinary browser succeeded. No protection settings were changed.

Live HTML, manifest, service worker, app entry and all four language packs return
HTTP 200. The live worker includes all five required JavaScript files in its
precache. The final entry is 1,232,676 decoded bytes; every language pack is also below
2 MiB. Both manifest theme colors are `#050b09`.

The live anonymous matrix passed 32/32 checks: member, administrator and agent
sign-in plus signup, each in all eight languages at 390 pixels. It found no
JavaScript errors, unexpected redirects, layout overflow or unexpected
mutations. Credential fields stayed empty. Nine anonymous refresh attempts and
32 external requests were blocked; no provider or financial action ran. The
first slow harness was interrupted after 13 views and preserved; its ignored
network-idle wait was replaced by fonts/render readiness before the complete
32-view rerun. This is public-page evidence, not authenticated-account testing.

After the final signup-class patch, a further 16/16 live checks passed at
`f2d3940`: sign-in and signup in each language, actual email/phone field switching
and selected/unselected styles at 390 pixels. There were no failures, browser
errors or unexpected mutations; 15 anonymous refreshes and 16 external requests
were blocked. Final French and Arabic signup screenshots were visually checked.
The final app entry `/assets/index-C2mR11il.js` and unchanged language packs are
referenced in the live worker and return HTTP 200.

In a fresh anonymous browser context the `4722a24` live service worker activated and
actually cached the entry and all four language packs. All eight manifest icons
returned HTTP 200 with PNG content and were precached. The worker declares 41
entries representing 31 unique URLs: ten repeated icon/favicon URLs have
identical revisions and do not conflict. An initial harness counted Cloudflare's
external beacon script as an app entry; the corrected same-origin entry check
passed, with the initial report preserved. No OS installation or complete
offline financial flow is claimed.

Final live evidence is in `/private/tmp/salem-live-auth-methods-f2d3940/report.json`
and `/private/tmp/salem-live-cache-artifacts-f2d3940.json`. This review and the
gateway-document target clarification are evidence-only follow-ups; they do not
replace the explicitly pinned live source revisions above. No merge was made.
