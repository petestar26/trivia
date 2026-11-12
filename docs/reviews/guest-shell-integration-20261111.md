# Guest shell integration review (R2 + public-interface work)

> Historical integration record for `0bf9531`/`b21c857`, not verification of the current hardening candidate. Independent review reproduced stale launch permission, non-atomic cross-tab consumption, and insufficient expiry privacy checks after this record was written. See `guest-session-hardening-20261111.md` for the corrections and current validation. The old browser JSON is retained as `shell-qa-results.integration-0bf9531.json`.

Local branch `claude/salem-guest-shell-integration`. Application commit under
test: **`0bf9531e78f6e7e8575f6414bde3284d06acc4e5`**. Nothing was pushed,
merged or deployed. No real account, bet, payment, provider session or
production data was used. Every API response in the browser checks is a
synthetic fixture; all other origins were blocked.

## Provenance

| Item                          | Commit                                         | Notes                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production base               | `e8c780cc`                                     | "Merge PR #70: verified football release and ETB tests". The PR #70 record lists it as merged with the web deployment (`f9bb6c24`) and API (`2b45b1b6`) reported successful. The live site was **not** reachable from this environment (network policy returns 403), so the deployed bundle itself was not compared. |
| Guest-shell candidate R2      | `2362dac4`                                     | From `Salem-Bet-Guest-Review-R2-2362dac4.zip`; authored by Codex; parent `18205312` (R1), then `e8c780cc`. Kept unchanged as branch `review/salem-guest-shell-r2`. R1 was not used on its own.                                                                                                                       |
| Earlier public-interface work | `7e2d9de` (app), `ce7e47d` (evidence)          | Branch `claude/salem-public-home-discover-polish`, based on `1436fba` (14 commits behind production). Kept unchanged.                                                                                                                                                                                                |
| This integration              | `2362dac4` + `0bf9531` (app) + evidence commit | Client-side only.                                                                                                                                                                                                                                                                                                    |

## What was combined

**Kept from R2 (unchanged in substance):** visitors open the normal member
`Layout`, header, sidebar and mobile navigation; Home, Casino, Sports, Play
Together, Groups, Messages, Wallet, Rewards and the other sections render
data-free guest previews in that shell; protected actions open one sign-in /
create-account prompt; confirmed guests' action URLs are canonicalised before
the shell renders; an unresolved session holds action URLs instead of
discarding them; staff routes are gated inside `WorkspaceGate`; 131 translated
strings.

