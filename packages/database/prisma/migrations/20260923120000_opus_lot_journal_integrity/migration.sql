-- Correction 2: prevent value-bearing coin_provenance rows without journal
-- entries — closes a gap left by 20260923050000_opus_ledger_guards, whose
-- deferred wallet/lot equality constraint (classified_wallet_lot_equality)
-- fires only AFTER INSERT OR UPDATE on "wallets", "coin_lot_entries" and
-- "coin_ledger_accounts" — never on "coin_provenance" itself. A direct SQL
-- statement that inserted a coin_provenance row with lotClass='WITHDRAWABLE'
-- and a nonzero availableAmount, but wrote NO coin_lot_entries row and
-- touched no wallet, committed cleanly: no deferred trigger anywhere in the
-- schema was scoped to the lot table's own write, so nothing ever fired to
-- catch it (a lot "created first" with no entries, with no need for a
-- "later wallet update" ever to arrive, since no constraint was watching the
-- lot table at all). This migration is forward-only: 20260923050000 is not
-- edited; the existing classified_wallet_lot_equality function is reused
-- (CREATE OR REPLACE, unchanged body) and simply given a new firing table.
--
-- Two independent deferred (commit-time) checks now cover "coin_provenance":
--   1. coin_lot_journal_integrity_guard (new): every managed lot (lotClass
--      IS NOT NULL) must have a sourceOperationId that names a real,
--      same-user economic_operations row, and its four cached columns must
--      exactly equal the SUM of its own coin_lot_entries — i.e. every unit
--      of value on a lot must be explained by an entry written in the SAME
--      transaction (entries and their lot's cache are always written
--      together inside one transaction by coin_lot_entry_apply; this
--      constraint is what makes skipping that path unable to survive
--      COMMIT). Legacy pre-ledger rows (lotClass IS NULL) are untouched.
--   2. classified_wallet_lot_equality, now also deferred on coin_provenance:
--      for a classified user, wallet.coinsBalance must still equal the sum
--      of ALL their lots' availableAmount, so a lot cannot be minted in
--      isolation even if it were somehow made to (incorrectly) balance
--      against its own entries alone.
--
-- Both are DEFERRABLE INITIALLY DEFERRED: they evaluate at COMMIT of
-- whichever transaction wrote the lot, so a single-statement, single-
-- transaction direct-SQL insert is rejected in that same transaction — there
-- is no window for a "later" separate transaction to complete the attack,
-- because the first transaction never commits.

CREATE OR REPLACE FUNCTION "coin_lot_journal_integrity_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  op RECORD;
  sums RECORD;
BEGIN
  SELECT "id", "userId", "lotClass", "availableAmount", "reservedAmount",
         "requirementAmount", "progressAmount", "sourceOperationId"
    INTO lot FROM "coin_provenance" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF lot."lotClass" IS NULL THEN RETURN NULL; END IF; -- pre-ledger row, not managed

  IF lot."sourceOperationId" IS NULL THEN
    RAISE EXCEPTION 'managed coin lot % has no source operation', lot."id";
  END IF;
  SELECT "id", "userId" INTO op FROM "economic_operations" WHERE "id" = lot."sourceOperationId";
  IF NOT FOUND OR op."userId" <> lot."userId" THEN
    RAISE EXCEPTION 'managed coin lot % source operation is missing or cross-user', lot."id";
  END IF;

  SELECT COALESCE(SUM("availableDelta"), 0) AS available,
         COALESCE(SUM("reservedDelta"), 0) AS reserved,
         COALESCE(SUM("progressDelta"), 0) AS progress,
         COALESCE(SUM("progressDelta" + "obligationDelta"), 0) AS requirement
    INTO sums FROM "coin_lot_entries" WHERE "lotId" = lot."id";

  IF lot."availableAmount" IS DISTINCT FROM sums.available
     OR lot."reservedAmount" IS DISTINCT FROM sums.reserved
     OR lot."progressAmount" IS DISTINCT FROM sums.progress
     OR lot."requirementAmount" IS DISTINCT FROM sums.requirement THEN
    RAISE EXCEPTION 'coin lot % caches do not reconcile with its ledger entries (value with no journal entry)', lot."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "coin_lot_journal_integrity_guard"
AFTER INSERT OR UPDATE ON "coin_provenance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "coin_lot_journal_integrity_guard"();

CREATE CONSTRAINT TRIGGER "lot_coin_lot_equality"
AFTER INSERT OR UPDATE ON "coin_provenance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "classified_wallet_lot_equality"();
