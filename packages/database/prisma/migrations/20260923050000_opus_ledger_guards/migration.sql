-- M6: journal guards. The user-wallet equality constraint applies only after
-- M7 has classified an account. M3 gates must remain false until M8/M9.

CREATE OR REPLACE FUNCTION "financial_history_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a linked reversal', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "economic_operations_append_only"
BEFORE UPDATE OR DELETE ON "economic_operations"
FOR EACH ROW EXECUTE FUNCTION "financial_history_append_only"();
CREATE TRIGGER "coin_lot_entries_append_only"
BEFORE UPDATE OR DELETE ON "coin_lot_entries"
FOR EACH ROW EXECUTE FUNCTION "financial_history_append_only"();
CREATE TRIGGER "wallet_transactions_append_only"
BEFORE UPDATE OR DELETE ON "wallet_transactions"
FOR EACH ROW EXECUTE FUNCTION "financial_history_append_only"();
CREATE TRIGGER "coin_provenance_no_delete"
BEFORE DELETE ON "coin_provenance"
FOR EACH ROW EXECUTE FUNCTION "financial_history_append_only"();

CREATE OR REPLACE FUNCTION "coin_lot_row_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The entry INSERT trigger is the only writer of economic caches.
    IF (NEW."availableAmount", NEW."reservedAmount", NEW."requirementAmount", NEW."progressAmount")
       IS DISTINCT FROM
       (OLD."availableAmount", OLD."reservedAmount", OLD."requirementAmount", OLD."progressAmount")
       AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'coin lot caches are entry-maintained';
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
CREATE TRIGGER "coin_lot_row_guard"
BEFORE INSERT OR UPDATE ON "coin_provenance"
FOR EACH ROW EXECUTE FUNCTION "coin_lot_row_guard"();

CREATE OR REPLACE FUNCTION "coin_lot_entry_validate"()
RETURNS trigger AS $$
DECLARE
  p RECORD;
  op RECORD;
  original RECORD;
  original_lot RECORD;