**Carried over from `7e2d9de`:** `safeReturnTo` never returns to a launching
URL (`/sports/open` becomes `/sports`, `?game=` is dropped from `/casino`,
matching the router's case-insensitive, decoded matching); the login
return-path tests; the API anonymous-access sweep.

**Not carried over:** the standalone Home/Discover redesign and its
`/explore?pick=` preview. The brief replaces the separate welcome page with
the member shell, and R2 routes `/` and `/explore` to `/dashboard`.
`pages/welcome.tsx` is now unrouted; only its tests import it.

## Review findings

| #   | Severity                                | Finding in R2                                                                                                                                                                                                                                     | Resolution in `0bf9531`                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High (against the brief)                | A restored member's `/sports/open` or `/casino?game=<id>` launched on arrival. A pasted or bookmarked link, reload, Back/Forward or session restoration could therefore create a sportsbook session or start a provider game with no fresh click. | **Fixed.** These pages launch on arrival only with a one-time intent written by the in-app click that opened them: bound to member and target, single use, valid 60 s, shared with the sportsbook's new tab via `localStorage`, and removed from the address immediately. Any other arrival shows the page with a "Play" or "Browse sports" button. |
| 2   | Medium                                  | Group invitation links were reduced to `/groups` for guests, so an invited visitor lost the invitation by signing in.                                                                                                                             | **Fixed.** The canonical invite path survives (query, fragment and extra segments are dropped). Accepting still needs a click; the browser run shows no write after sign-in.                                                                                                                                                                        |
| 3   | Medium (accessibility)                  | "Skip to content" was broken for guests: its `#main-content` anchor counted as an unknown fragment and was stripped by a redirect, dropping focus on the page.                                                                                    | **Fixed.** That one anchor is kept.                                                                                                                                                                                                                                                                                                                 |
| 4   | Low (UX)                                | During the session probe, a returning member saw the guest "Sign in / Create account" header and sidebar card (about 2 s on a slow connection).                                                                                                   | **Fixed.** Neither guest nor member controls show until the probe settles. A prompt opened in that window closes once a member is confirmed. R2's tests expecting the guest link during the probe were updated.                                                                                                                                     |
| 5   | Low (accessibility, also in production) | Closing the mobile navigation drawer did not return keyboard focus to the menu button (a Radix dialog without `Dialog.Trigger`).                                                                                                                  | **Fixed.**                                                                                                                                                                                                                                                                                                                                          |
| 6   | Low                                     | A Play Together game chosen as a guest was lost at sign-in.                                                                                                                                                                                       | **Fixed.** A known game key survives as a read-only selection.                                                                                                                                                                                                                                                                                      |
| 7   | Defence in depth                        | `safeReturnTo` still accepted launching URLs from any other source of `state.from`.                                                                                                                                                               | **Fixed** by the carried-over `safeReturnTo`.                                                                                                                                                                                                                                                                                                       |

Noted, not changed:

- `pages/welcome.tsx`, `welcome.css` and parts of `welcome.test.tsx` are dead code.
- Guest prompt reasons are translated twice (by the caller and by the dialog).
  This is harmless: the second lookup misses and returns the text unchanged.
- If a session expires mid-visit and refresh fails, the member shell stays up
  with "could not be loaded" errors rather than switching to the guest view.
  No new private data is fetched. Changing this means changing `AuthProvider`.
- Dismissing the install reminder removes it and drops focus to the page.
  This is existing behaviour.
- The staff sign-in and "access required" pages still use the older light
  theme.

## Public catalogue and fixtures

There is no approved, sanitised, read-only public source to show the real
casino catalogue or live sports fixtures:

- `/provider-test/*` and `/provider-demo/*` (status, catalogue, wallet, launch)
  require `authenticate`, and the catalogue is per-account access-gated.
- `/sportsbook/status` carries the member's wallet snapshot. `/sportsbook/activity`
  is personal history. `/sportsbook/launch` creates a provider player and
  returns a bearer launch URL. None of these is a fixture feed.
- No public fixtures, odds or catalogue endpoint exists. The anonymous API
  sweep confirms every non-allowlisted route returns 401.

Guests therefore see category and feature previews ("Illustration · Not a live
match", "not a live list of available games") rather than invented titles,
odds or availability. No private endpoint was exposed. Showing real data
needs a separately reviewed public read API (see next steps).

## Evidence

All results below are for application commit `0bf9531` (the browser harness
verifies the application inputs equal it before running).

| Check                                                                                                                                    | Result                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Vitest, full suite                                                                                                                   | 195 files, **2,939 passed** (R2 alone: 194 files, 2,865)                                                                                          |
| Web `tsc --noEmit` / API `tsc --noEmit`                                                                                                  | Passed / passed                                                                                                                                   |
| API `security/anonymous-access.test.ts` (offline, synthetic config; every non-allowlisted route sent an anonymous, schema-valid request) | 19/19 passed: all return 401 with no data                                                                                                         |
| Gateway (`server.test.mjs`), PWA + recovery, isolated preview server (Node test runner)                                                  | 11/11, 29/29, 1/1 passed                                                                                                                          |
| ESLint, changed files                                                                                                                    | No new findings. The 2 errors and 3 warnings reported are identical (shifted lines) at `2362dac4`.                                                |
| Prettier, changed files                                                                                                                  | Clean. Exception: the three files ported unchanged from `7e2d9de` were not Prettier-clean in their original tree either, so they were left as-is. |
| `git diff --check`                                                                                                                       | Clean                                                                                                                                             |
| i18n coverage `--strict`                                                                                                                 | 3,112 / 3,112 reachable keys covered, 0 missing, 0 validation issues                                                                              |
| Production build (`NODE_ENV=production`, clean `dist`)                                                                                   | Exit 0; 1,952 modules; the existing chunk-size and 2.38 MB engine precache warnings                                                               |
| Browser harness `evidence/guest-shell/shell-qa.cjs`                                                                                      | **14/14 checks passed** (`shell-qa-results.json`)                                                                                                 |

Browser harness detail (Playwright Chromium, simulated; synthetic fixtures):

- **Guest matrix:** 52 guest pages; EN at 1440/768/390/320 and AR at
  1440/390/320, covering Home, Casino, Sports, Play Together, Wallet, Groups,
  Messages and Rewards. No horizontal overflow, correct `dir`, header sign-in
  visible.
- **Prompts:** 147 sign-in prompts opened from the keyboard (EN 1440, EN 320,
  AR 390). Each offers Sign in and Create account, takes focus, closes on
  Escape and returns focus to its control.
- **Anonymous network:** across all guest checks the only API requests were
  `GET /auth/me` and `POST /auth/refresh`. No external origin was contacted
  and there were no page errors.
- **Member matrix:** 34 signed-in pages at the same widths. Nothing launched
  and nothing was written on arrival, apart from the existing member-layout
  `POST /member-rewards/activity`.
- **Drawer:** guest and member, EN and AR, 390 and 320. Opens from the right
  in Arabic. Escape returns focus to the menu button. Guests make no request.
- **Keyboard:** the first Tab stop is "Skip to content", which works for
  guests (the next Tab lands inside `main`). All 14 recorded stops show a
  focus indicator.
- **Sign-in from a prompt** on Casino, Sports, Wallet and Play Together
  (`?game=dice`) returns to that section. No launch or write follows sign-in
  or a later Back.
- **Guest deep links:** `/sports/open` (with and without an `?intent=` nonce),
  `/casino?game=`, `/CASINO?game=`, `/games/dice`, an invite with a query,
  `/wallet/withdraw`, `/messages/<id>` and `/games/provider-demos`. Each is
  canonicalised for the guest, signing in lands on the safe page, and nothing
  launches or writes after sign-in or Back. The member invite page then shows
  "Invalid or unrecognized invite link" only because the synthetic fixture
  has no invite preview. Nothing was accepted.
- **Member deep links:** a bare `/sports/open`, or one with a forged or used
  intent, shows "Browse sports" and waits. `/casino?game=` selects the game
  and shows Play. Reload does not launch. The clicks are positive controls:
  each produced exactly one launch request.
- **Sportsbook new tab:** clicking "Browse sports" opens a tab at
  `/sports/open?intent=<uuid>`, which launches once and heads for the
  (blocked) provider. Reopening the same address launches nothing.
- **Casino tile on Home:** one launch. The address is left as `/casino`, and
  Back, Forward and reload do not relaunch.
- **Staff routes:** for guests, `/admin`, `/ADMIN`, `/%61dmin`, `/Admin/`,
  `/admin/accounts`, `/admin//accounts`, `/agent` and `/AGENT/wallet` go to
  the staff sign-in page with no request. A non-staff member sees "access
  required" after only `GET /workspaces/access`, and `/wallet/operations`
  shows "Staff access required".
- **Logout and account switching:** after logout, member A's name and balance
  never reappear, including on Back/Forward, and no private request is made.
  Member B never sees member A's data on Wallet, Home, Sports or Rewards
  (a DOM observer recorded every appearance).
- **Slow probe (2 s):** a returning member and a guest both see a neutral
  header. A `/sports/open` link holds on "Loading…" and does not launch.
- **Session restore:** with an expired access token and a valid refresh
  token, `/casino?game=`, `/sports/open` and an invite each restore through
  one refresh. The page stays (casino shows the selection) and nothing
  launches.
- **Session expiry:** the next read gets 401 and the refresh fails. No launch
  or write follows, and the cached balance is not shown on the new page.

Screenshots, contact sheets and the results JSON are delivered separately
(`salem-guest-shell-integration-0bf9531.zip`). They are not committed.

## Not verified

- Physical phones and tablets, iOS Safari, Firefox and screen readers. All
  browser checks are simulated in Playwright Chromium.
- The live production site (not reachable from this environment).
- A real API server and database; the database-backed API suites.
- Native-speaker review of translations: R2's 131 strings and 2 new strings
  (`catalogues/launch-intent.ts`).

## Recommended next steps

1. Native-speaker review of the new copy, then a real-device pass: iOS
   Safari, Android Chrome, 320–390 px, VoiceOver/TalkBack. Focus on the
   prompt, the drawer and the sportsbook new tab.
2. Decide whether to build public read APIs: an allowlisted, cached
   `GET /public/casino/catalogue` (title, provider, category, public artwork
   only; no access or wallet state) and, only if the sportsbook provider's
   terms allow it, a fixtures feed. Both need their own security review.
3. Remove `pages/welcome.tsx` and its unrouted tests in a follow-up.
4. Consider switching to the guest view when refresh definitively fails
   (an `AuthProvider` change, outside this client-only scope).
5. Run the database-backed API suites and a staging smoke test before any
   release.

## Re-run

```bash
NODE_ENV=production pnpm --filter web build
QA_OUTPUT="$(mktemp -d)" node evidence/guest-shell/shell-qa.cjs
```

The harness refuses to run unless the application inputs equal the pinned
commit. With `QA_ALLOW_UNCOMMITTED=1` it labels its output as an uncommitted
working tree instead.
