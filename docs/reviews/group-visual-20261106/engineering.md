# Shared game presentation with original single-player artwork

This website-only change keeps the released shared-round API, worker, rules, immutable timeline, public-event filtering and wallet settlement engine. The game viewport comes before entry controls and rules. Desktop group chat sits beside the arena; mobile chat expands on demand. Chat scrolls its own message viewport, never the surrounding game page.

The final presentation uses the original single-player renderers and styles for every game. Pure visual components are shared by the original pages and the group adapters; importing them does not mount a single-player page, subscribe to its rounds, or invoke its betting actions. Group-specific controls remain outside the original artwork.

| Game             | Original presentation retained                                                           |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Group Spin       | Spin Win wood/brass roulette wheel and red/black palette, with equal participant pockets |
| Turbo Keno       | Original glass draw machine, burgundy/gold stage and 80-number board                     |
| Roulette Keno    | Original 72-pocket roulette disc, green stage and ticket board                           |
| Lucky Six        | Original 48-ball machine, colored ball rail and ticket board                             |
| Dice Duel        | Original ivory pip dice, emerald table and totals track; local player selector           |
| Number Challenge | Original illuminated number ball, orbit and perspective-grid stage                       |
| Derby            | Original complete race scene, authored horse/rider rigs, course and broadcast cameras    |
| Hounds           | Original oval course, greyhound models and trackside/chase/aerial cameras                |
| Football         | Original stadium, player models and scoreboard, with separate match-selection controls   |
| Blackjack        | Original seven-position felt table, card faces, backs and hand status                    |
| Sky Crash        | Original aircraft asset, runway/cloud world and flight HUD                               |
| Crash Point      | Original three-dimensional arrow artwork, blue/cyan graph and HUD                        |

Draws, scores, dice and hands use only events already released by the server. Decoration cannot select outcomes or trigger payouts. Crash remains a preset-target contest; the flight curve is decorative and does not invent a live cash-out multiplier. Football remains three prediction matches and Blackjack remains automated-hand predictions.

Football movement follows released scores; it is not a complete football simulation. The visual release does not change that scope or the preset-target Crash rules.

Spin continues from its displayed angle when the official winner becomes public. Its final 2.4-second turn is cosmetic; result publication and settlement are not delayed. A late viewer opening a completed round sees the final position immediately. Replay resets only that viewer's animation state. The stopping target is not available before disclosure.

Graphics choices persist locally. Automatic starts with balanced 3D and measures actual visible frame intervals, including after assets finish loading. It falls back only on sustained slow rendering. High, Balanced and Low all retain the original models and environments. Low reduces rendering resolution, shadows or frame rate; it does not substitute different artwork. A renderer failure or context loss still reaches a readable fallback. Reduced motion retains released scores and results without future information. No CPU-core or device-memory heuristic silently removes the richer scene.

The existing published receipt and result views remain available in expandable sections. Accepted-entry controls, request receipts, permission checks, accounting, API routes and database migrations are unchanged. Only `account-web` serving the verified `salem.bet` domain needs deployment. Keep the current API and workers running.

Validation covers focused interaction/privacy tests, wheel continuity for every supported participant count and winner, measured-quality adaptation, production build, gateway/install checks, static translation coverage and a synthetic browser matrix for twelve games and eight languages. The browser script also checks chat layout, result/replay access, the original scenes at low graphics quality, renderer loss and zero financial writes. Its API responses are fixtures, not live bets. Physical-device performance, Safari and native-speaker translation quality require separate acceptance.

Run: `pnpm --filter web exec vitest run src/components/together src/pages/play-together.test.tsx src/pages/play-together-selection.test.tsx src/pages/messages.test.tsx src/components/groups/group-round-activity.test.tsx src/components/football/football-scene.test.tsx src/lib/i18n`; `pnpm --filter web build`; `node apps/web/src/lib/i18n/tools/coverage.mjs --strict`. Run `scripts/review-shared-live-browser.mjs` against the loopback production preview with `TOGETHER_REVIEW_ORIGIN`, `TOGETHER_REVIEW_OUTPUT` and a locally installed `PLAYWRIGHT_MODULE`.

The capacity regression is `scripts/review-shared-game-capacity.mjs`, using the same loopback environment variables. It checks all twelve games with twenty confirmed entries and an unfunded spectator, in live and completed states. English widths are 320, 390, 768, 1024 and 1280 pixels; Amharic and Arabic also run at 390 pixels. Blackjack uses unique cards from a legal six-deck shoe with hand lengths 12, 12, 9, 9, 9, 6 and 5. Every intermediate prefix still requires a hit under the current rules. The fixture is synthetic and deliberately has no valid beacon proof.

The released layout reproduced cross-hand Blackjack card overlap in all seven viewport/language cases. The repair wraps cards inside each hand while preserving a readable rank/suit strip; narrow screens use two hands per row. Card order stays left-to-right inside the physical card row so Arabic interface direction cannot cover the exposed corner. Browser assertions cover card containment, cross-hand overlap, actual rank/suit hit-testing, all twenty participant rows, reachable final entries in scrollable stage lists, recorded cards, page overflow and absence of financial writes. The Play Together workflow runs this matrix as a separate browser job and saves its screenshots/report. It remains synthetic Chromium evidence, not physical-device or live financial acceptance.

## Original-artwork verification

Nine pure visual components were rendered against their pre-restoration single-player source from local commit `0247b8aae8e0b457040cde957159fea8ead6e06e`: Keno, Dice, Blackjack cards, Number Challenge, Spin, Lucky Six, Roulette Keno, Sky Crash and Crash Point. Matching inputs, fonts, viewport coordinates and reduced motion produced identical PNGs for all nine. The comparison first caught a real shared-wheel CSS collision, which was removed. Comparisons are rendered in separate documents because duplicate SVG gradient IDs and different rasterization positions make a side-by-side pixel comparison unreliable.

This is component artwork equivalence, not identical full-screen game semantics. Shared Spin must label equal participant pockets, Crash displays shared progress until its official result is released, and the page retains participants, chat and pooled rewards. The three 3D sports use their original scene implementations, courses, models and cameras; synthetic browser screenshots verify rendering at Balanced and Low quality, but are not pixel-equivalence or physical-device performance claims. Shared race positions bypass the original extra interpolation because the shared timeline already interpolates released checkpoints.

The original Blackjack card design keeps the long-hand safety repair: hands longer than three cards wrap into readable rows, while ordinary hands retain their original fan. The browser capacity matrix still verifies all 20 participants and legal 12-card Blackjack hands. Football match controls are checked not to cover the original stadium scoreboard.

The restored reduced-motion Football scene initially received a new but equivalent match object on every shared-clock tick. The engine treats a match update as a request to render immediately, so synthetic full-group checks timed out while scrolling to the final participant. The adapter now preserves match identity until a released score, selected match, round or final result changes. A regression test verifies that clock-only and equivalent poll updates do not call the engine's match-update method, while a new released score and final result still do. Low Football graphics also disables the additional shadow pass, consistent with the Low race renderers; it retains the original stadium, players and materials. The original renderer and authoritative timing remain intact.
