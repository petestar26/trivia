-- Populated-upgrade data-integrity validation, guard half.
--
-- Enables the narrowly-scoped, dual-admin "managed lot integrity
-- remediation" operation (LEGACY_INTEGRITY_REMEDIATION, added in
-- 20260923140000) to actually write: closing a malformed managed lot by
-- setting its cache directly to zero (its history cannot be honestly
-- explained by forward-only entries -- that is exactly the nature of
-- pre-existing corruption), and minting a fresh, properly-journaled
-- replacement lot for whatever amount the two admins attest is true.
--
-- Forward-only: 20260923050000_opus_ledger_guards, 20260923060000, and
-- 20260923120000 are not edited; each affected function is reproduced in
-- full via CREATE OR REPLACE with the narrow additions marked below.

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
        (
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
        )
        -- MANAGED-LOT-INTEGRITY: a malformed managed lot may be closed to
        -- zero economic value once, only by moving to the dedicated
        -- INTEGRITY_REMEDIATED terminal state, and only when a RESOLVED
        -- dual-admin review names this exact lot as its subject. The review
        -- row's own existence already required two distinct SUPER_ADMINs
        -- (enforced in application code); this is the DB-level backstop that
        -- the resulting write actually matches what was approved.
        OR (
          NEW."state" = 'INTEGRITY_REMEDIATED'
          AND NEW."availableAmount" = 0 AND NEW."reservedAmount" = 0
          AND NEW."requirementAmount" = 0 AND NEW."progressAmount" = 0
          AND NEW."amount" = OLD."amount"
          AND NEW."lotClass" = OLD."lotClass"
          AND NEW."sourceOperationId" = OLD."sourceOperationId"
          AND NEW."userId" = OLD."userId"
          AND EXISTS (
            SELECT 1 FROM "managed_lot_integrity_reviews" r
            WHERE r."lotId" = NEW."id" AND r."status" = 'RESOLVED'
              AND r."resolutionOperationId" IS NOT NULL
          )
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
    IF OLD."state" IN ('CONVERTED', 'EXHAUSTED', 'EXPIRED', 'RECLASSIFIED', 'FORFEITED', 'INTEGRITY_REMEDIATED')
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
      ELSIF NEW."state" IN ('EXHAUSTED', 'RECLASSIFIED', 'FORFEITED', 'INTEGRITY_REMEDIATED') THEN
        IF COALESCE(NEW."availableAmount", -1) <> 0 OR COALESCE(NEW."reservedAmount", -1) <> 0 THEN
          RAISE EXCEPTION 'terminal lot % retains value', NEW."id";
        END IF;
        IF NEW."state" = 'INTEGRITY_REMEDIATED' AND NOT EXISTS (
          SELECT 1 FROM "managed_lot_integrity_reviews" r
          WHERE r."lotId" = NEW."id" AND r."status" = 'RESOLVED' AND r."resolutionOperationId" IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'lot % cannot become INTEGRITY_REMEDIATED without a resolved review', NEW."id";
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

CREATE OR REPLACE FUNCTION "coin_lot_journal_integrity_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  op RECORD;
  sums RECORD;
BEGIN
  SELECT "id", "userId", "lotClass", "state", "availableAmount", "reservedAmount",
         "requirementAmount", "progressAmount", "sourceOperationId"
    INTO lot FROM "coin_provenance" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF lot."lotClass" IS NULL THEN RETURN NULL; END IF; -- pre-ledger row, not managed

  -- MANAGED-LOT-INTEGRITY: a lot just closed by a resolved dual-admin review
  -- is permanently excluded from this reconciliation. Its historical
  -- anomaly is documented in the review's evidence, not reconstructed as
  -- fabricated entries -- a corrupted lot's true origin cannot be recovered,
  -- only honestly closed.
  IF lot."state" = 'INTEGRITY_REMEDIATED' AND EXISTS (
    SELECT 1 FROM "managed_lot_integrity_reviews" r
    WHERE r."lotId" = lot."id" AND r."status" = 'RESOLVED' AND r."resolutionOperationId" IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

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
         -- CORRECTION 1: ADMIN_QUALIFY removed — reserved and disabled in G0.
         -- MANAGED-LOT-INTEGRITY: LEGACY_INTEGRITY_REMEDIATION may mint a
         -- fresh, dual-admin-attested replacement for a closed malformed lot.
         OR op."type" NOT IN ('PURCHASE', 'BONUS_GRANT', 'LEGACY_OPENING', 'LEGACY_RESOLVE',
                               'ADMIN_ADJUST', 'LEGACY_INTEGRITY_REMEDIATION') THEN
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
  -- CORRECTION 1: ADMIN_QUALIFY removed from this whitelist — reserved and
  -- disabled in G0 (see economic_operation_reserved_type_guard above, which
  -- already refuses to let such an operation exist at all).
  IF p."lotClass" = 'WITHDRAWABLE' AND NEW."availableDelta" > 0 THEN
    IF NOT COALESCE((
      (op."type" = 'PURCHASE' AND NEW."entryType" = 'MINT') OR
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
      (op."type" = 'LEGACY_INTEGRITY_REMEDIATION' AND NEW."entryType" = 'MINT'
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
