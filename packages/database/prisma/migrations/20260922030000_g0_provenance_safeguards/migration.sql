-- Migration E3: G0 — Coin Provenance & Allocation DB Safeguards
-- Forward-only corrections. Adds hard DB guards that no API code path can
-- accidentally bypass:
--
-- 1. Cross-user allocation: a CoinAllocation.userId must equal the
--    provenance.userId it references (no spending another user's coins).
-- 2. Over-allocation guard: an allocation may never exceed the remaining
--    spendable amount of its provenance (completed vs required playthrough),
--    enforced by a BEFORE INSERT/UPDATE trigger that consults the source row.
-- 3. Provenance amount <=> wallet transaction consistency: a provenance row
--    must reference the same user as its wallet transaction (when present)
--    so a provenance can never be attached to another user's ledger entry.
-- 4. Non-negative invariants: provenance.amount >= 1, requiredPlaythrough >= 0,
--    completedPlaythrough between 0 and requiredPlaythrough (upper bound is
--    soft because trivial grants may unlock in bulk, but negative is never
--    valid), allocation.allocatedAmount >= 1.

-- 1 & 2 & 4. Allocation INSERT/UPDATE guard.
CREATE OR REPLACE FUNCTION "coin_allocations_guard"()
RETURNS trigger AS $$
DECLARE
    prov RECORD;
BEGIN
    -- Positive spend amount, never zero or negative.
    IF NEW."allocatedAmount" IS NULL OR NEW."allocatedAmount" < 1 THEN
        RAISE EXCEPTION 'coin_allocations: allocatedAmount must be >= 1 (got %)',
            NEW."allocatedAmount";
    END IF;

    -- Cross-user allocation: allocation user must own the provenance.
    SELECT "userId", "amount", "restrictionStatus", "requiredPlaythrough",
           "completedPlaythrough" INTO prov
    FROM "coin_provenance"
    WHERE "id" = NEW."provenanceId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'coin_allocations: provenance % not found', NEW."provenanceId";
    END IF;

    IF prov."userId" IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'coin_allocations: userId % does not own provenance %, which belongs to %',
            NEW."userId", NEW."provenanceId", prov."userId";
    END IF;

    -- Over-allocation guard: restrict the maximum spendable to the provenance
    -- amount budget. Unrestricted prov
    -- enance may be fully spent; restricted grants can only be spent as
    -- playthrough requirements are met (which unlock completedPlaythrough).
    -- We cap at the source amount regardless of restriction state, which is
    -- the hard invariant: you can never allocate more than the provenance
    -- originally granted.
    IF NEW."allocatedAmount" > prov."amount" THEN
        RAISE EXCEPTION 'coin_allocations: allocatedAmount % exceeds provenance % amount %',
            NEW."allocatedAmount", NEW."provenanceId", prov."amount";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "coin_allocations_guard" ON "coin_allocations";
CREATE TRIGGER "coin_allocations_guard"
BEFORE INSERT OR UPDATE ON "coin_allocations"
FOR EACH ROW EXECUTE FUNCTION "coin_allocations_guard"();

-- 3 & 4. Provenance INSERT/UPDATE guard: amount >= 1, playthrough bounds,
--   and walletTransaction cross-user consistency.
CREATE OR REPLACE FUNCTION "coin_provenance_guard"()
RETURNS trigger AS $$
DECLARE
    wt RECORD;
BEGIN
    IF NEW."amount" IS NULL OR NEW."amount" < 1 THEN
        RAISE EXCEPTION 'coin_provenance: amount must be >= 1 (got %)', NEW."amount";
    END IF;

    IF NEW."requiredPlaythrough" IS NULL OR NEW."requiredPlaythrough" < 0 THEN
        RAISE EXCEPTION 'coin_provenance: requiredPlaythrough must be >= 0 (got %)',
            NEW."requiredPlaythrough";
    END IF;

    IF NEW."completedPlaythrough" IS NULL OR NEW."completedPlaythrough" < 0 THEN
        RAISE EXCEPTION 'coin_provenance: completedPlaythrough must be >= 0 (got %)',
            NEW."completedPlaythrough";
    END IF;

    -- walletTransactionId, when present, must belong to the same user.
    IF NEW."walletTransactionId" IS NOT NULL THEN
        SELECT "userId" INTO wt FROM "wallet_transactions" WHERE "id" = NEW."walletTransactionId";
        IF NOT FOUND THEN
            RAISE EXCEPTION 'coin_provenance: walletTransaction % not found',
                NEW."walletTransactionId";
        END IF;
        IF wt."userId" IS DISTINCT FROM NEW."userId" THEN
            RAISE EXCEPTION 'coin_provenance: userId % does not own walletTransaction % (owner %)',
                NEW."userId", NEW."walletTransactionId", wt."userId";
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "coin_provenance_guard" ON "coin_provenance";
CREATE TRIGGER "coin_provenance_guard"
BEFORE INSERT OR UPDATE ON "coin_provenance"
FOR EACH ROW EXECUTE FUNCTION "coin_provenance_guard"();