BEGIN
  SELECT "id", "userId", "lotClass", "state", "availableAmount", "reservedAmount",
         "requirementAmount", "progressAmount", "reviewId", "parentLotId",
         "availableAt", "mintedAt"
    INTO p FROM "coin_provenance" WHERE "id" = NEW."lotId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coin lot % missing', NEW."lotId"; END IF;
  IF p."userId" <> NEW."userId" THEN RAISE EXCEPTION 'cross-user coin lot entry'; END IF;
  IF p."lotClass" IS NULL OR p."state" IS NULL OR p."availableAmount" IS NULL
     OR p."reservedAmount" IS NULL OR p."requirementAmount" IS NULL OR p."progressAmount" IS NULL THEN
    RAISE EXCEPTION 'coin lot % is not initialized', NEW."lotId";
  END IF;
  IF p."state" <> 'OPEN' THEN
    RAISE EXCEPTION 'coin lot % is terminal', NEW."lotId";
  END IF;
  SELECT "type", "userId", "scopeType", "scopeId", "snapshot", "reversesOperationId",
         "walletTransactionIds"
    INTO op FROM "economic_operations" WHERE "id" = NEW."operationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'economic operation % missing', NEW."operationId"; END IF;
  IF op."userId" <> NEW."userId" AND op."type" NOT IN ('P2P_TRANSFER', 'COMPETITION_PAYOUT', 'COMPENSATION') THEN
    RAISE EXCEPTION 'operation owner differs from lot owner';
  END IF;

  IF NEW."reversesEntryId" IS NOT NULL THEN
    SELECT * INTO original FROM "coin_lot_entries" WHERE "id" = NEW."reversesEntryId";
    IF NOT FOUND OR original."userId" <> NEW."userId" THEN
      RAISE EXCEPTION 'entry reversal must target its source owner';
    END IF;
    IF op."reversesOperationId" IS DISTINCT FROM original."operationId" THEN
      RAISE EXCEPTION 'reversal operation does not reference its source operation';
    END IF;
    IF original."lotId" <> NEW."lotId" THEN
      SELECT "lotClass", "availableAt" INTO original_lot
        FROM "coin_provenance" WHERE "id" = original."lotId";
      IF p."parentLotId" IS DISTINCT FROM original."lotId"
         OR p."lotClass" IS DISTINCT FROM original_lot."lotClass"
         OR p."availableAt" IS DISTINCT FROM original_lot."availableAt" THEN
        RAISE EXCEPTION 'reversal successor does not preserve source class and availability';
      END IF;
    END IF;
    IF NEW."entryType" = 'RELEASE' THEN
      IF original."entryType" <> 'RESERVE' OR NEW."availableDelta" <> -original."availableDelta"
         OR NEW."reservedDelta" <> -original."reservedDelta" THEN
        RAISE EXCEPTION 'RELEASE must exactly reverse a RESERVE';
      END IF;
    ELSIF NEW."entryType" = 'FINALIZE' THEN
      IF original."entryType" <> 'RESERVE' OR NEW."availableDelta" <> 0
         OR NEW."reservedDelta" <> -original."reservedDelta" THEN
        RAISE EXCEPTION 'FINALIZE must clear the original RESERVE';
      END IF;
    ELSIF op."type" = 'COMPENSATION' THEN
      IF NEW."availableDelta" <> -original."availableDelta"
         OR NEW."reservedDelta" <> -original."reservedDelta"
         OR NEW."progressDelta" <> -original."progressDelta"
         OR NEW."obligationDelta" <> -original."obligationDelta" THEN
        RAISE EXCEPTION 'COMPENSATION must negate its original entry';
      END IF;
    ELSE
      RAISE EXCEPTION 'reversesEntryId only belongs to RELEASE, FINALIZE or COMPENSATION';
    END IF;
  ELSIF NEW."entryType" IN ('RELEASE', 'FINALIZE') OR op."type" = 'COMPENSATION' THEN
    RAISE EXCEPTION 'release/finalize/compensation entry lacks reversesEntryId';
  END IF;

  -- COMPENSATION entries are exact inverses of their original entries above;
  -- ordinary entry shapes do not apply because the inverse has opposite signs.
  IF op."type" <> 'COMPENSATION' THEN
    IF NEW."entryType" = 'MINT' THEN
      IF NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" < 0
         OR op."type" NOT IN ('PURCHASE', 'BONUS_GRANT', 'LEGACY_OPENING', 'LEGACY_RESOLVE', 'ADMIN_ADJUST', 'ADMIN_QUALIFY') THEN
        RAISE EXCEPTION 'invalid coin mint';
      END IF;
      IF (op."type" = 'PURCHASE' AND (p."lotClass" <> 'WITHDRAWABLE' OR NEW."obligationDelta" <> 0))
         OR (op."type" = 'BONUS_GRANT' AND (p."lotClass" <> 'RESTRICTED' OR NEW."obligationDelta" <= 0)) THEN
        RAISE EXCEPTION 'mint class or obligation differs from source';
      END IF;
    ELSIF NEW."entryType" = 'CONSUME' THEN
      IF NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0
         OR op."type" NOT IN ('WAGER', 'GIFT_SPEND', 'LEGACY_OPENING', 'ADMIN_ADJUST') THEN
        RAISE EXCEPTION 'invalid coin consumption';
      END IF;
      IF p."lotClass" = 'RESTRICTED' AND op."type" IN ('WAGER', 'GIFT_SPEND')
         AND NEW."obligationShare" IS NULL THEN
        RAISE EXCEPTION 'restricted consumption must record its obligation share';
      END IF;
      IF op."type" = 'ADMIN_ADJUST' AND NOT COALESCE(op."snapshot" ? 'evidence', false) THEN
        RAISE EXCEPTION 'admin debit requires evidence';
      END IF;
    ELSIF NEW."entryType" = 'RETURN' THEN
      IF NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 OR op."type" <> 'PAYOUT' THEN
        RAISE EXCEPTION 'invalid payout return';
      END IF;
    ELSIF NEW."entryType" = 'RESERVE' THEN
      IF op."type" NOT IN ('WITHDRAWAL_HOLD', 'COMPETITION_ESCROW', 'LEGACY_OPENING')
         OR NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> -NEW."availableDelta"
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0
         OR (op."type" = 'WITHDRAWAL_HOLD' AND p."lotClass" <> 'WITHDRAWABLE')
         OR (op."type" = 'LEGACY_OPENING' AND (p."lotClass" <> 'UNCLASSIFIED'
              OR op."scopeType" <> 'WITHDRAWAL')) THEN
        RAISE EXCEPTION 'invalid coin reservation';
      END IF;
    ELSIF NEW."entryType" = 'RELEASE' THEN
      IF op."type" NOT IN ('WITHDRAWAL_RELEASE', 'COMPETITION_RELEASE')
         OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> -NEW."availableDelta"
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 THEN
        RAISE EXCEPTION 'invalid coin release';
      END IF;
    ELSIF NEW."entryType" = 'FINALIZE' THEN
      IF op."type" <> 'WITHDRAWAL_FINALIZE' OR NEW."availableDelta" <> 0
         OR NEW."reservedDelta" >= 0 OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 THEN
        RAISE EXCEPTION 'invalid coin hold finalization';
      END IF;
    ELSIF NEW."entryType" = 'TRANSFER_OUT' THEN
      IF op."type" NOT IN ('P2P_TRANSFER', 'COMPETITION_PAYOUT')
         OR NOT ((NEW."availableDelta" < 0 AND NEW."reservedDelta" = 0)
                 OR (NEW."availableDelta" = 0 AND NEW."reservedDelta" < 0))
         OR NEW."progressDelta" > 0 OR NEW."obligationDelta" > 0
         OR NEW."counterpartyLotId" IS NULL THEN
        RAISE EXCEPTION 'invalid transfer debit';
      END IF;
    ELSIF NEW."entryType" = 'TRANSFER_IN' THEN
      IF op."type" NOT IN ('P2P_TRANSFER', 'COMPETITION_PAYOUT')
         OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" < 0 OR NEW."obligationDelta" < 0
         OR NEW."counterpartyLotId" IS NULL THEN
        RAISE EXCEPTION 'invalid transfer credit';
      END IF;
    ELSIF NEW."entryType" = 'PROGRESS' THEN
      IF op."type" <> 'WAGER' OR p."lotClass" <> 'RESTRICTED'
         OR NEW."availableDelta" <> 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <= 0 OR NEW."obligationDelta" <> -NEW."progressDelta" THEN
        RAISE EXCEPTION 'invalid qualifying progress entry';
      END IF;
    ELSIF NEW."entryType" = 'CONVERT_OUT' THEN
      IF op."type" <> 'BONUS_CONVERSION' OR p."lotClass" <> 'RESTRICTED'
         OR NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 THEN
        RAISE EXCEPTION 'invalid restricted conversion debit';
      END IF;
    ELSIF NEW."entryType" = 'CONVERT_IN' THEN
      IF op."type" <> 'BONUS_CONVERSION' OR p."lotClass" <> 'WITHDRAWABLE'
         OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 THEN
        RAISE EXCEPTION 'invalid withdrawable conversion credit';
      END IF;
    ELSIF NEW."entryType" = 'FORFEIT' THEN
      IF op."type" NOT IN ('BONUS_EXPIRY', 'BONUS_CONVERSION', 'LEGACY_RESOLVE', 'ADMIN_ADJUST')
         OR NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" > 0 THEN
        RAISE EXCEPTION 'invalid coin forfeiture';
      END IF;
    ELSIF NEW."entryType" = 'RECLASS_OUT' THEN
      IF op."type" NOT IN ('LEGACY_OPENING', 'LEGACY_RESOLVE')
         OR NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" > 0 OR NEW."obligationDelta" > 0 THEN
        RAISE EXCEPTION 'invalid legacy reclassification debit';
      END IF;
    ELSIF NEW."entryType" = 'RECLASS_IN' THEN
      IF op."type" NOT IN ('LEGACY_OPENING', 'LEGACY_RESOLVE')
         OR NEW."availableDelta" <= 0 OR NEW."reservedDelta" <> 0
         OR NEW."progressDelta" < 0 OR NEW."obligationDelta" < 0 THEN
        RAISE EXCEPTION 'invalid legacy reclassification credit';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported coin lot entry type';
    END IF;
  END IF;

  IF op."type" <> 'COMPENSATION' AND NEW."entryType" = 'RETURN' AND NOT EXISTS (
    SELECT 1 FROM "economic_operations" w
    JOIN "coin_lot_entries" stake ON stake."operationId" = w."id"
    WHERE w."type" = 'WAGER' AND w."scopeType" = op."scopeType"
      AND w."scopeId" = op."scopeId" AND stake."entryType" = 'CONSUME'
      AND stake."lotId" = NEW."lotId"
  ) THEN
    RAISE EXCEPTION 'payout return must target a funding lot';
  END IF;
  IF op."type" <> 'COMPENSATION' AND NEW."entryType" = 'CONVERT_IN' AND (
    p."parentLotId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "coin_lot_entries" src
      WHERE src."operationId" = NEW."operationId"
        AND src."lotId" = p."parentLotId" AND src."entryType" = 'CONVERT_OUT'
    )
  ) THEN
    RAISE EXCEPTION 'conversion credit must descend from its restricted source lot';
  END IF;
  IF op."type" = 'LEGACY_OPENING' AND NEW."entryType" = 'RECLASS_OUT'
     AND p."lotClass" <> 'UNCLASSIFIED' THEN
    RAISE EXCEPTION 'legacy opening can reclassify only unknown value';
  END IF;
  -- The sole automated path from a legacy unknown lot to WITHDRAWABLE is a
  -- proven, settled Agent order. The application records its chronological
  -- ledger-replay hash; M8 independently recomputes the remaining amount.
  IF op."type" = 'LEGACY_OPENING' AND NEW."entryType" = 'RECLASS_IN'
     AND p."lotClass" = 'WITHDRAWABLE' THEN
    IF op."scopeType" <> 'AGENT_ORDER' OR p."parentLotId" IS NULL
       OR NULLIF(op."snapshot"->>'ledgerReplayHash', '') IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "agent_order_settlements" s
         JOIN "agent_orders" a ON a."id" = s."orderId"
         JOIN "wallet_transactions" wt ON wt."id" = s."walletTransactionId"
         JOIN "coin_provenance" parent ON parent."id" = p."parentLotId"
         WHERE s."orderId" = op."scopeId" AND a."userId" = NEW."userId"
           AND wt."userId" = NEW."userId" AND wt."referenceId" = a."id"
           AND wt."referenceType" = 'AGENT_ORDER' AND wt."currency" = 'COINS'
           AND wt."type" = 'COIN_CREDIT' AND wt."ledgerType" = 'CREDIT'
           AND wt."status" = 'SUCCEEDED' AND wt."amount" = s."coinAmount"
           AND wt."amount" = a."coinAmount"
           AND cardinality(op."walletTransactionIds") = 1
           AND wt."id" = ANY(op."walletTransactionIds")
           AND parent."userId" = NEW."userId"
           AND parent."lotClass" = 'UNCLASSIFIED'
           AND p."mintedAt" = wt."createdAt"
       ) OR NOT EXISTS (
         SELECT 1 FROM "coin_lot_entries" src
         WHERE src."operationId" = NEW."operationId"
           AND src."lotId" = p."parentLotId" AND src."entryType" = 'RECLASS_OUT'
       ) THEN
      RAISE EXCEPTION 'automated withdrawable reclassification lacks proven purchase and replay';
    END IF;
  END IF;

  -- I5: the whitelist is deliberately narrow. COMPENSATION is admitted only
  -- after the exact inverse-entry check above. Competition release is admitted
  -- only as an exact reversal of a reserved share; its gate is off in G0.
  IF p."lotClass" = 'WITHDRAWABLE' AND NEW."availableDelta" > 0 THEN
    IF NOT COALESCE((
      (op."type" = 'PURCHASE' AND NEW."entryType" = 'MINT') OR
      (op."type" = 'ADMIN_QUALIFY' AND NEW."entryType" = 'MINT') OR
      (op."type" = 'BONUS_CONVERSION' AND NEW."entryType" = 'CONVERT_IN') OR
      (op."type" = 'PAYOUT' AND NEW."entryType" = 'RETURN') OR
      (op."type" = 'WITHDRAWAL_RELEASE' AND NEW."entryType" = 'RELEASE') OR
      (op."type" = 'COMPETITION_RELEASE' AND NEW."entryType" = 'RELEASE') OR
      (op."type" = 'LEGACY_OPENING' AND NEW."entryType" = 'RECLASS_IN'
        AND op."scopeType" = 'AGENT_ORDER') OR
      (op."type" = 'LEGACY_RESOLVE' AND NEW."entryType" = 'RECLASS_IN'
        AND op."snapshot" ? 'evidence' AND op."snapshot" ? 'firstApproverId'
        AND op."snapshot" ? 'secondApproverId'
        AND op."snapshot"->>'firstApproverId' <> op."snapshot"->>'secondApproverId') OR
      (op."type" = 'COMPENSATION' AND NEW."reversesEntryId" IS NOT NULL)
    ), false) THEN
      RAISE EXCEPTION 'unauthorized withdrawable credit on lot %', NEW."lotId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "coin_lot_entry_validate"
