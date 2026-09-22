-- Migration E7: G0 — Provenance & Allocation DB Safeguards: aggregate lock,
-- playthrough bound, restriction-transition validation.
-- Forward-only correction of 20260922030000_g0_provenance_safeguards
-- (deployed migration is NOT edited/replaced in place).
--
-- Two real gaps in the deployed coin_allocations_guard / coin_provenance_guard
-- triggers:
--
-- 1. coin_allocations_guard checked only THIS allocation's amount against
--    the lot's total amount ("NEW.allocatedAmount > prov.amount"), never
--    the SUM of every allocation already recorded against that lot. Two (or
--    more) separate allocations could each individually look fine while
--    together exceeding the lot — an aggregate over-allocation. It also
--    read the provenance row with a plain SELECT, not FOR UPDATE, so two
--    concurrent allocations against the same lot were never serialized by
--    the database itself (the application's own row lock in
--    provenance-service.ts is the primary defense; this trigger is meant
--    to be the backstop that holds even if application code forgets to
--    lock).
--
-- 2. coin_provenance_guard never checked completedPlaythrough against
--    requiredPlaythrough (a completedPlaythrough > requiredPlaythrough
--    slipped past it), and never validated restriction-status transitions
--    at all — nothing stopped an UNRESTRICTED lot from being moved back to
--    RESTRICTED, or a lot from becoming UNRESTRICTED without having
--    actually cleared its playthrough requirement.

-- 1. Allocation guard: lock + aggregate sum (excluding this row itself, so
--    an UPDATE of an existing allocation doesn't double-count its own prior
--    amount).
CREATE OR REPLACE FUNCTION "coin_allocations_guard"()
RETURNS trigger AS $$
DECLARE
    prov RECORD;
    existing_sum BIGINT;
BEGIN
    IF NEW."allocatedAmount" IS NULL OR NEW."allocatedAmount" < 1 THEN
        RAISE EXCEPTION 'coin_allocations: allocatedAmount must be >= 1 (got %)',
            NEW."allocatedAmount";
    END IF;

    -- Lock the provenance row FOR UPDATE: serializes every concurrent
    -- allocation attempt against the SAME lot at the database level,
    -- independent of whatever locking the calling application code did.
    SELECT "userId", "amount" INTO prov
    FROM "coin_provenance"
    WHERE "id" = NEW."provenanceId"
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'coin_allocations: provenance % not found', NEW."provenanceId";
    END IF;

    IF prov."userId" IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'coin_allocations: userId % does not own provenance %, which belongs to %',
            NEW."userId", NEW."provenanceId", prov."userId";
    END IF;

    -- Aggregate over-allocation guard: sum every OTHER allocation already
    -- recorded against this lot (excluding this row's own prior value on an
    -- UPDATE) and refuse if adding this allocation would push the total
    -- past the lot's amount. The prior version of this trigger compared
    -- only THIS allocation's own amount to the lot total, which is silent
    -- to N allocations that individually fit but collectively overrun it.
    SELECT COALESCE(SUM("allocatedAmount"), 0) INTO existing_sum
    FROM "coin_allocations"
    WHERE "provenanceId" = NEW."provenanceId" AND "id" <> NEW."id";

    IF existing_sum + NEW."allocatedAmount" > prov."amount" THEN
        RAISE EXCEPTION 'coin_allocations: allocating % (% already allocated against this lot) would exceed provenance % amount %',
            NEW."allocatedAmount", existing_sum, NEW."provenanceId", prov."amount";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "coin_allocations_guard" ON "coin_allocations";
CREATE TRIGGER "coin_allocations_guard"
BEFORE INSERT OR UPDATE ON "coin_allocations"
FOR EACH ROW EXECUTE FUNCTION "coin_allocations_guard"();

-- 2. Provenance guard: playthrough bound + restriction-transition validation,
--    layered onto the existing amount/walletTransaction checks.
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

    -- completedPlaythrough can never exceed requiredPlaythrough — a lot
    -- either owes less than it did, or is capped at exactly what it owed;
    -- it never "over-clears".
    IF NEW."completedPlaythrough" > NEW."requiredPlaythrough" THEN
        RAISE EXCEPTION 'coin_provenance: completedPlaythrough % exceeds requiredPlaythrough % (id %)',
            NEW."completedPlaythrough", NEW."requiredPlaythrough", NEW."id";
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

    -- Restriction-status transition validation (UPDATE only — INSERT has no
    -- OLD to compare against). Legal transitions:
    --   RESTRICTED      -> PLAYING_THROUGH | UNRESTRICTED | EXPIRED
    --   PLAYING_THROUGH -> UNRESTRICTED | EXPIRED
    --   UNRESTRICTED    -> (terminal: never leaves)
    --   EXPIRED         -> (terminal: never leaves)
    -- Entering UNRESTRICTED additionally requires the lot to have actually
    -- cleared its playthrough requirement — this is the database-level
    -- backstop for "unlock a restricted lot only when its complete policy
    -- requirement is satisfied", independent of the application code path
    -- that is supposed to enforce it (applyPlaythroughCredit in
    -- provenance-service.ts).
    IF TG_OP = 'UPDATE' AND OLD."restrictionStatus" IS DISTINCT FROM NEW."restrictionStatus" THEN
        IF OLD."restrictionStatus" = 'UNRESTRICTED' THEN
            RAISE EXCEPTION 'coin_provenance: % cannot leave UNRESTRICTED (attempted -> %)',
                NEW."id", NEW."restrictionStatus";
        END IF;

        IF OLD."restrictionStatus" = 'EXPIRED' THEN
            RAISE EXCEPTION 'coin_provenance: % cannot leave EXPIRED (attempted -> %)',
                NEW."id", NEW."restrictionStatus";
        END IF;

        IF OLD."restrictionStatus" = 'PLAYING_THROUGH' AND NEW."restrictionStatus" = 'RESTRICTED' THEN
            RAISE EXCEPTION 'coin_provenance: % cannot move PLAYING_THROUGH -> RESTRICTED',
                NEW."id";
        END IF;

        IF NEW."restrictionStatus" = 'UNRESTRICTED' AND NEW."completedPlaythrough" < NEW."requiredPlaythrough" THEN
            RAISE EXCEPTION 'coin_provenance: % cannot become UNRESTRICTED with completedPlaythrough % < requiredPlaythrough %',
                NEW."id", NEW."completedPlaythrough", NEW."requiredPlaythrough";
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "coin_provenance_guard" ON "coin_provenance";
CREATE TRIGGER "coin_provenance_guard"
BEFORE INSERT OR UPDATE ON "coin_provenance"
FOR EACH ROW EXECUTE FUNCTION "coin_provenance_guard"();
