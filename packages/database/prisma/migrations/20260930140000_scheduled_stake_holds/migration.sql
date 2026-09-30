-- Dedicated scheduled stake hold/refund primitives. No settlement or player API.
-- Existing entry validation is reproduced with only the two reservation paths
-- added, plus catalog-only name resolution. Deferred linkage guards below prove
-- exact source, wallet and operation matching for both new operation types.
BEGIN;
SET LOCAL lock_timeout = '20s';
CREATE OR REPLACE FUNCTION public."coin_lot_entry_validate"()
RETURNS trigger SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p RECORD;
  op RECORD;
  original RECORD;
  original_lot RECORD;
BEGIN
  SELECT "id", "userId", "lotClass", "state", "availableAmount", "reservedAmount",
         "requirementAmount", "progressAmount", "reviewId", "parentLotId",
         "availableAt", "mintedAt"
    INTO p FROM public."coin_provenance" WHERE "id" = NEW."lotId" FOR UPDATE;
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
    INTO op FROM public."economic_operations" WHERE "id" = NEW."operationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'economic operation % missing', NEW."operationId"; END IF;
  IF op."userId" <> NEW."userId" AND op."type" NOT IN ('P2P_TRANSFER', 'COMPETITION_PAYOUT', 'COMPENSATION') THEN
    RAISE EXCEPTION 'operation owner differs from lot owner';
  END IF;

  IF NEW."reversesEntryId" IS NOT NULL THEN
    SELECT * INTO original FROM public."coin_lot_entries" WHERE "id" = NEW."reversesEntryId";
    IF NOT FOUND OR original."userId" <> NEW."userId" THEN
      RAISE EXCEPTION 'entry reversal must target its source owner';
    END IF;
    IF op."reversesOperationId" IS DISTINCT FROM original."operationId" THEN
      RAISE EXCEPTION 'reversal operation does not reference its source operation';
    END IF;
    IF original."lotId" <> NEW."lotId" THEN
      SELECT "lotClass", "availableAt" INTO original_lot
        FROM public."coin_provenance" WHERE "id" = original."lotId";
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
      IF op."type" NOT IN ('WITHDRAWAL_HOLD', 'COMPETITION_ESCROW', 'LEGACY_OPENING', 'SCHEDULED_STAKE_HOLD')
         OR NEW."availableDelta" >= 0 OR NEW."reservedDelta" <> -NEW."availableDelta"
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0
         OR (op."type" = 'WITHDRAWAL_HOLD' AND p."lotClass" <> 'WITHDRAWABLE')
         OR (op."type" = 'LEGACY_OPENING' AND (p."lotClass" <> 'UNCLASSIFIED'
              OR op."scopeType" <> 'WITHDRAWAL')) THEN
        RAISE EXCEPTION 'invalid coin reservation';
      END IF;
    ELSIF NEW."entryType" = 'RELEASE' THEN
      IF op."type" NOT IN ('WITHDRAWAL_RELEASE', 'COMPETITION_RELEASE', 'SCHEDULED_STAKE_REFUND')
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
    SELECT 1 FROM public."economic_operations" w
    JOIN public."coin_lot_entries" stake ON stake."operationId" = w."id"
    WHERE w."type" = 'WAGER' AND w."scopeType" = op."scopeType"
      AND w."scopeId" = op."scopeId" AND stake."entryType" = 'CONSUME'
      AND stake."lotId" = NEW."lotId"
  ) THEN
    RAISE EXCEPTION 'payout return must target a funding lot';
  END IF;
  IF op."type" <> 'COMPENSATION' AND NEW."entryType" = 'CONVERT_IN' AND (
    p."parentLotId" IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."coin_lot_entries" src
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
         FROM public."agent_order_settlements" s
         JOIN public."agent_orders" a ON a."id" = s."orderId"
         JOIN public."wallet_transactions" wt ON wt."id" = s."walletTransactionId"
         JOIN public."coin_provenance" parent ON parent."id" = p."parentLotId"
         WHERE s."orderId" = op."scopeId" AND a."userId" = NEW."userId"
           AND wt."userId" = NEW."userId" AND wt."referenceId" = a."id"
           AND wt."referenceType" = 'AGENT_ORDER' AND wt."currency" = 'COINS'
           AND wt."type" = 'COIN_CREDIT' AND wt."ledgerType" = 'CREDIT'
           AND wt."status" = 'SUCCEEDED' AND wt."amount" = s."coinAmount"
           AND wt."amount" = a."coinAmount"
           AND pg_catalog.cardinality(op."walletTransactionIds") = 1
           AND wt."id" = ANY(op."walletTransactionIds")
           AND parent."userId" = NEW."userId"
           AND parent."lotClass" = 'UNCLASSIFIED'
           AND p."mintedAt" = wt."createdAt"
       ) OR NOT EXISTS (
         SELECT 1 FROM public."coin_lot_entries" src
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
      (op."type" = 'SCHEDULED_STAKE_REFUND' AND NEW."entryType" = 'RELEASE') OR
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

CREATE TABLE public.scheduled_stake_holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  policy_id TEXT NOT NULL REFERENCES public.country_casino_policies(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  game_key TEXT NOT NULL CHECK (game_key = 'spin_win'),
  rules_id TEXT NOT NULL CHECK (rules_id = 'single-zero-rtp90-v2'),
  hold_operation_id TEXT NOT NULL UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  refund_operation_id TEXT UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  state TEXT NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((state='HELD' AND refund_operation_id IS NULL) OR (state='REFUNDED' AND refund_operation_id IS NOT NULL))
);
CREATE INDEX scheduled_stake_holds_user ON public.scheduled_stake_holds(user_id,state);
INSERT INTO public.platform_gates(key,enabled,"changedAt") VALUES ('SCHEDULED_STAKE_HOLD',false,pg_catalog.clock_timestamp());

CREATE FUNCTION public.scheduled_stake_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'stake hold history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'HELD' OR NEW.refund_operation_id IS NOT NULL THEN RAISE EXCEPTION 'new hold must be HELD'; END IF;
    PERFORM 1 FROM public.platform_gates WHERE key='SCHEDULED_STAKE_HOLD' AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled stake holds are disabled'; END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
  ELSIF OLD.state <> 'HELD' OR NEW.state <> 'REFUNDED' OR NEW.refund_operation_id IS NULL
    OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','refund_operation_id']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD)-ARRAY['state','refund_operation_id']) THEN
    RAISE EXCEPTION 'stake hold terms are immutable; only exact refund is supported';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_stake_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_stake_holds
FOR EACH ROW EXECUTE FUNCTION public.scheduled_stake_hold_guard();
CREATE TRIGGER scheduled_stake_hold_no_truncate BEFORE TRUNCATE ON public.scheduled_stake_holds
FOR EACH STATEMENT EXECUTE FUNCTION public.scheduled_stake_hold_guard();

-- Shared by the write-time constraint and continuous invariant scan.
CREATE FUNCTION public.scheduled_stake_integrity_failures(target_id TEXT DEFAULT NULL)
RETURNS TABLE(id TEXT) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH subjects AS (
    SELECT * FROM public.scheduled_stake_holds h WHERE target_id IS NULL OR h.id=target_id
  ), operations AS (
    SELECT h.*,o.id AS operation_id,o.type::TEXT AS operation_type,o."userId" AS owner,
      o."scopeType" AS scope_type,o."scopeId" AS scope_id,o."countryPolicyId" AS policy,
      o."countryPolicyVersion" AS version,o."walletTransactionIds" AS wallet_ids,
      o."reversesOperationId" AS reverse_id,false AS refund
    FROM subjects h LEFT JOIN public.economic_operations o ON o.id=h.hold_operation_id
    UNION ALL
    SELECT h.*,o.id,o.type::TEXT,o."userId",o."scopeType",o."scopeId",o."countryPolicyId",
      o."countryPolicyVersion",o."walletTransactionIds",o."reversesOperationId",true
    FROM subjects h LEFT JOIN public.economic_operations o ON o.id=h.refund_operation_id WHERE h.state='REFUNDED'
  )
  SELECT DISTINCT o.id FROM operations o
  WHERE o.operation_id IS NULL OR o.owner IS DISTINCT FROM o.user_id
    OR o.scope_type IS DISTINCT FROM 'SCHEDULED_STAKE' OR o.scope_id IS DISTINCT FROM o.id
    OR o.operation_type IS DISTINCT FROM CASE WHEN o.refund THEN 'SCHEDULED_STAKE_REFUND' ELSE 'SCHEDULED_STAKE_HOLD' END
    OR o.policy IS DISTINCT FROM o.policy_id OR o.version IS DISTINCT FROM o.policy_version
    OR NOT EXISTS(SELECT 1 FROM public.country_casino_policies p WHERE p.id=o.policy_id AND p.version=o.policy_version)
    OR o.reverse_id IS DISTINCT FROM CASE WHEN o.refund THEN o.hold_operation_id ELSE NULL END
    OR pg_catalog.cardinality(o.wallet_ids) IS DISTINCT FROM 1
    OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=o.wallet_ids[1]
      AND w."userId"=o.user_id AND w.currency='COINS' AND w.status='SUCCEEDED'
      AND w.type::TEXT=CASE WHEN o.refund THEN 'COIN_CREDIT' ELSE 'COIN_DEBIT' END
      AND w."ledgerType"::TEXT=CASE WHEN o.refund THEN 'CREDIT' ELSE 'DEBIT' END
      AND w."referenceType"='GAME' AND w."referenceId"=o.id AND w.amount=o.amount
      AND w."balanceAfter"::BIGINT-w."balanceBefore"::BIGINT=CASE WHEN o.refund THEN o.amount ELSE -o.amount END)
    OR (SELECT COALESCE(SUM(e."availableDelta"),0) FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id)
       <> CASE WHEN o.refund THEN o.amount ELSE -o.amount END
    OR EXISTS(SELECT 1 FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id AND (
      e."userId"<>o.user_id OR e."entryType"::TEXT<>CASE WHEN o.refund THEN 'RELEASE' ELSE 'RESERVE' END
      OR e."reservedDelta"<>-e."availableDelta" OR e."progressDelta"<>0 OR e."obligationDelta"<>0
      OR e."counterpartyLotId" IS NOT NULL
      OR (NOT o.refund AND (e."availableDelta">=0 OR e."reversesEntryId" IS NOT NULL))
      OR (o.refund AND NOT EXISTS(SELECT 1 FROM public.coin_lot_entries src WHERE src.id=e."reversesEntryId"
        AND src."operationId"=o.hold_operation_id AND src."lotId"=e."lotId" AND src."userId"=e."userId"
        AND e."availableDelta"=-src."availableDelta" AND e."reservedDelta"=-src."reservedDelta"))))
    OR (o.refund AND (SELECT COUNT(*) FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id)
      <> (SELECT COUNT(*) FROM public.coin_lot_entries e WHERE e."operationId"=o.hold_operation_id))
  UNION
  SELECT h.id FROM subjects h JOIN public.coin_lot_entries src ON src."operationId"=h.hold_operation_id
    JOIN public.coin_lot_entries reversal ON reversal."reversesEntryId"=src.id
    WHERE h.state<>'REFUNDED' OR reversal."operationId" IS DISTINCT FROM h.refund_operation_id
  UNION
  SELECT h.id FROM subjects h JOIN public.economic_operations reversal ON reversal."reversesOperationId"=h.hold_operation_id
    WHERE h.state<>'REFUNDED' OR reversal.id IS DISTINCT FROM h.refund_operation_id
  UNION
  SELECT o.id FROM public.economic_operations o
    WHERE o.type IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND')
      AND (target_id IS NULL OR o."scopeId"=target_id OR o.id=target_id)
      AND NOT EXISTS(SELECT 1 FROM public.scheduled_stake_holds h
        WHERE (o.type='SCHEDULED_STAKE_HOLD' AND h.hold_operation_id=o.id)
          OR (o.type='SCHEDULED_STAKE_REFUND' AND h.refund_operation_id=o.id))
