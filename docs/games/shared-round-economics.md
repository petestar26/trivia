# Shared rounds and game economics — implementation proposal

Status: **economic kernel and opt-in durable practice rounds implemented;
not connected to live Coin settlement**.
Base: master `ed03d13570df66629dd794885eb41841b918f15a`.
Policy: `scheduled-economics-v1`.

## Product contract

Public house games run scheduled rounds; private/group/challenge events have
their own invitation, entry and play windows. A player confirms every entry.
There is no automatic recurring wager. All accepted tickets for a public round
use its single persisted result. Private scored games require a separately
pinned scoring adapter (a shared dice roll alone would tie every entrant).

House wagers target **90% theoretical gross return, 10% expected gross edge**.
Funded player contests take **15% of entrant contributions**, once, on successful
completion; the remaining 85% goes to winners. No additional house edge applies
to that contest pool. Sponsor funding is paid in full, with no additional fee.
Void/cancelled events return every contribution and charge zero fees. A completed
tie shares the net prize; historical challenges keep their historical tie-refund
policy. Fee terms must be visible before entering and pinned to the event.

This provides no guarantee of net business profit. Payment fees, chargebacks,
taxes, fraud, hosting and promotional costs remain. Game Points fees are not cash
or withdrawable Coin revenue. Customer balances and pending withdrawals are not
operator risk capital.

## All 13 catalog games

These are explicit proposed mechanics for previously empty catalog entries,
not claims about existing production engines or MOHIO's proprietary rules.
Apart from Spin Win, the new adapter IDs contain `draft` and have no database
rules rows or activation migrations. None can serve an existing play endpoint.

| Game | Proposed public round and bet | Gross winning return | Math status |
| --- | --- | --- | --- |
| Spin Win | Uniform pocket 0–36; current supported markets | Current v2 paytable; 40-unit lines | Existing exact 90% math reused |
| Dice | Two uniform dice; sum at least 7 | 54 per 35 staked (21/36 wins) | New proposed version; historical rules unchanged |
| Number Challenge | Guess one uniform number 1–100; exact match only | 90 × stake | New proposed version; replaces no historical proximity payout |
| Thunder Derby 3D | Pick winner among 6 equally likely runners | 5.4 × stake, 5-unit steps | Proposed winner-only race model |
| Neon Hounds 3D | Pick winner among 6 equally likely runners | 5.4 × stake, 5-unit steps | Proposed winner-only race model |
| Turbo Circuit 3D | Pick winner among 6 equally likely cars | 5.4 × stake, 5-unit steps | Proposed winner-only race model |
| Jungle Dash 3D | Pick winner among 6 equally likely racers | 5.4 × stake, 5-unit steps | Proposed winner-only race model |
| Strait Rush | Pick winner among 6 equally likely racers | 5.4 × stake, 5-unit steps | Proposed winner-only race model |
| Starfall Nebula | Pick one of 12 equally likely star sectors | 10.8 × stake, 5-unit steps | Proposed draw; artwork/rules need approval |
| Crystal Trail | Pick a complete 3-step binary path, 8 equal possibilities | 7.2 × stake, 5-unit steps | Proposed draw; no mid-round cash-out |
| Heat Vault | Pick one of 20 equally likely vaults | 18 × stake | Proposed draw; no mid-round cash-out |
| Turbo Keno | Draw 20 distinct numbers from 80; individual number lines | 3.6 × each winning line, 5-unit steps | Proposed simple Keno; no match-count tiers/jackpot |
| Trivia | Timed questions; one answer per player/question | Reward from a funded promotional budget | BONUS, no stake, no 90% RTP claim |

Race graphics must depict the independently chosen result; runners are equally
likely in these proposals. Nonuniform odds, place bets, exotic markets, jackpots,
cash-out and bonus features require their own probability model and new rules.
The kernel rejects unknown game/rules pairs. Shared infrastructure does not make
unimplemented games playable or approved.

## Exact house risk calculation

All amounts are integer units (`bigint`, checked int64 boundaries). A model uses
elementary outcomes and exact integer probability weights. It proves each
ticket's expected payout equals 90% of stake; simulations are not that proof.
Dice has 36 elementary outcomes, not 11 equally probable sums. Number Challenge
is exact-only in this proposal, so boundary guesses have the same RTP.