BEFORE INSERT ON "coin_lot_entries"
FOR EACH ROW EXECUTE FUNCTION "coin_lot_entry_validate"();

CREATE OR REPLACE FUNCTION "coin_lot_entry_apply"()
RETURNS trigger AS $$
BEGIN
  UPDATE "coin_provenance"
  SET "availableAmount" = "availableAmount" + NEW."availableDelta",
      "reservedAmount" = "reservedAmount" + NEW."reservedDelta",
      "progressAmount" = "progressAmount" + NEW."progressDelta",
      "requirementAmount" = "requirementAmount" + NEW."progressDelta" + NEW."obligationDelta",
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = NEW."lotId";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "coin_lot_entry_apply"
AFTER INSERT ON "coin_lot_entries"
FOR EACH ROW EXECUTE FUNCTION "coin_lot_entry_apply"();

-- Deferred I7. A wager can reduce obligation only by its PROGRESS entries.
-- Transfers and escrow splits must conserve the total. Explicit gift spend,
-- expiry and forfeiture remove value from COINS and are checked by M8 as
-- boundary operations; they are not a hidden way to mint withdrawability.
CREATE OR REPLACE FUNCTION "coin_operation_obligation_guard"()
RETURNS trigger AS $$
DECLARE
  kind "operation_type";
  obligation_sum BIGINT;
  progress_sum BIGINT;
  value_sum BIGINT;
  conversion_transfer_sum BIGINT;
  reclass_transfer_sum BIGINT;
  forfeit_sum BIGINT;
  wallet_forfeit_sum BIGINT;
  wallet_forfeit_count BIGINT;
  wallet_forfeit_distinct_count BIGINT;
  operation_user TEXT;
  operation_wallet_ids TEXT[];
  operation_scope TEXT;
  operation_scope_id TEXT;
  withdrawable_reclass_sum BIGINT;
  proven_purchase_amount BIGINT;