$$;

CREATE FUNCTION public.scheduled_stake_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE subject TEXT; source_id TEXT; kind TEXT;
BEGIN
  IF TG_TABLE_NAME='scheduled_stake_holds' THEN subject:=NEW.id;
  ELSIF TG_TABLE_NAME='economic_operations' THEN
    IF NEW.type IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND') THEN
      subject:=NEW."scopeId";
    ELSE
      SELECT h.id INTO subject FROM public.scheduled_stake_holds h WHERE h.hold_operation_id=NEW."reversesOperationId";
      IF subject IS NULL THEN RETURN NULL; END IF;
    END IF;
  ELSE
    SELECT o.type::TEXT,o."scopeId" INTO kind,subject FROM public.economic_operations o WHERE o.id=NEW."operationId";
    IF kind NOT IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND') THEN
      SELECT h.id INTO subject FROM public.coin_lot_entries src JOIN public.scheduled_stake_holds h ON h.hold_operation_id=src."operationId"
      WHERE src.id=NEW."reversesEntryId";
    END IF;
    IF subject IS NULL THEN RETURN NULL; END IF;
  END IF;
  SELECT id INTO source_id FROM public.scheduled_stake_integrity_failures(subject) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'scheduled stake proof mismatch: %',source_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scheduled_stake_row_proof AFTER INSERT OR UPDATE ON public.scheduled_stake_holds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.scheduled_stake_constraint();
CREATE CONSTRAINT TRIGGER scheduled_stake_operation_proof AFTER INSERT ON public.economic_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.scheduled_stake_constraint();
CREATE CONSTRAINT TRIGGER scheduled_stake_entry_proof AFTER INSERT ON public.coin_lot_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.scheduled_stake_constraint();
REVOKE ALL ON FUNCTION public.scheduled_stake_hold_guard(),public.scheduled_stake_constraint() FROM PUBLIC;
REVOKE ALL ON public.scheduled_stake_holds FROM PUBLIC;
COMMIT;
