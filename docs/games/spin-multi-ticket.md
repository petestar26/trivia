# Spin: independent practice tickets

Spin's scheduled table supports Bet 1 through Bet 10 in each shared one-minute round.
Each ticket keeps its own market selections and stake. Users can switch between drafts,
confirm them separately, and inspect saved selections and individual returns against
the same published result. Accepted selections remain highlighted and immutable.

The existing 45-second entry window, cryptographic draw, market payouts, multiples of
40 ETB, and 480 ETB maximum per ticket are unchanged. This table remains free practice:
submission does not debit a wallet, and displayed returns have no cash value.

## Contract and migration

- POST `/games/scheduled/spin-win/tickets` accepts `{ roundId, slot, bets }`.
  Missing `slot` means 1 for older clients; the route and service validate 1–10.
- The receipt identity is `(round_id, user_id, slot)`. Exact retries return that
  receipt after cutoff or pause; conflicting reuse returns 409. The existing
  stream lock, active-user check, deadline guard and immutable-history trigger apply
  independently to every slot. The POST limit allows 30 requests per minute.
- GET returns `maxTickets: 10` and each round's ordered `tickets` array, with
  stake and published payout for every receipt. The legacy `ticket` field remains
  Bet 1. Aggregation preserves the last-12-round limit and player isolation.
- Migration `20261105150000_spin_practice_multi_ticket` backfills existing rows
  with slot 1, adds a database CHECK (1–10), and expands the primary key. No receipt
  is rewritten or removed; no wallet, ledger, draw-worker or permission change is needed.

## Interrupted requests and mixed versions

The client saves the exact pending round, slot and canonical selections in session
storage before sending. Until resolved, new entries stay locked. A fresh snapshot can
resolve only that pending slot; a saved Bet 1 cannot clear an uncertain Bet 2. Bounded
requests, freshness checks and stale-response guards apply to every ticket.

Storage failure blocks new entry. A lost response can be retried with the same identity;
confirmed tickets recover from the server on refresh. Unconfirmed drafts stay local
and reset for each new round. There is no automatic repeat or submission.

Deploy the API and migration before the web update. A new client talking to a legacy
server offers only Bet 1 and refuses to retry a persisted slot above 1. Old clients
continue to use the default slot after the migration. The existing draw worker can
remain deployed because it does not read or write ticket rows.

## Validation

PGlite exercises actual migrations and triggers, preservation of a pre-migration
receipt, ten independent tickets, replay/conflict behavior, SQL bounds, immutability,
player isolation, pause/cutoff handling, shared-result settlement and unchanged wallet
sentinels. PGlite serializes transactions; these tests do not claim native PostgreSQL
multi-connection contention coverage.

Fastify tests cover authenticated slot forwarding and slot validation. Browser-component
tests cover independent drafts and stakes, all ten slots, selected styling, recovery,
uncertain Bet 2, legacy servers, storage failure, different returns and next-round reset.
Visual browser QA uses the actual page with a disposable API fixture, not live accounts.
