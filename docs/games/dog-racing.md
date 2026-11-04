# Dog Racing — original practice release

Reference: https://mohiogaming.com/games/racing/dog-racing, reviewed 2026-11-04. MOHIO advertises historical recorded race video, six/eight-runner fields, and fixed-odds markets. Salem's version is original real-time geometry and animation. No MOHIO footage, models, branding, odds, certification or software is reproduced. Open asset searches found no verified downloadable realistic animated greyhound suitable for this release; no third-party animal asset was imported. The locally bundled Three.js renderer is MIT licensed.

## Rules and storage

The existing `neon_hounds_3d` catalog key now displays **Dog Racing**. `/games/dog-racing` is authenticated and requires `DOG_RACING_PRACTICE_ENABLED=true` on the API. The same flag adds the DOG_RACING task to the practice worker. Financial admission for this key is unconditionally paused, independently of catalog flags.

Six dogs race every three minutes; eight every four. Entries close before a 45-second race, followed by 15 seconds of results. One immutable selection per member per race, 10–500 whole practice ETB. Winner, ordered first two/three, unordered first two, top three, lower/upper half and odd/even use the existing published uniform 90% racing math. Gross returns include stake, rounded down. No purchased, transferable or redeemable stakes, cash-out, bonus, jackpot or autoplay.

Dog Racing and Derby deliberately share the existing `derby_accounts` **racing practice balance** (initial 1,000). This is disclosed in the rules. No new cash balance, financial ledger entry, schema migration or database privilege is needed. Races, tickets, histories and commitments are isolated using the fixed server-side `hounds-` prefix; legacy Derby rows are all non-`hounds-` IDs. Both admission and every round/settlement/history query enforce the namespace. The browser cannot choose that namespace or supply odds.

Dog Racing commitments use `dog-racing-uniform90-v1`; existing Derby commitments remain unchanged. Rejection-sampled Fisher–Yates determines the private finish order. Only published current progress is used to animate; no future finish is sent before the result. Snapshot recovery and the worker settle each receipt once using existing row locks and database balance/receipt guards. A reload cannot double-debit an exact retry. Failed or stale requests disable entry; unresolved requests retain their receipt payload for an exact retry.

## Visuals and accessibility

Original smooth lofted greyhounds have articulated legs, a running cycle tied to actual published travel, narrow muzzles, deep chests, tucked waists, tails, coat colours and numbered racing jackets. The sand oval includes rails, traps, grandstand seats, roof, floodlights and finish markings. Three camera views, reduced motion and a numbered SVG track fallback remain available. A buffered position interpolator never extrapolates beyond the server's published locations. The scenery is merged by material, the scene lazy loads, DPR is capped at 1.5 on phones/2 on desktop and animation targets about 30 fps. Scene resources are disposed on unmount/context loss.

These are original stylized real-time models, not scanned animals or prerecorded real-race footage. Generated catalog artwork is decorative cover art; it is not a screenshot of gameplay. `dog-racing.webp` was generated with the built-in image tool from a prompt for three greyhounds in numbered jackets on a sunlit sand course, without vendor branding or text, then resized/encoded to WebP.

## Validation and release

PostgreSQL-compatible PGlite tests run the actual service and existing SQL guards, including a full 45-second settlement, exact retries, immutable picks, hidden outcomes, isolated histories/admission, suspended users and late entries. They serialize connections and do not establish native concurrent lock scheduling; the existing Derby native suite remains the concurrency coverage for the unchanged lock/receipt path. UI tests cover ordered selections, review/confirmation, stale state, result/history, field changes and expanded view.

Browser QA checks phone/desktop control layout, numbered selections, camera controls and fallback. The managed browser reports WebGL disabled; software vector inspection of the original mesh is separate evidence and does not validate GPU lighting, physical-phone speed or heat. Physical phone GPU visual acceptance is still required. No real-money bets, deposits or withdrawals are part of validation.

Deploy API/worker with the practice-only flag, then web. Existing migrator/predeploy commands stay unchanged. Roll back by disabling the Dog Racing flag and restoring the previous pinned commit; retain all existing race/ticket records.
