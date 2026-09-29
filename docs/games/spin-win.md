# Spin Win: practice implementation and release rules

## Scope

Original numbered-wheel game inspired by the public MOHIO product description.
The current web route `/games/spin-win` is practice only, with 1,000 temporary
credits. It does not call a play endpoint, spend Coins, or persist results.
The catalog remains COMING_SOON for Coin wagering. The Casino card links to
practice mode explicitly. No migration activates Spin Win.

## Rules v1

The supported server rules identifier is `single-zero-standard-v1`.
Every number 0–36 has probability 1/37. The displayed wheel uses the standard
single-zero arrangement. All bets on a round share the same result.

| Market | Covered numbers | Gross return including stake |
| --- | --- | --- |
| Exact number | One number, including zero | 36 × stake |
| Sector A–F | 1–6, 7–12, 13–18, 19–24, 25–30, 31–36 | 6 × stake |
| Dozen | 1–12, 13–24, 25–36 | 3 × stake |
| Red/black, odd/even, low/high | 18 nonzero numbers | 2 × stake |

Zero loses every group bet. There is no half-stake return, jackpot deduction,
or bonus payout. The gross theoretical return for each market is 36/37
(about 97.30%), derived from coverage and payout, not an empirical promise.
Sector returns are our explicit design choice following six-number coverage;
they are not claimed to reproduce MOHIO's proprietary payout configuration.

Practice chips: 1, 5, 10, 25, 100; aggregate practice round limit: 500.
Multiple markets may win; their gross payouts are added. Rebet restores the
previous ticket without submitting a spin. Inputs lock during animation.

## Implementation

- Shared rules enumerate valid markets and validate positive integer stakes,
  duplicate markets, ticket length and aggregate bounds.
- API results use Node crypto.randomInt(37). Bet selections are included in
  the canonical replay fingerprint, normalized by market ID. The declared
  stake must equal the ticket total. Existing transactional ledger settlement
  remains responsible for provenance, wallet changes and stored responses.
- No weighted-multiplier engine serves Spin Win: `game-play.ts` has one `SPIN_WIN` case,
  which runs the numbered-wheel engine above and rejects any rules row whose `rulesId`
  is not `single-zero-standard-v1`. The retired Lucky Spin generator is unrelated and
  untouched. The seeded catalog row still carries its original description and a
  legacy weighted `configuration`; it has no rules row and stays `COMING_SOON`.
- Browser practice randomness uses Web Crypto with rejection sampling; it is
  never used for financial settlement. The wheel lands on the selected result.
- Colours have textual labels; controls support keyboard focus; reduced-motion
  settings remove the rotation transition.

## Before Coin activation

1. Exercise actual PostgreSQL settlement, rollback, concurrent replay,
   overspend, mixed funding and restriction preservation on a throwaway DB.
2. Publish immutable rules and jurisdiction approvals through a forward
   migration; validate supported bet limits and aggregate payout limits.
3. Connect the screen to durable server requests and stored responses. Display
   the server rules and authoritative balance; remove local practice accounting
   only for an explicitly separate Coin play mode.
4. Validate desktop/mobile rendering in a browser and complete release review.
5. Replace the catalog description and legacy `configuration` in the same forward migration,
   and give an unsupported rules row a controlled 4xx instead of the current generic error.
6. Decide playthrough treatment. Restricted-Coin progress counts the whole round stake when
   `spin_win` is in a country policy's `qualifyingGames` and the stake is within
   `maxQualifyingStake`, so an offsetting ticket (for example red plus black) clears a
   requirement at the same expected cost (about 2.7%) with far less variance. Keep
   `spin_win` out of `qualifyingGames` until that is accepted or limited.

Shared scheduled rounds, countdowns, jackpots, mirrors, twins, neighbours and
finals are not implemented. They require separate rules and, for shared rounds
or jackpots, additional settlement and funding design.

## Research sources (checked 2026-09-29)

- https://mohiogaming.com/games/lotteries/spin-win — numbered wheel, sectors,
  betting markets, rebet; does not provide complete jackpot or payout rules.
- https://www.gra.gov.sg/api/media/a93f5105-4c1c-4510-9639-9b26467c5354/mbs-electronic-roulette-game-rules-version-4_gra.pdf
  — published reference for standard roulette profit odds and zero behaviour.
  Used as a game-mechanics reference, not a claim of jurisdictional approval.

## Coin screen (implemented, activation still pending)

`/games/spin-win/play` is a separate Coin screen. It requires an active AVAILABLE
COINS catalog entry and current rules before accepting new tickets. It uses
`useDurablePlay` with explicit pending-round recovery, persists the exact top-level
`bets` and `betAmount` request before sending, locks unresolved tickets, and displays
only server results and the stored settled balance. A paused catalog still permits
confirmation of an already-stored request. The API route now forwards the bounded
bet list into the existing transactional play service.

Local mocked-transport tests cover lost responses, exact-key retry, reload recovery,
unavailable games and blocked storage. They do not replace PostgreSQL settlement
verification. No runtime availability or rules migration has been applied.

## Verification status (2026-09-29)

Eight real-database cases in `games.test.ts` under `Spin Win Coin settlement` cover
settlement and exact replay, reordered-ticket replay and edited-ticket refusal (409),
concurrent duplicates, invalid-ticket rejection, a mid-transaction rollback (a
temporary trigger fails the session insert after the debit; wallet, operations,
lots and sessions are unchanged, and a retry with the same key settles once),
overspend (400 `Insufficient tracked Coins`), mixed restricted/purchased funding,
and replay after a rules change. They passed against a throwaway PostgreSQL 16
database (20 consecutive runs, covering both winning and losing `red` rounds).
They use real purchase fixtures and restore the prior Spin Win catalog state.

The Coin screen and practice screen were checked in Chromium at 1280×800 and
390×844, with and without `prefers-reduced-motion`. Available, pending-round
recovery (lost response, reload, exact-key confirm) and paused-catalog states used
browser-side API mocks; the real catalog state (`COMING_SOON`) was checked against
a local API. Coin wagering is still disabled: no activation migration exists.

Run in a configured local throwaway ledger-test database (name matching
`playqube_*_throwaway`, loopback host only) with disposable
`SECURITY_TOTP_ENCRYPTION_KEY` and `LEDGER_APPROVAL_SIGNING_KEY` values
(`openssl rand -hex 32` each), `TEST_LEDGER_DB_NAME` set to that database name and
`NODE_ENV=test`, after `pnpm build:packages` and `pnpm --filter @socialplay/database
db:migrate:deploy`:

```sh
pnpm --filter api test -- src/games/games.test.ts -t 'Spin Win Coin settlement'
```

Do not point this test at a persistent environment: it temporarily enables the
Spin Win catalog entry and writes append-only fixture history.
