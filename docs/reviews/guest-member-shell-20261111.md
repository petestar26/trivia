# Guest access in the member shell

## Review status

Local candidate based on release commit `e8c780cc03beaf6c7a4220e7762b3cc75d6bb386` on `codex/casino-catalogue-20261107`. No push, merge, deployment, database changes, provider-session creation, bets, or movement of funds were performed.

The unavailable local Claude commits `7e2d9de` and `ce7e47d` were not reviewed or overwritten. Compare this candidate with those changes before integrating either implementation.

## Experience

- `/`, `/explore`, and `/dashboard` open the real member Layout, Header, Sidebar, and mobile navigation. The old separate welcome screen is no longer the entry route.
- Home reuses the real member HomePage and existing artwork. Visitors can search the shipped game collection, inspect game introductions, and navigate every normal menu.
- Casino, sports, groups, messages, wallet, gifts, rewards, profile, support, challenges, and competitions have guest previews in the same shell. They contain product descriptions, not fabricated account records.
- New guest copy has static translations in all seven existing non-English locales. The translations are authored but not independently native-speaker reviewed.
- Protected actions open an accessible sign-in/create-account dialog. Escape, Close, Keep browsing, route changes, and browser history dismiss the prompt. Keyboard focus returns only on deliberate dismissal, not after navigation.
- After authentication, visitors return to a safe section landing page. No pending play, room admission, gift, favorite, wallet transaction, or provider launch is queued or replayed.

## Privacy and action boundaries

Member route components do not mount while anonymous. Existing server authentication remains unchanged. Guest views do not call protected catalogue, sports-wallet, activity, private-group, message, or notification endpoints. Existing account queries are explicitly user-gated; the ordinary authentication session probe remains intact.

Guest action-bearing URLs are replaced before rendering the shell. This prevents an old `/sports/open` or `/casino?game=...` entry from launching after authentication or browser Back. Paths are decoded and case-normalized; malformed, double-encoded, and unknown routes fail closed. Private IDs, invitation tokens, action queries, and fragments are discarded. Only known game-selection keys and the Home catalogue anchor are retained for read-only browsing.

Signed-in member routes, staff role gates, public proof verification, wallet and game APIs, and account permissions remain unchanged.

## Provider-data audit

There is no existing unauthenticated provider catalogue or sports fixture endpoint in this release:

- `/provider-test/*` and `/provider-demo/*` are authenticated and account/tester-gated.
- `/sportsbook/status` includes the user's wallet snapshot; `/sportsbook/activity` is personal history.
- `/sportsbook/launch` creates or ensures a provider player and returns a bearer launch URL. It is not a public fixture read.
- `/groups` includes caller-specific and private-group summaries, so removing authentication would expose information.

The candidate therefore offers honest category/feature previews, without pretending to show live provider games, fixtures, odds, balances, or room membership. A future public catalogue requires a separately reviewed, allowlisted read API and any necessary provider permissions. This candidate does not loosen existing APIs.

## Verification

Final command results are recorded in `evidence/guest-shell/verification.txt`.

Browser layout verification remains **blocked**, not passed. Chromium in this executor cannot create its required process socket (`Operation not permitted`), including the reviewed local-only invocation. The connected cloud browser cannot reach the private loopback server (`ERR_CONNECTION_REFUSED`). No screenshots were produced or claimed.

Before publication, run `evidence/guest-shell/visual-qa.cjs` in an environment where a browser and local preview share a network. Its APIs are synthetic and external requests are blocked. The separate preview ZIP includes a Node-only server bound to loopback, with every API stubbed and a restrictive content security policy; no build tooling is needed to open it. Check desktop, tablet, 390px and 320px views; long translations/Arabic RTL; navigation drawer; keyboard focus; Escape/Close/Back; and an authenticated control session. The script intentionally never signs into a real account or contacts a provider.

The existing full-web lint backlog is separate from this change: all remaining error-bearing files match the release baseline byte-for-byte. Changed files must pass focused lint. Backend/database integration checks were not required or run because no server, schema, or financial logic changed.