BEGIN
  SELECT "type", "userId", "walletTransactionIds", "scopeType", "scopeId"
    INTO kind, operation_user, operation_wallet_ids,
         operation_scope, operation_scope_id
  FROM "economic_operations" WHERE "id" = NEW."operationId";
  SELECT COALESCE(SUM("obligationDelta"), 0),
         COALESCE(SUM("progressDelta"), 0),
         COALESCE(SUM("availableDelta" + "reservedDelta"), 0),
         COALESCE(SUM(CASE WHEN "entryType" IN ('CONVERT_OUT', 'CONVERT_IN')
                           THEN "availableDelta" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "entryType" IN ('RECLASS_OUT', 'RECLASS_IN')
                           THEN "availableDelta" ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN "entryType" = 'FORFEIT'
                           THEN -"availableDelta" ELSE 0 END), 0)
    INTO obligation_sum, progress_sum, value_sum,
         conversion_transfer_sum, reclass_transfer_sum, forfeit_sum
  FROM "coin_lot_entries" WHERE "operationId" = NEW."operationId";
  IF kind = 'WAGER' AND obligation_sum <> -progress_sum THEN
    RAISE EXCEPTION 'wager obligation changed outside qualifying progress';
  END IF;
  IF kind IN ('PAYOUT', 'P2P_TRANSFER', 'COMPETITION_ESCROW', 'COMPETITION_RELEASE', 'COMPETITION_PAYOUT', 'BONUS_CONVERSION')
     AND obligation_sum <> 0 THEN
    RAISE EXCEPTION 'operation % failed obligation conservation', NEW."operationId";
  END IF;
  -- Internal moves cannot create Coins. A capped conversion may separately
  -- FORFEIT an excess amount, so compare only its conversion debit/credit.
  IF kind IN ('P2P_TRANSFER', 'COMPETITION_ESCROW', 'COMPETITION_RELEASE',
              'COMPETITION_PAYOUT', 'LEGACY_RESOLVE')
     AND value_sum <> 0 AND NOT (kind = 'LEGACY_RESOLVE' AND value_sum < 0) THEN
    RAISE EXCEPTION 'operation % failed value conservation', NEW."operationId";
  END IF;
  IF kind = 'BONUS_CONVERSION' AND conversion_transfer_sum <> 0 THEN
    RAISE EXCEPTION 'conversion % created or lost value between classes', NEW."operationId";
  END IF;
  IF kind = 'BONUS_CONVERSION' THEN
    SELECT COALESCE(SUM(w."amount"), 0), COUNT(w."id"), COUNT(DISTINCT wallet_id."id")
      INTO wallet_forfeit_sum, wallet_forfeit_count, wallet_forfeit_distinct_count
    FROM unnest(operation_wallet_ids) AS wallet_id("id")
    LEFT JOIN "wallet_transactions" w ON w."id" = wallet_id."id"
      AND w."userId" = operation_user AND w."currency" = 'COINS'
      AND w."type" = 'COIN_DEBIT' AND w."ledgerType" = 'DEBIT'
      AND w."status" = 'SUCCEEDED';
    IF wallet_forfeit_sum <> forfeit_sum
       OR wallet_forfeit_count <> cardinality(operation_wallet_ids)
       OR wallet_forfeit_distinct_count <> cardinality(operation_wallet_ids) THEN
      RAISE EXCEPTION 'conversion % forfeiture does not match wallet debit', NEW."operationId";
    END IF;
  END IF;
  IF kind IN ('LEGACY_RESOLVE', 'LEGACY_OPENING') AND reclass_transfer_sum <> 0 THEN
    RAISE EXCEPTION 'legacy resolution % failed reclassification conservation', NEW."operationId";
  END IF;
  IF kind = 'LEGACY_OPENING' AND operation_scope = 'AGENT_ORDER' THEN
    SELECT COALESCE(SUM(e."availableDelta"), 0)
      INTO withdrawable_reclass_sum
    FROM "coin_lot_entries" e
    JOIN "coin_provenance" p ON p."id" = e."lotId"
    WHERE e."operationId" = NEW."operationId"
      AND e."entryType" = 'RECLASS_IN' AND p."lotClass" = 'WITHDRAWABLE';
    SELECT s."coinAmount" INTO proven_purchase_amount
    FROM "agent_order_settlements" s
    WHERE s."orderId" = operation_scope_id;
    IF proven_purchase_amount IS NULL
       OR withdrawable_reclass_sum > proven_purchase_amount THEN
      RAISE EXCEPTION 'legacy purchase % classified beyond settled amount', operation_scope_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "coin_operation_obligation_guard"
