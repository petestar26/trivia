# Keno practice tickets and ball chamber

Players can confirm up to ten separately priced tickets in the same scheduled round. Each ticket selects 1–10 numbers from 1–80, with a stake per number in multiples of 5 virtual ETB and a maximum total stake of 480 virtual ETB. Bet tabs retain independent drafts. Each bet requires its own confirmation before the existing 45-second cutoff; no automatic repeat or next-round submission is added.

Confirmed tickets are immutable and show their own matches and returned amount against the same 20-number draw. The existing payout formula is unchanged. This remains practice play with no cash value.

The machine uses layered SVG glass, shaded balls, reflections and a separate latest-ball cup. Decorative tumbling balls are unnumbered. Only numbers released by the existing reveal sequence appear in the cup and results. Reduced-motion preferences disable the tumbling and reveal animations. On narrow screens the chamber appears before the number board.

## Server and compatibility

The additive migration assigns historical receipts slot 1, replaces the one-ticket unique key with (round_id, user_id, slot), and makes the slot immutable. Existing balance and payout guards remain active. Admission retains round/account locks and rechecks the cutoff after locks and debit. Repeating an identical slot request returns its receipt without another debit; changing an accepted slot returns a conflict. The existing settlement worker already processes each receipt by its unique ticket ID.

The request slot is optional for older clients. Snapshots keep the legacy ticket field for Bet 1 and add tickets plus maxTickets. New clients default to one ticket if the server has not advertised support. Deploy the migration and API before the web client. No financial wallet, provider or game-economics changes are included.

Pending requests are stored before submission. Refresh and polling recover a receipt; uncertain requests can only retry the same payload. Storage failures block entry. Confirmed local receipts remain locked while the next server snapshot arrives.

## Validation

- 12 focused PGlite tests execute the migration and service SQL: ten tickets, independent stakes, duplicate replay, immutable slots, overspending, account restrictions, cutoff, settlement exactly once, legacy inserts and untouched cash-wallet sentinel.
- 51 web Keno tests cover practice logic and UI, including separate ticket drafts, retries, refresh recovery, per-ticket results and confirmed number selection.
- API TypeScript checks, API bundle, web production build and 27 PWA/recovery checks.

PGlite serializes transactions; these tests do not substitute for native multi-connection PostgreSQL contention tests. Signed-in visual acceptance on a real mobile device remains a separate check.
