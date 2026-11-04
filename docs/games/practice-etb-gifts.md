# Practice ETB and gifts

The member practice experience uses virtual Ethiopian Birr (ETB). It has no cash value, deposit, withdrawal or exchange entitlement. Existing stored game amounts retain their numeric values; this is a practice denomination change, not an FX conversion. Existing financial Coins, Game Points and historical gifts are not migrated or revalued.

`PRACTICE_ETB_ENABLED=true` on the API selects the isolated practice gift service at the existing authenticated `/gift-collection` routes. `VITE_PRACTICE_ETB_ENABLED=true` selects the practice member wallet and hides the unrelated cash balance on game screens. Keep those flags aligned. Existing financial routes, admin records, reward records and ledgers retain their original units and are not renamed to ETB.

Each active member receives one starting gift balance of 10,000 virtual ETB when first opening the collection. It persists across reloads and has no refill endpoint. This is separate from each game's practice balance or per-round limit. The gift catalogue costs 500, 750, 1,000, 2,500, 5,000 and 10,000 practice ETB. The minimum is enforced server-side and in database constraints, not just by the UI.

Buying costs the listed value with zero additional fee. Sending an owned gift in an active group transfers ownership for free. Conversion permanently removes the gift and returns 90%, retaining a 10% virtual fee. For example, a 500 ETB gift converts to 450 ETB. There is no real-money or legacy wallet access in this service.

The additive migration creates isolated accounts, catalogue, items and immutable operations. Deferred database constraints bind balance to the initial grant plus immutable purchase/conversion receipts, and bind ownership to the latest receipt. Transaction locks, immutable item versions and request IDs protect against overspending, duplicate purchases and stale conversions. Chat delivery is in the same transaction. Failed delivery rolls back the debit and gift.

Deploy the API and migration before the web build. Run `node apps/api/dist/scripts/practice-gifts-check.js` after migration to verify the catalogue and balance proofs without changing user data. Rollback can disable the two practice flags; do not delete gift tables or alter historical receipts. Provider casino configuration is independent.

Validation includes isolated PostgreSQL (PGlite) service/constraint tests, authenticated-user gift UI tests, practice-wallet error/retry tests and existing game interaction tests. PGlite serializes transactions, so the concurrent-request tests verify queued retries/overspending but do not substitute for multi-connection PostgreSQL contention acceptance.