For one-result games, let S be all escrowed stakes and P[j] the sum of all gross
payouts if outcome j wins. Reserve R = max(0, max(P[j]) - S). For the proposed
Keno, any 20 distinct numbers can win together, so the maximum payout is the sum
of the 20 largest accumulated per-number liabilities. Considering only the
largest number would dangerously under-reserve a Keno round.

Admission requires all of:

- Complete, valid payout model matching the round's pinned rules.
- Ticket and cumulative user-per-round stake within published limits.
- Maximum round gross payout and net loss within configured limits.
- Sum of other active-round loss reserves plus R within actual backed capital.
- Stakes remain escrowed, so stakes plus R cover every possible gross payout.

Admission must reload and update the treasury and round under database locks in
one transaction with the stake hold and immutable ticket. A stale quote is not
permission to debit. Risk must aggregate across users and simultaneous games.
New tickets may be refused before acceptance; accepted tickets cannot be trimmed,
repriced or cancelled because the result is expensive. The RNG receives only
game/rules IDs, never the book, prior results, bankroll or player identity.

The API must build models and payout vectors from the pinned server-side rules,
never accept them from a client. Passing the 90% equation alone does not establish
that a vector belongs to the selected market. Persist each accepted selection,
rules version and canonical quote so subsequent code cannot reinterpret it.

Examples (illustrative, not production capital settings):

- 40 on Spin number 7: worst gross payout 1,332, net loss reserve 1,292.
- 40 on number 7 plus 40 on red: the same winning 7 pays 1,406; reserve 1,326.
- 40 on every Spin number: stake 1,480, gross payout 1,332, reserve zero.
- Keno: 5 on each of 20 numbers: stake 100, up to 20 × 18 = 360 payout, reserve 260.

Treasury funding needs external settlement evidence and an owner-run accounting
entry, not a configurable arbitrary number or a credit to a player's wallet.
Actual fiat backing, country conversion rates and withdrawal obligations must
be reconciled before configuring any Coin risk limits. Stop accepting new bets
if the reserve ledger or its backing cannot be verified; honor existing tickets.

## Contest fee plan

`planContestSettlement` consumes escrow receipts supplied by a trusted adapter.
It is a pure calculation and cannot establish that those receipts really exist.
New paid entries use multiples of 20 units so 15% is exact in whole units.
Example: two 100-Coin entries produce 30 fees and 170 prizes. A 73-Coin sponsor
addition produces 243 prizes and still only 30 fees.

At least two distinct funded entrants and a nonempty, unique set of eligible
winners are required for completed paid events. If there is no valid winner,
void and refund instead of retaining the pot. Tie remainders are assigned in
canonical user-ID order; every unit belongs to either the prize or the declared
fee. Refunds reference original receipts and never charge a cancellation fee.

The live adapter must prove funding, eligibility, paid receipt ownership and
winner scoring; snapshot this exact policy; and commit event completion,
immutable fee revenue entry and wallet/lot payouts atomically. An idempotent
retry reads the stored result. No fee is taken twice and no prize can exceed the
funded pot. Sponsors and entrants remain distinguishable in cancellation/refund
records. Withdrawal restrictions, source lineage, obligations and expiry must
survive all holds, payouts and refunds. Restricted Coin fees must not silently
become withdrawable operator funds.

Existing Game Point contests remain unchanged. Coin contest prizes currently
fail closed in `competition-service.ts`; this proposal does not remove that gate.
Historical entries lack the new fee disclosure/escrow contract and must never
be charged retroactively. Free sponsor-only competitions need a separate funded
reward adapter; the paid-contest planner intentionally does not settle them.

## Timing and restart behavior

Spin Win's initial public cadence is 45 seconds entry, 10 seconds reveal, 5
seconds result. Every round derives its sequence from a fixed UTC anchor. Other
games can use longer display/answer intervals while sharing lifecycle code.
Private events use their agreed server-side start rather than the public anchor.

