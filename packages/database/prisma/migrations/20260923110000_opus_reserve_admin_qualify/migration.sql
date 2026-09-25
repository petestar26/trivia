-- Correction 1: ADMIN_QUALIFY is reserved and disabled in G0.
--
-- 20260923050000_opus_ledger_guards admitted ADMIN_QUALIFY as a legitimate
-- source of a coin_lot_entries MINT (including a WITHDRAWABLE MINT under the
-- I5 whitelist), but no application code path ever constructs an
-- ADMIN_QUALIFY operation (coin-ledger-service.ts's creditCoins accepts only
-- 'PURCHASE' | 'BONUS_GRANT' | 'ADMIN_ADJUST'). That left a live, unused door
-- at the database layer: a direct SQL INSERT of an economic_operations row
-- with type='ADMIN_QUALIFY' plus a matching MINT entry would have minted
-- Coins — including WITHDRAWABLE Coins — with no application guard in the
-- way. This migration is forward-only: the deployed 20260923050000 migration
-- is not edited, and the operation_type enum value is NOT dropped (Postgres
-- cannot drop an enum value, and the type name itself stays reserved so it
-- can never be silently reused for something else). Instead:
--
--   1. A new BEFORE INSERT trigger on economic_operations rejects ANY row of
--      type ADMIN_QUALIFY outright, before any entry can even reference it.
--   2. coin_lot_entry_validate (CREATE OR REPLACE, full body reproduced from
--      20260923050000 with ADMIN_QUALIFY removed from both the MINT
--      allow-list and the I5 withdrawable-credit whitelist) is a second,
--      independent line of defense in case (1) is ever bypassed by a
--      superuser role that skips triggers, or a future migration relaxes it
--      without noticing this one.
--
-- Every other MINT/whitelist branch is copied byte-for-byte from
-- 20260923050000_opus_ledger_guards; only the two ADMIN_QUALIFY references
-- are removed.

CREATE OR REPLACE FUNCTION "economic_operation_reserved_type_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'ADMIN_QUALIFY' THEN
    RAISE EXCEPTION 'ADMIN_QUALIFY is reserved and disabled in G0; no operation of this type may be created';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "economic_operation_reserved_type_guard"
BEFORE INSERT ON "economic_operations"
FOR EACH ROW EXECUTE FUNCTION "economic_operation_reserved_type_guard"();

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
         OR op."type" NOT IN ('PURCHASE', 'BONUS_GRANT', 'LEGACY_OPENING', 'LEGACY_RESOLVE', 'ADMIN_ADJUST') THEN
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
      (op."type" = 'COMPENSATION' AND NEW."reversesEntryId" IS NOT NULL)
    ), false) THEN
      RAISE EXCEPTION 'unauthorized withdrawable credit on lot %', NEW."lotId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- The trigger definition (name, timing, table) is identical to
-- 20260923050000_opus_ledger_guards; CREATE OR REPLACE FUNCTION above already
-- rebinds it, no re-CREATE TRIGGER needed since the trigger already exists.