AFTER INSERT ON "coin_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "coin_operation_obligation_guard"();

CREATE OR REPLACE FUNCTION "classified_wallet_lot_equality"()
RETURNS trigger AS $$
DECLARE
  uid TEXT;
  wallet_balance BIGINT;
  lot_balance BIGINT;
BEGIN
  uid := NEW."userId";
  IF NOT EXISTS (SELECT 1 FROM "coin_ledger_accounts" a WHERE a."userId" = uid AND a."classifiedAt" IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT w."coinsBalance" INTO wallet_balance FROM "wallets" w WHERE w."userId" = uid;
  SELECT COALESCE(SUM(p."availableAmount"), 0) INTO lot_balance
    FROM "coin_provenance" p WHERE p."userId" = uid;
  IF wallet_balance IS NULL OR wallet_balance <> lot_balance THEN
    RAISE EXCEPTION 'classified wallet % imbalance: wallet %, lots %', uid, wallet_balance, lot_balance;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "coin_provenance" p
    WHERE p."userId" = uid AND (p."lotClass" IS NULL OR p."availableAmount" IS NULL OR p."reservedAmount" IS NULL)
  ) THEN
    RAISE EXCEPTION 'classified wallet % has uninitialized lot', uid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "wallet_coin_lot_equality"
AFTER INSERT OR UPDATE ON "wallets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "classified_wallet_lot_equality"();
CREATE CONSTRAINT TRIGGER "entry_coin_lot_equality"
AFTER INSERT ON "coin_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "classified_wallet_lot_equality"();
CREATE CONSTRAINT TRIGGER "classification_coin_lot_equality"
AFTER INSERT OR UPDATE ON "coin_ledger_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "classified_wallet_lot_equality"();

