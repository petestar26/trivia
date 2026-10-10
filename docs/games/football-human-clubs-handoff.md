# Football human and club presentation

Base: `f8d3ce95924c88a716629f9ab2944a5c7ac08975` (PR #50).
Branch: `feat/football-human-club-presentation`.

Scope: frontend anatomical player surface/faces, lightweight seated crowd, Premier League display aliases. Existing match director, poses, server model, immutable club IDs/codes, outcomes, ledger and safety gates are unchanged. See [asset provenance and limits](virtual-football-visual-assets.md).

The two local diagnostic HTML pages used for close-up and full-match inspection are not shipped. Desktop Chrome inspected running, goal and halftime phases and a 390 × 844 viewport; no browser errors observed. Desktop fixture throughput was around 55–60 fps uncapped; the product's existing rendering cap remains about 30 fps. This does not establish physical iPhone performance or heat.

Typecheck, scoped lint, production build and 27 PWA tests passed. The first full run passed 1,431 tests with three unrelated group-detail timeouts while concurrent build/preview work ran; the quiet full-suite rerun passed all 1,434 tests across 104 files.

Validation commands:

- `pnpm --filter web exec vitest run --maxWorkers=2 --minWorkers=2`
- `pnpm --filter web typecheck`
- `pnpm --filter web exec eslint src/components/football src/lib/football/clubs.ts src/lib/football/clubs.test.ts src/pages/games/virtual-football.tsx src/pages/games/virtual-football.test.tsx`
- `pnpm --filter web build`
- `pnpm --filter web test:pwa`

Deployment is separate: web-only staging candidate, no migration/API/worker changes. Verify CI and the precise deployment SHA before claiming live. After staging, inspect fixtures, markets, results, expand/minimize and reduced motion, and ask for physical Safari validation without ticket confirmation. No production/payment/wagering activation.
