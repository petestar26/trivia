# Shared game visual production

This website-only change keeps the released shared-round API, worker, rules, immutable timeline, public-event filtering and wallet settlement engine. The game viewport comes before entry controls and rules. Desktop group chat sits beside the arena; mobile chat expands on demand. Chat scrolls its own message viewport, never the surrounding game page.

| Game | Presentation |
| --- | --- |
| Group Spin | Brass wheel, lit rim, numbered participant roster and continuous stopping motion |
| Turbo Keno | Glass draw globe, illuminated number board and released-ball rail |
| Roulette Keno | Segmented 72-pocket mechanical disc, orbital hub and separate ticket board |
| Lucky Six | Air-mix lottery cabinet, outlet, six-ball display and 48-number ticket |
| Dice Duel | Modeled six-sided dice, pip faces, burgundy tray and per-player totals |
| Number Challenge | Sealed mechanical drums, scanning lights and released target distances |
| Derby | Existing authored horse/rider rigs, mown course, rails, stands, gates and broadcast cameras |
| Hounds | Existing greyhound models, night track, floodlights and finish structure |
| Football | Existing stadium scene with three selectable match scoreboards |
| Blackjack | Composed seven-position dealing table, authored card faces and visible hand totals |
| Sky Crash | Existing local aircraft artwork, runway/cloud scene and locked-target instruments |
| Crash Point | Authored rocket, mission grid, trail and locked-target instruments |

Draws, scores, dice and hands use only events already released by the server. Decoration cannot select outcomes or trigger payouts. Crash remains a preset-target contest; the flight curve is decorative and does not invent a live cash-out multiplier. Football remains three prediction matches and Blackjack remains automated-hand predictions.

Spin continues from its displayed angle when the official winner becomes public. Its final 2.4-second turn is cosmetic; result publication and settlement are not delayed. A late viewer opening a completed round sees the final position immediately. Replay resets only that viewer's animation state. The stopping target is not available before disclosure.

Graphics choices persist locally. Automatic starts with balanced 3D and measures actual visible frame intervals, including after assets finish loading. It falls back only on sustained slow rendering. High and Balanced retain the richer scenes; Low uses authored vector race/pitch broadcasts. Context loss also reaches a readable fallback. Reduced motion retains released scores and results without future information. No CPU-core or device-memory heuristic silently removes the richer scene.

The existing published receipt and result views remain available in expandable sections. Accepted-entry controls, request receipts, permission checks, accounting, API routes and database migrations are unchanged. Only `account-web` serving the verified `salem.bet` domain needs deployment. Keep the current API and workers running.

Validation covers focused interaction/privacy tests, wheel continuity for every supported participant count and winner, measured-quality adaptation, production build, gateway/install checks, static translation coverage and a synthetic browser matrix for twelve games and eight languages. The browser script also checks chat layout, result/replay access, light graphics, renderer loss and zero financial writes. Its API responses are fixtures, not live bets. Physical-device performance, Safari and native-speaker translation quality require separate acceptance.

Run: `pnpm --filter web exec vitest run src/components/together src/pages/play-together.test.tsx src/pages/play-together-selection.test.tsx src/pages/messages.test.tsx src/components/groups/group-round-activity.test.tsx src/components/football/football-scene.test.tsx src/lib/i18n`; `pnpm --filter web build`; `node apps/web/src/lib/i18n/tools/coverage.mjs --strict`. Run `scripts/review-shared-live-browser.mjs` against the loopback production preview with `TOGETHER_REVIEW_ORIGIN`, `TOGETHER_REVIEW_OUTPUT` and a locally installed `PLAYWRIGHT_MODULE`.