CREATE OR REPLACE FUNCTION "policy_version_guard"()
RETURNS trigger AS $$
DECLARE
  config_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."state" IN ('ACTIVE', 'SUPERSEDED') THEN
    IF (to_jsonb(NEW) - ARRAY['state','status','disabledAt','updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','status','disabledAt','updatedAt']) THEN
      RAISE EXCEPTION 'active/superseded policy version is immutable';
    END IF;
    IF OLD."state" = 'SUPERSEDED' AND NEW."state" <> 'SUPERSEDED' THEN
      RAISE EXCEPTION 'superseded policy cannot be reactivated';
    END IF;
    IF OLD."state" = 'ACTIVE' AND NEW."state" NOT IN ('ACTIVE', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'active policy can only become superseded';
    END IF;
  END IF;
  IF NEW."state" = 'ACTIVE' THEN
    IF NEW."thresholdsConfiguredAt" IS NULL OR NEW."configuredBy" IS NULL
       OR jsonb_typeof(NEW."configurationAttestation") IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'active policy lacks administrator configuration attestation';
    END IF;
    -- A field's numeric zero is valid where its rule permits zero, but only
    -- when the administrator explicitly marked it SET. Defaults from old
    -- migrations never carry these markers.
    FOREACH config_key IN ARRAY ARRAY[
      'minWithdrawal', 'maxWithdrawal', 'dailyWithdrawalLimit', 'monthlyWithdrawalLimit',
      'playthroughMultiplier', 'qualifyingGames', 'maxQualifyingStake',
      'holdingPeriodHours', 'giftDailyLimit', 'kycTierRequired',
      'supportedPaymentMethods', 'withdrawalFeePercent', 'manualReviewThreshold'
    ] LOOP
      IF NEW."configurationAttestation"->>config_key IS DISTINCT FROM 'SET' THEN
        RAISE EXCEPTION 'active policy missing configured threshold %', config_key;
      END IF;
    END LOOP;
    IF NEW."maxConversionMultiple" IS NULL THEN
      IF NEW."configurationAttestation"->>'maxConversionMultiple' IS DISTINCT FROM 'NONE' THEN
        RAISE EXCEPTION 'conversion cap must be explicitly set or marked NONE';
      END IF;
    ELSIF NEW."configurationAttestation"->>'maxConversionMultiple' IS DISTINCT FROM 'VALUE' THEN
      RAISE EXCEPTION 'conversion cap value lacks explicit marker';
    END IF;
    IF NEW."bonusExpiryHours" IS NULL THEN
      IF NEW."configurationAttestation"->>'bonusExpiryHours' IS DISTINCT FROM 'NONE' THEN
        RAISE EXCEPTION 'bonus expiry must be explicitly set or marked NONE';
      END IF;
    ELSIF NEW."configurationAttestation"->>'bonusExpiryHours' IS DISTINCT FROM 'VALUE' THEN
      RAISE EXCEPTION 'bonus expiry value lacks explicit marker';
    END IF;
    IF NEW."minWithdrawal" <= 0 OR NEW."maxWithdrawal" < NEW."minWithdrawal"
       OR NEW."dailyWithdrawalLimit" < 0 OR NEW."monthlyWithdrawalLimit" < 0
       OR NEW."playthroughMultiplier" <= 0 OR NEW."maxQualifyingStake" <= 0
       OR NEW."holdingPeriodHours" < 0 OR NEW."giftDailyLimit" < 0
       OR NEW."kycTierRequired" < 0 OR NEW."withdrawalFeePercent" < 0
       OR NEW."withdrawalFeePercent" > 1 OR NEW."manualReviewThreshold" < 0
       OR NEW."status" <> 'ENABLED' THEN
      RAISE EXCEPTION 'active policy threshold value is invalid';
    END IF;
    IF jsonb_typeof(NEW."qualifyingGames") IS DISTINCT FROM 'array'
       OR jsonb_typeof(NEW."supportedPaymentMethods") IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'active policy game or payout method list is not an array';
    END IF;
    IF jsonb_array_length(NEW."qualifyingGames") = 0
       OR jsonb_array_length(NEW."supportedPaymentMethods") = 0 THEN
      RAISE EXCEPTION 'active policy game or payout method list is empty';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "policy_version_guard"
BEFORE INSERT OR UPDATE ON "country_casino_policies"
FOR EACH ROW EXECUTE FUNCTION "policy_version_guard"();

CREATE OR REPLACE FUNCTION "policy_pointer_guard"()
RETURNS trigger AS $$
DECLARE
  pointed RECORD;
BEGIN
  IF NEW."activePolicyId" IS NULL THEN RETURN NULL; END IF;
  SELECT "countryCode", "state", "thresholdsConfiguredAt" INTO pointed
    FROM "country_casino_policies" WHERE "id" = NEW."activePolicyId";
  IF NOT FOUND OR pointed."countryCode" <> NEW."countryCode"
     OR pointed."state" <> 'ACTIVE' OR pointed."thresholdsConfiguredAt" IS NULL THEN
    RAISE EXCEPTION 'country % points to a non-active or foreign policy', NEW."countryCode";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "policy_pointer_guard"
AFTER INSERT OR UPDATE ON "country_jurisdictions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "policy_pointer_guard"();

CREATE OR REPLACE FUNCTION "active_policy_pointer_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."state" = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM "country_jurisdictions" j
    WHERE j."countryCode" = NEW."countryCode" AND j."activePolicyId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'active policy % lacks its jurisdiction pointer', NEW."id";
  END IF;
  IF NEW."state" = 'SUPERSEDED' AND EXISTS (
    SELECT 1 FROM "country_jurisdictions" j WHERE j."activePolicyId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'superseded policy % remains authoritative', NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "active_policy_pointer_guard"
AFTER INSERT OR UPDATE ON "country_casino_policies"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "active_policy_pointer_guard"();

CREATE OR REPLACE FUNCTION "economic_operation_policy_pin_guard"()
RETURNS trigger AS $$
DECLARE
  pinned RECORD;
BEGIN
  IF NEW."countryPolicyId" IS NULL THEN RETURN NEW; END IF;
  SELECT "version", "countryCode" INTO pinned FROM "country_casino_policies" WHERE "id" = NEW."countryPolicyId";
  IF NOT FOUND OR pinned."version" <> NEW."countryPolicyVersion" THEN
    RAISE EXCEPTION 'operation policy pin does not match immutable policy version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "economic_operation_policy_pin_guard"
BEFORE INSERT ON "economic_operations"
FOR EACH ROW EXECUTE FUNCTION "economic_operation_policy_pin_guard"();

CREATE OR REPLACE FUNCTION "platform_gate_enable_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."enabled" AND (TG_OP = 'INSERT' OR NOT OLD."enabled") THEN
    IF NEW."lastInvariantRunId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "invariant_check_runs" r
      WHERE r."id" = NEW."lastInvariantRunId" AND r."passed" AND r."finishedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'gate % cannot enable without a passed invariant run', NEW."key";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "platform_gate_enable_guard"
BEFORE INSERT OR UPDATE ON "platform_gates"
FOR EACH ROW EXECUTE FUNCTION "platform_gate_enable_guard"();

-- Ensure M4's manually seeded caches match the immutable opening journal.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "coin_provenance" p
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(e."availableDelta"), 0) AS a,
             COALESCE(SUM(e."reservedDelta"), 0) AS r,
             COALESCE(SUM(e."progressDelta"), 0) AS progress,
             COALESCE(SUM(e."progressDelta" + e."obligationDelta"), 0) AS requirement
      FROM "coin_lot_entries" e WHERE e."lotId" = p."id"
    ) totals ON true
    WHERE p."availableAmount" IS DISTINCT FROM totals.a
       OR p."reservedAmount" IS DISTINCT FROM totals.r
       OR p."progressAmount" IS DISTINCT FROM totals.progress
       OR p."requirementAmount" IS DISTINCT FROM totals.requirement
  ) THEN
    RAISE EXCEPTION 'opening coin lot caches do not match opening journal';
  END IF;
END;
$$;
