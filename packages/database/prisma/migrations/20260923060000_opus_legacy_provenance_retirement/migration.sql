-- M7: one-time terminalization of pre-journal provenance after atomic wallet replay.
CREATE OR REPLACE FUNCTION "coin_lot_row_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The entry INSERT trigger is the only writer of economic caches.
    IF (NEW."availableAmount", NEW."reservedAmount", NEW."requirementAmount", NEW."progressAmount")
       IS DISTINCT FROM
       (OLD."availableAmount", OLD."reservedAmount", OLD."requirementAmount", OLD."progressAmount")
       AND pg_trigger_depth() < 2 THEN
      -- M7 may retire a genuinely pre-journal historical record once, at zero
      -- economic value, after replaying the wallet into new journalled lots.
      -- Its old amount, source and restriction fields remain untouched.
      IF NOT (
        OLD."sourceOperationId" IS NULL AND OLD."lotClass" IS NULL
        AND OLD."state" IS NULL AND OLD."availableAmount" IS NULL
        AND OLD."reservedAmount" IS NULL AND OLD."requirementAmount" IS NULL
        AND OLD."progressAmount" IS NULL
        AND NEW."lotClass" = 'UNCLASSIFIED' AND NEW."state" = 'RECLASSIFIED'
        AND NEW."availableAmount" = 0 AND NEW."reservedAmount" = 0
        AND NEW."requirementAmount" = 0 AND NEW."progressAmount" = 0
        AND NEW."sourceOperationId" IS NOT NULL
        AND NEW."amount" = OLD."amount"
        AND NEW."provenanceType" = OLD."provenanceType"
        AND NEW."restrictionStatus" = OLD."restrictionStatus"
        AND NEW."requiredPlaythrough" = OLD."requiredPlaythrough"
        AND NEW."completedPlaythrough" = OLD."completedPlaythrough"
        AND NEW."userId" = OLD."userId"
        AND EXISTS (
          SELECT 1 FROM "economic_operations" op
          WHERE op."id" = NEW."sourceOperationId"
            AND op."type" = 'LEGACY_OPENING'
            AND op."scopeType" = 'WALLET_REPLAY'
            AND op."scopeId" = OLD."userId"
            AND op."userId" = OLD."userId"
        )
      ) THEN
        RAISE EXCEPTION 'coin lot caches are entry-maintained';
      END IF;
    END IF;
    -- New journal semantics supersede these old fields. Keep their historical
    -- values fixed, and create successor lots for any corrected value.
    IF OLD."sourceOperationId" IS NOT NULL AND (
         NEW."amount" IS DISTINCT FROM OLD."amount"
      OR NEW."restrictionStatus" IS DISTINCT FROM OLD."restrictionStatus"
      OR NEW."requiredPlaythrough" IS DISTINCT FROM OLD."requiredPlaythrough"
      OR NEW."completedPlaythrough" IS DISTINCT FROM OLD."completedPlaythrough"
      OR NEW."lotClass" IS DISTINCT FROM OLD."lotClass"
      OR NEW."sourceOperationId" IS DISTINCT FROM OLD."sourceOperationId"
      OR NEW."userId" IS DISTINCT FROM OLD."userId"
    ) THEN
      RAISE EXCEPTION 'managed coin lot origin fields are immutable';
    END IF;
    IF OLD."state" IN ('CONVERTED', 'EXHAUSTED', 'EXPIRED', 'RECLASSIFIED', 'FORFEITED')
       AND NEW."state" IS DISTINCT FROM OLD."state" THEN
      RAISE EXCEPTION 'terminal coin lot % cannot reopen', OLD."id";
    END IF;
    IF OLD."state" = 'OPEN' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
      IF NEW."state" = 'CONVERTED' THEN
        IF NEW."lotClass" <> 'RESTRICTED' OR COALESCE(NEW."progressAmount", -1) < COALESCE(NEW."requirementAmount", 0)
           OR COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0
           OR NOT EXISTS (SELECT 1 FROM "economic_operations" o WHERE o."type" = 'BONUS_CONVERSION' AND o."scopeType" = 'LOT' AND o."scopeId" = NEW."id") THEN
          RAISE EXCEPTION 'invalid bonus conversion for lot %', NEW."id";
        END IF;
      ELSIF NEW."state" IN ('EXHAUSTED', 'RECLASSIFIED', 'FORFEITED') THEN
        IF COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0 THEN
          RAISE EXCEPTION 'terminal lot % retains value', NEW."id";
        END IF;
      ELSIF NEW."state" = 'EXPIRED' THEN
        IF NEW."lotClass" <> 'RESTRICTED' OR NEW."expiresAt" IS NULL OR NEW."expiresAt" > CURRENT_TIMESTAMP
           OR COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0 THEN
          RAISE EXCEPTION 'invalid expiry for lot %', NEW."id";
        END IF;
      ELSE
        RAISE EXCEPTION 'invalid lot state transition for %', NEW."id";
      END IF;
    END IF;
  END IF;
  IF NEW."lotClass" = 'WITHDRAWABLE' AND COALESCE(NEW."requirementAmount", 0) <> 0 THEN
    RAISE EXCEPTION 'withdrawable lot % has a playthrough obligation', NEW."id";
  END IF;
  IF NEW."lotClass" = 'UNCLASSIFIED' AND NEW."reviewId" IS NULL
     AND EXISTS (SELECT 1 FROM "coin_ledger_accounts" a WHERE a."userId" = NEW."userId" AND a."classifiedAt" IS NOT NULL)
     AND COALESCE(NEW."availableAmount", 0) > 0 THEN
    RAISE EXCEPTION 'classified user has unreviewed unclassified lot %', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