`scheduledRound` is a deterministic clock calculation. The separate opt-in
practice worker now persists rounds/results; see
[scheduled-practice-rounds.md](./scheduled-practice-rounds.md) for its limits.
`assertRoundOpen` rejects at the precise close timestamp even if a stalled worker
left the persisted status OPEN. The future admission transaction uses fresh
database time after acquiring locks, never a client timestamp or request-arrival
timestamp. The UI countdown is advisory; late requests are refused without debit.

Required durable lifecycle:

1. Create one uniquely keyed round for schedule/sequence, pin rules and limits.
2. Accept and hold tickets only during OPEN; recheck limits and jurisdiction.
3. Close entries; persist exactly one result before revealing it.
4. Settle each ticket exactly once from that result, preserving provenance.
5. Complete when every ticket has a terminal settlement/refund. Release reserves
   only as liabilities are discharged. Never reroll after restart.

An interrupted round must resume its stored state. A failure before a valid
result can follow its published void/refund rule. A failure after result storage
must resume that result and honor its payouts; it cannot selectively void winners.

## Implemented in this branch

- Explicit registry for 13 games and math proposals for the 12 wager games.
- Exact payout vectors and 90% proof, including multi-hit Keno liability.
- Cryptographic outcome sampling independent of economic inputs.
- Pure settlement of a ticket against a validated result.
- 15% contest-pool planner with conservation, ties, sponsorship and void refunds.
- Exposure admission calculator and deterministic server-clock boundary checks.
- Offline preview command and mathematical contract tests requiring no DB/secrets.
- A separately disabled practice-only stream worker with immutable persisted
  Spin Win results and restart recovery. It accepts no financial tickets.

These are internal modules, an offline preview and an opt-in practice worker,
not a new financial API. A forward migration adds practice tables and a disabled
stream; no live fee, treasury, wallet, Coin rule row or catalog activation changes.

## Still required for a live release

- Resolve the already-failed owner/runtime migration deployment.
- Approve the proposed mechanics above and exact per-game rule versions.
- Provenance-preserving Coin contest and scheduled-wager escrow, with deferred
  database backstops and owner/runtime grants reviewed together.
- Funded treasury journal and transactional multi-round liability reservations.
- Financial ticket/settlement tables and event streaming; extend the practice
  round lifecycle only after native database concurrency/recovery verification.
- New private-game scoring adapters, fee disclosure and entry consent screens.
- Financial DB tests: concurrent admission at final capacity, duplicate tickets,
  late-cutoff races, cancellation, result/retry crashes, double settlement, and
  restored snapshots across code/rules changes. Pure tests do not cover these.
- Actual backing and limits per currency/jurisdiction, deployment verification,
  responsible-play controls, independent release review and separate activation.

## Commands

```sh
pnpm --filter @socialplay/shared build
pnpm --filter api test:economics
pnpm --filter api economics:preview
# After the API production build:
node apps/api/dist/scripts/game-economics-preview.js
```

Validation for the initial kernel: 127 mathematical/contract tests passed;
targeted TypeScript checking and ESLint passed; the API production build and its
compiled offline preview passed. Its original run included no migration. The
practice extension's SQL tests and native-database limits are documented in
`scheduled-practice-rounds.md`. No production activation or live fee collection
has been performed.

## Research references

Checked 2026-09-30. UK sources below are design references, not a determination
that the platform is licensed or that UK requirements are the only applicable law.

- MOHIO Spin Win (betting period before spin; RNG; 24/7 availability):
  https://mohiogaming.com/games/lotteries/spin-win
- UK Gambling Commission RTS 7 (published probabilities; no adaptive outcomes):
  https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-7-generation-of-random-outcomes
- UK Gambling Commission pool rules (disclose percentage deductions):
  https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/4-2-9-display-of-rules-pool-betting
- UK Gambling Commission RTP monitoring (volatility and performance alerts):
  https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/live-return-to-player-performance-monitoring-of-games-of-chance
- UK Gambling Commission customer funds segregation:
  https://www.gamblingcommission.gov.uk/guidance/customer-funds-segregation-disclosure-to-customers-and-reporting/advice-on-implementing-licence-condition-4-1-1-segregation-of-customer-funds
