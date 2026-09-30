-- Dormant owner-only settlement/cancellation. No gate or game activation.
BEGIN;
SET LOCAL lock_timeout='20s';
LOCK TABLE public.scheduled_stake_holds, public.scheduled_game_rounds,
  public.house_capital_accounts, public.house_round_reservations IN SHARE ROW EXCLUSIVE MODE;
-- Prior dormant prototypes had no pre-admission commitment. They cannot be
-- assigned a fair retroactive result; stop before touching their schema/data.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
    WHERE o.snapshot ? 'financialTicket') THEN
    RAISE EXCEPTION 'existing prototype financial holds require owner-reviewed resolution before upgrading';
  END IF;
END $$;
ALTER TABLE public.scheduled_stake_holds ADD COLUMN settlement_operation_id TEXT UNIQUE
  REFERENCES public.economic_operations(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.scheduled_stake_holds DROP CONSTRAINT scheduled_stake_holds_state_check;
ALTER TABLE public.scheduled_stake_holds DROP CONSTRAINT scheduled_stake_holds_check;
ALTER TABLE public.scheduled_stake_holds ADD CONSTRAINT scheduled_stake_holds_state_check
  CHECK(state IN ('HELD','REFUNDED','SETTLED'));
ALTER TABLE public.scheduled_stake_holds ADD CONSTRAINT scheduled_stake_holds_terminal_check CHECK (
  (state='HELD' AND refund_operation_id IS NULL AND settlement_operation_id IS NULL) OR
  (state='REFUNDED' AND refund_operation_id IS NOT NULL AND settlement_operation_id IS NULL) OR
  (state='SETTLED' AND settlement_operation_id IS NOT NULL AND refund_operation_id IS NULL));
ALTER TABLE public.scheduled_game_rounds ADD COLUMN cancel_reason TEXT;
ALTER TABLE public.scheduled_game_rounds DROP CONSTRAINT scheduled_game_rounds_state_check;
ALTER TABLE public.scheduled_game_rounds DROP CONSTRAINT scheduled_game_rounds_check1;
ALTER TABLE public.scheduled_game_rounds ADD CONSTRAINT scheduled_game_rounds_state_check CHECK(state IN ('OPEN','DRAWN','CANCELLED'));
ALTER TABLE public.scheduled_game_rounds ADD CONSTRAINT scheduled_game_rounds_terminal_check CHECK (
  (state='OPEN' AND outcome IS NULL AND drawn_at IS NULL AND cancel_reason IS NULL) OR
  (state='DRAWN' AND outcome IS NOT NULL AND drawn_at IS NOT NULL AND cancel_reason IS NULL) OR
  (state='CANCELLED' AND mode='FINANCIAL' AND outcome IS NULL AND drawn_at IS NULL
    AND cancel_reason IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(cancel_reason)) BETWEEN 1 AND 512));

CREATE TABLE public.house_round_randomness (
  round_id TEXT PRIMARY KEY REFERENCES public.scheduled_game_rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  seed_hex TEXT NOT NULL CHECK(seed_hex ~ '^[a-f0-9]{64}$'),
  commitment_sha256 TEXT NOT NULL CHECK(commitment_sha256 ~ '^[a-f0-9]{64}$'),
  algorithm TEXT NOT NULL CHECK(algorithm='sha256-rejection-u32be-v1'),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revealed_at TIMESTAMPTZ
);
CREATE TABLE public.house_ticket_resolutions (
  hold_id TEXT PRIMARY KEY REFERENCES public.scheduled_stake_holds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  round_id TEXT NOT NULL REFERENCES public.scheduled_game_rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES public.economic_operations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  session_id TEXT NOT NULL UNIQUE REFERENCES public.game_sessions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN ('SETTLED','CANCELLED')),
  payout INTEGER NOT NULL CHECK(payout>=0),
  house_delta BIGINT NOT NULL,
  released_loss BIGINT NOT NULL CHECK(released_loss>=0),
  coins_balance INTEGER NOT NULL CHECK(coins_balance>=0),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX house_ticket_resolutions_round ON public.house_ticket_resolutions(round_id);
CREATE TRIGGER house_ticket_resolution_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_ticket_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_ticket_resolution_no_truncate BEFORE TRUNCATE ON public.house_ticket_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_capital_owner_guard();

CREATE FUNCTION public.house_spin_outcome(rid TEXT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE x public.house_round_randomness%ROWTYPE; g public.scheduled_game_rounds%ROWTYPE;
  digest BYTEA; word BIGINT; counter INTEGER;
BEGIN
  SELECT * INTO STRICT x FROM public.house_round_randomness WHERE round_id=rid;
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=rid;
  FOR counter IN 0..127 LOOP
    digest:=public.digest(pg_catalog.convert_to('playqube:spin-win:draw:v1'||E'\n'||rid||E'\n'||g.rules_id||E'\n'||x.seed_hex||E'\n'||counter::TEXT,'UTF8'),'sha256'::TEXT);
    word:=pg_catalog.get_byte(digest,0)::BIGINT*16777216+pg_catalog.get_byte(digest,1)::BIGINT*65536
      +pg_catalog.get_byte(digest,2)::BIGINT*256+pg_catalog.get_byte(digest,3);
    IF word<4294967289 THEN RETURN (word%37)::INTEGER; END IF;
  END LOOP;
  RAISE EXCEPTION 'randomness rejection limit exhausted';
END $$;
CREATE FUNCTION public.house_round_randomness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.scheduled_game_rounds%ROWTYPE; owner_oid OID; now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'randomness history is immutable'; END IF;
  SELECT c.relowner INTO owner_oid FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID;
  IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER) IS DISTINCT FROM owner_oid
    THEN RAISE EXCEPTION 'financial randomness is owner-only' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:'||g.stream_id,0));
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id FOR UPDATE;
  now_ms:=pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT;
  IF TG_OP='INSERT' THEN
    IF g.mode<>'FINANCIAL' OR g.state<>'OPEN' OR now_ms<g.opens_ms OR now_ms>=g.closes_ms
      OR NEW.revealed_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.economic_operations o
        WHERE o.snapshot->'financialTicket'->>'roundId'=g.id) THEN
      RAISE EXCEPTION 'financial randomness must be committed before admission'; END IF;
    NEW.prepared_at:=pg_catalog.clock_timestamp();
    IF NEW.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
      'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||NEW.seed_hex,'UTF8'),'sha256'::TEXT),'hex')
      THEN RAISE EXCEPTION 'randomness commitment mismatch'; END IF;
  ELSE
    IF OLD.revealed_at IS NOT NULL OR NEW.revealed_at IS NULL OR g.state<>'OPEN' OR now_ms<g.closes_ms
      OR (pg_catalog.to_jsonb(NEW)-'revealed_at') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'revealed_at')
      THEN RAISE EXCEPTION 'randomness reveal is immutable and after cutoff'; END IF;
    NEW.revealed_at:=pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER house_round_randomness_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_round_randomness
  FOR EACH ROW EXECUTE FUNCTION public.house_round_randomness_guard();
CREATE TRIGGER house_round_randomness_no_truncate BEFORE TRUNCATE ON public.house_round_randomness
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_round_randomness_guard();
CREATE FUNCTION public.house_round_randomness_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT g.id FROM public.scheduled_game_rounds g LEFT JOIN public.house_round_randomness x ON x.round_id=g.id
  WHERE g.mode='FINANCIAL' AND (
    (x.round_id IS NOT NULL AND (x.algorithm<>'sha256-rejection-u32be-v1'
      OR x.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
       'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||x.seed_hex,'UTF8'),'sha256'::TEXT),'hex')))
    OR (g.state='DRAWN' AND CASE WHEN x.round_id IS NULL OR x.revealed_at IS NULL THEN TRUE
      ELSE g.outcome IS DISTINCT FROM public.house_spin_outcome(g.id) END)
    OR (g.state<>'DRAWN' AND x.revealed_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
      WHERE o.snapshot->'financialTicket'->>'roundId'=g.id AND (x.round_id IS NULL OR x.prepared_at>h.created_at))
  )
$$;
CREATE FUNCTION public.house_round_randomness_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE failure TEXT;
BEGIN
  SELECT f.id INTO failure FROM public.house_round_randomness_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'financial randomness proof mismatch: %',failure; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER house_round_randomness_proof AFTER INSERT OR UPDATE ON public.house_round_randomness
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_round_randomness_constraint();
CREATE CONSTRAINT TRIGGER house_round_draw_proof AFTER INSERT OR UPDATE ON public.scheduled_game_rounds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_round_randomness_constraint();
CREATE CONSTRAINT TRIGGER house_ticket_randomness_proof AFTER INSERT ON public.scheduled_stake_holds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_round_randomness_constraint();

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
         OR NEW."progressDelta" <> 0 OR NEW."obligationDelta" <> 0 OR op."type" NOT IN ('PAYOUT','SCHEDULED_STAKE_SETTLE') THEN
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
      IF op."type" NOT IN ('WITHDRAWAL_FINALIZE','SCHEDULED_STAKE_SETTLE') OR NEW."availableDelta" <> 0
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

  IF op."type" = 'PAYOUT' AND NEW."entryType" = 'RETURN' AND NOT EXISTS (
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
      (op."type" = 'SCHEDULED_STAKE_SETTLE' AND NEW."entryType" = 'RETURN') OR
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
  IF op."type"='SCHEDULED_STAKE_SETTLE' AND NEW."entryType"='RETURN' AND NOT EXISTS (
    SELECT 1 FROM public.scheduled_stake_holds h JOIN public.coin_lot_entries src
      ON src."operationId"=h.hold_operation_id AND src."lotId"=NEW."lotId"
    WHERE h.id=op."scopeId" AND h.user_id=NEW."userId" AND src."entryType"='RESERVE'
  ) THEN RAISE EXCEPTION 'scheduled payout must preserve its original funding lot'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.scheduled_round_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stream public.scheduled_game_streams%ROWTYPE;
  duration BIGINT;
  now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'round history cannot be removed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || NEW.stream_id, 0));
  now_ms := pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000)::BIGINT;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO STRICT stream FROM public.scheduled_game_streams WHERE id = NEW.stream_id;
    duration := stream.betting_ms::BIGINT + stream.reveal_ms + stream.result_ms;
    IF NOT stream.enabled OR NEW.state <> 'OPEN' OR NEW.outcome IS NOT NULL OR NEW.drawn_at IS NOT NULL
      OR NEW.game_key IS DISTINCT FROM stream.game_key OR NEW.rules_id IS DISTINCT FROM stream.rules_id
      OR NEW.mode IS DISTINCT FROM stream.mode OR NEW.id IS DISTINCT FROM (stream.id || ':' || NEW.sequence::TEXT)
      OR NEW.opens_ms::NUMERIC IS DISTINCT FROM (stream.anchor_ms::NUMERIC + NEW.sequence::NUMERIC * duration)
      OR NEW.closes_ms <> NEW.opens_ms + stream.betting_ms
      OR NEW.reveal_ends_ms <> NEW.closes_ms + stream.reveal_ms
      OR NEW.ends_ms <> NEW.reveal_ends_ms + stream.result_ms
      OR now_ms < NEW.opens_ms OR now_ms >= NEW.closes_ms THEN
      RAISE EXCEPTION 'invalid, disabled, or closed round creation';
    END IF;
  ELSE
    IF OLD.mode='FINANCIAL' AND OLD.state='OPEN' AND NEW.state='CANCELLED' THEN
      IF NEW.cancel_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(NEW.cancel_reason)) NOT BETWEEN 1 AND 512
        OR NEW.outcome IS NOT NULL OR NEW.drawn_at IS NOT NULL
        OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','cancel_reason']) IS DISTINCT FROM
           (pg_catalog.to_jsonb(OLD)-ARRAY['state','cancel_reason'])
        OR EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=OLD.id AND x.revealed_at IS NOT NULL)
        THEN RAISE EXCEPTION 'only an undrawn financial round can be cancelled'; END IF;
      RETURN NEW;
    END IF;
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['state','outcome','drawn_at','cancel_reason']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['state','outcome','drawn_at','cancel_reason'])
      OR OLD.state <> 'OPEN' OR NEW.state <> 'DRAWN' OR NEW.outcome IS NULL
      OR NEW.outcome NOT BETWEEN 0 AND 36 OR now_ms < OLD.closes_ms THEN
      RAISE EXCEPTION 'invalid round transition or immutable result';
    END IF;
    IF OLD.mode='FINANCIAL' AND NOT EXISTS(SELECT 1 FROM public.house_round_randomness x
      WHERE x.round_id=OLD.id AND x.revealed_at IS NOT NULL AND NEW.outcome=public.house_spin_outcome(OLD.id))
      THEN RAISE EXCEPTION 'financial draw must reveal its precommitted seed'; END IF;
    -- The caller cannot backdate the result. Pause stops new rounds, not
    -- completion of an already-open round, including recovery after downtime.
    NEW.drawn_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

-- Independent exact integer apportionment. Withdrawable fractions round down
-- whenever any restricted source participated; remainders stay restricted.
CREATE FUNCTION public.scheduled_stake_payout_sources(hid TEXT, units INTEGER)
RETURNS TABLE(lot_id TEXT, amount BIGINT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH sources AS (
    SELECT e."lotId" AS lot_id,SUM(e."reservedDelta")::NUMERIC AS stake,
      p."lotClass"::TEXT AS class,p."expiresAt" AS expiry
    FROM public.scheduled_stake_holds h JOIN public.coin_lot_entries e ON e."operationId"=h.hold_operation_id
    JOIN public.coin_provenance p ON p.id=e."lotId"
    WHERE h.id=hid AND e."entryType"='RESERVE' GROUP BY e."lotId",p."lotClass",p."expiresAt"
  ), proportions AS (
    SELECT *,pg_catalog.floor(units::NUMERIC*stake/SUM(stake) OVER()) AS base,
      pg_catalog.mod(units::NUMERIC*stake,SUM(stake) OVER()) AS remainder,
      COUNT(*) FILTER(WHERE class<>'WITHDRAWABLE') OVER()>0 AS restricted
    FROM sources
  ), eligible AS (
    SELECT *,pg_catalog.row_number() OVER(ORDER BY remainder DESC,expiry ASC NULLS LAST,lot_id COLLATE "C") AS rank,
      COUNT(*) OVER() AS count FROM proportions WHERE NOT restricted OR class<>'WITHDRAWABLE'
  ), remaining AS (SELECT units::NUMERIC-COALESCE(SUM(base),0) AS units FROM proportions)
  SELECT p.lot_id,(p.base+CASE WHEN e.lot_id IS NULL THEN 0 ELSE
    pg_catalog.floor(r.units/e.count)+CASE WHEN e.rank<=pg_catalog.mod(r.units,e.count) THEN 1 ELSE 0 END END)::BIGINT
  FROM proportions p CROSS JOIN remaining r LEFT JOIN eligible e ON e.lot_id=p.lot_id
  ORDER BY p.lot_id COLLATE "C"
$$;

CREATE FUNCTION public.scheduled_stake_settlement_failures(target_id TEXT DEFAULT NULL)
RETURNS TABLE(id TEXT) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT h.id FROM public.scheduled_stake_holds h
  LEFT JOIN public.economic_operations o ON o.id=h.settlement_operation_id
  LEFT JOIN public.house_ticket_resolutions z ON z.hold_id=h.id
  WHERE h.state='SETTLED' AND (target_id IS NULL OR h.id=target_id) AND (
    o.id IS NULL OR o.type IS DISTINCT FROM 'SCHEDULED_STAKE_SETTLE'::public.operation_type
    OR o."userId" IS DISTINCT FROM h.user_id OR o."scopeType" IS DISTINCT FROM 'SCHEDULED_STAKE'
    OR o."scopeId" IS DISTINCT FROM h.id OR o."reversesOperationId" IS DISTINCT FROM h.hold_operation_id
    OR o."countryPolicyId" IS DISTINCT FROM h.policy_id OR o."countryPolicyVersion" IS DISTINCT FROM h.policy_version
    OR z.hold_id IS NULL OR z.disposition IS DISTINCT FROM 'SETTLED' OR z.operation_id IS DISTINCT FROM o.id
    OR o.snapshot->'payout' IS DISTINCT FROM pg_catalog.to_jsonb(z.payout)
    OR o.snapshot->'coinsBalance' IS DISTINCT FROM pg_catalog.to_jsonb(z.coins_balance)
    OR o.snapshot->>'roundId' IS DISTINCT FROM z.round_id
    OR NOT EXISTS(SELECT 1 FROM public.scheduled_game_rounds g WHERE g.id=z.round_id AND g.state='DRAWN'
      AND o.snapshot->'outcome'=pg_catalog.to_jsonb(g.outcome))
    OR (z.payout=0 AND pg_catalog.cardinality(o."walletTransactionIds") IS DISTINCT FROM 0)
    OR (z.payout>0 AND (pg_catalog.cardinality(o."walletTransactionIds") IS DISTINCT FROM 1 OR NOT EXISTS(
      SELECT 1 FROM public.wallet_transactions w WHERE w.id=o."walletTransactionIds"[1]
        AND w."userId"=h.user_id AND w.currency='COINS' AND w.status='SUCCEEDED' AND w.type='COIN_CREDIT'
        AND w."ledgerType"='CREDIT' AND w."referenceType"='GAME' AND w."referenceId"=h.id
        AND w.amount=z.payout AND w."balanceAfter"=z.coins_balance
        AND w."balanceAfter"::BIGINT-w."balanceBefore"::BIGINT=z.payout)))
    OR (SELECT COUNT(*) FROM public.coin_lot_entries e WHERE e."operationId"=o.id AND e."entryType"='FINALIZE')
      IS DISTINCT FROM (SELECT COUNT(*) FROM public.coin_lot_entries src WHERE src."operationId"=h.hold_operation_id)
    OR EXISTS(SELECT 1 FROM public.coin_lot_entries e WHERE e."operationId"=o.id AND (
      e."userId"<>h.user_id OR e."progressDelta"<>0 OR e."obligationDelta"<>0 OR e."obligationShare" IS NOT NULL
      OR e."counterpartyLotId" IS NOT NULL OR e."entryType" NOT IN ('FINALIZE','RETURN')
      OR (e."entryType"='FINALIZE' AND NOT EXISTS(SELECT 1 FROM public.coin_lot_entries src
        WHERE src.id=e."reversesEntryId" AND src."operationId"=h.hold_operation_id AND src."lotId"=e."lotId"
          AND src."userId"=e."userId" AND e."availableDelta"=0 AND e."reservedDelta"=-src."reservedDelta"))
      OR (e."entryType"='RETURN' AND (e."reservedDelta"<>0 OR e."availableDelta"<=0 OR e."reversesEntryId" IS NOT NULL))))
    OR EXISTS(SELECT 1 FROM public.scheduled_stake_payout_sources(h.id,z.payout) p WHERE
      p.amount IS DISTINCT FROM (SELECT COALESCE(SUM(e."availableDelta"),0) FROM public.coin_lot_entries e
        WHERE e."operationId"=o.id AND e."entryType"='RETURN' AND e."lotId"=p.lot_id))
    OR EXISTS(SELECT 1 FROM public.coin_lot_entries e WHERE e."operationId"=o.id AND e."entryType"='RETURN'
      AND NOT EXISTS(SELECT 1 FROM public.scheduled_stake_payout_sources(h.id,z.payout) p WHERE p.lot_id=e."lotId" AND p.amount>0))
    OR (SELECT COALESCE(SUM(e."availableDelta"),0) FROM public.coin_lot_entries e WHERE e."operationId"=o.id)
      IS DISTINCT FROM z.payout::BIGINT
  )
$$;

CREATE OR REPLACE FUNCTION public.scheduled_stake_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE financial JSONB; target public.scheduled_game_rounds%ROWTYPE; now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'stake hold history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'HELD' OR NEW.refund_operation_id IS NOT NULL OR NEW.settlement_operation_id IS NOT NULL
      THEN RAISE EXCEPTION 'new hold must be HELD'; END IF;
    PERFORM 1 FROM public.platform_gates WHERE key='SCHEDULED_STAKE_HOLD' AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled stake holds are disabled'; END IF;
    PERFORM 1 FROM public.country_casino_policies
      WHERE id=NEW.policy_id AND version=NEW.policy_version AND state='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled stake requires an active published policy'; END IF;
    SELECT o.snapshot->'financialTicket' INTO financial FROM public.economic_operations o WHERE o.id=NEW.hold_operation_id;
    IF financial IS NOT NULL THEN
      SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id=financial->>'roundId';
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:'||target.stream_id,0));
      SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id=financial->>'roundId' FOR SHARE;
    END IF;
    NEW.created_at:=pg_catalog.clock_timestamp();
    now_ms:=pg_catalog.floor(EXTRACT(EPOCH FROM NEW.created_at)*1000)::BIGINT;
    IF financial IS NOT NULL AND (target.mode<>'FINANCIAL' OR target.state<>'OPEN'
      OR now_ms<target.opens_ms OR now_ms>=target.closes_ms OR NOT EXISTS(
        SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=target.id AND x.revealed_at IS NULL
          AND x.prepared_at<=NEW.created_at))
      THEN RAISE EXCEPTION 'financial hold is past cutoff or missing its commitment'; END IF;
  ELSE
    IF OLD.state<>'HELD' OR NEW.state NOT IN ('REFUNDED','SETTLED')
      OR (NEW.state='REFUNDED' AND (NEW.refund_operation_id IS NULL OR NEW.settlement_operation_id IS NOT NULL))
      OR (NEW.state='SETTLED' AND (NEW.settlement_operation_id IS NULL OR NEW.refund_operation_id IS NOT NULL))
      OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','refund_operation_id','settlement_operation_id']) IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)-ARRAY['state','refund_operation_id','settlement_operation_id']) THEN
      RAISE EXCEPTION 'stake hold terms immutable; only exact refund or settlement supported'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.scheduled_stake_integrity_failures(target_id TEXT DEFAULT NULL)
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
    OR NOT EXISTS(SELECT 1 FROM public.country_casino_policies p WHERE p.id=o.policy_id AND p.version=o.policy_version AND p.state IN ('ACTIVE','SUPERSEDED'))
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
    WHERE h.state='HELD' OR reversal."operationId" IS DISTINCT FROM
      CASE WHEN h.state='REFUNDED' THEN h.refund_operation_id ELSE h.settlement_operation_id END
  UNION
  SELECT h.id FROM subjects h JOIN public.economic_operations reversal ON reversal."reversesOperationId"=h.hold_operation_id
    WHERE h.state='HELD' OR reversal.id IS DISTINCT FROM
      CASE WHEN h.state='REFUNDED' THEN h.refund_operation_id ELSE h.settlement_operation_id END
  UNION
  SELECT o.id FROM public.economic_operations o
    WHERE o.type IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND','SCHEDULED_STAKE_SETTLE')
      AND (target_id IS NULL OR o."scopeId"=target_id OR o.id=target_id)
      AND NOT EXISTS(SELECT 1 FROM public.scheduled_stake_holds h
        WHERE (o.type='SCHEDULED_STAKE_HOLD' AND h.hold_operation_id=o.id)
          OR (o.type='SCHEDULED_STAKE_REFUND' AND h.refund_operation_id=o.id)
          OR (o.type='SCHEDULED_STAKE_SETTLE' AND h.settlement_operation_id=o.id))
  UNION
  SELECT s.id FROM public.scheduled_stake_settlement_failures(target_id) s
  UNION
  SELECT b.id FROM public.scheduled_stake_backing_failures() b
    WHERE target_id IS NULL OR b.id=target_id
$$;

CREATE OR REPLACE FUNCTION public.scheduled_stake_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE subject TEXT; source_id TEXT; kind TEXT;
BEGIN
  IF TG_TABLE_NAME='scheduled_stake_holds' THEN subject:=NEW.id;
  ELSIF TG_TABLE_NAME='economic_operations' THEN
    IF NEW.type IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND','SCHEDULED_STAKE_SETTLE') THEN
      subject:=NEW."scopeId";
    ELSE
      SELECT h.id INTO subject FROM public.scheduled_stake_holds h WHERE h.hold_operation_id=NEW."reversesOperationId";
      IF subject IS NULL THEN RETURN NULL; END IF;
    END IF;
  ELSE
    SELECT o.type::TEXT,o."scopeId" INTO kind,subject FROM public.economic_operations o WHERE o.id=NEW."operationId";
    IF kind NOT IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND','SCHEDULED_STAKE_SETTLE') THEN
      SELECT h.id INTO subject FROM public.coin_lot_entries src JOIN public.scheduled_stake_holds h ON h.hold_operation_id=src."operationId"
      WHERE src.id=NEW."reversesEntryId";
    END IF;
    IF subject IS NULL THEN RETURN NULL; END IF;
  END IF;
  SELECT id INTO source_id FROM public.scheduled_stake_integrity_failures(subject) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'scheduled stake proof mismatch: %',source_id; END IF;
  RETURN NULL;
END $$;

-- A completed operator reserve must have the matching terminal Coin proof.
CREATE FUNCTION public.house_ticket_resolution_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT z.hold_id FROM public.house_ticket_resolutions z
  LEFT JOIN public.scheduled_stake_holds h ON h.id=z.hold_id
  LEFT JOIN public.economic_operations held ON held.id=h.hold_operation_id
  LEFT JOIN public.economic_operations o ON o.id=z.operation_id
  LEFT JOIN public.house_round_reservations r ON r.round_id='ticket:'||h.id
  LEFT JOIN public.scheduled_game_rounds g ON g.id=z.round_id
  LEFT JOIN public.game_sessions session ON session.id=z.session_id
  LEFT JOIN public.game_definitions game ON game.id=session."gameId"
  LEFT JOIN public.game_rules rules ON rules."gameId"=session."gameId" AND rules.version=session."rulesVersion"
  WHERE h.id IS NULL OR held.snapshot->'financialTicket'->>'roundId' IS DISTINCT FROM z.round_id
    OR g.id IS NULL OR g.mode<>'FINANCIAL' OR g.game_key IS DISTINCT FROM h.game_key OR g.rules_id IS DISTINCT FROM h.rules_id
    OR session.id IS NULL OR session."userId" IS DISTINCT FROM h.user_id OR game.key IS DISTINCT FROM h.game_key
    OR rules.id IS NULL OR rules.rules->>'rulesId' IS DISTINCT FROM h.rules_id
    OR session."resultSchemaVersion" IS DISTINCT FROM rules."resultSchemaVersion"
    OR session."mode"::TEXT IS DISTINCT FROM 'WAGER' OR session.family IS DISTINCT FROM rules.family
    OR session."betAmount" IS DISTINCT FROM h.amount OR session."wagerCurrency" IS DISTINCT FROM 'COINS'::public."CurrencyType"
    OR session."rewardCurrency" IS DISTINCT FROM 'COINS'::public."CurrencyType"
    OR session."rewardAmount" IS DISTINCT FROM z.payout
    OR session.status::TEXT IS DISTINCT FROM CASE WHEN z.disposition='SETTLED' THEN 'COMPLETED' ELSE 'CANCELLED' END
    OR session.result->>'roundId' IS DISTINCT FROM z.round_id
    OR session.result->'outcome' IS DISTINCT FROM CASE WHEN z.disposition='SETTLED' THEN pg_catalog.to_jsonb(g.outcome) ELSE 'null'::JSONB END
    OR session.result->'payout' IS DISTINCT FROM pg_catalog.to_jsonb(z.payout)
    OR session.result->>'disposition' IS DISTINCT FROM z.disposition
    OR session.id IS DISTINCT FROM 'scheduled:'||h.id
    OR session."isWin" IS DISTINCT FROM (z.disposition='SETTLED' AND z.payout>h.amount)
    OR session."responseSnapshot"->>'operationId' IS DISTINCT FROM z.operation_id
    OR session."responseSnapshot"->'coinsBalance' IS DISTINCT FROM pg_catalog.to_jsonb(z.coins_balance)
    OR session."responseSnapshot"->'payout' IS DISTINCT FROM pg_catalog.to_jsonb(z.payout)
    OR session."settlementDebitCurrency" IS DISTINCT FROM 'COINS'::public."CurrencyType"
    OR session."settlementCreditCurrency" IS DISTINCT FROM CASE WHEN z.payout>0 THEN 'COINS'::public."CurrencyType" ELSE NULL END
    OR (SELECT COUNT(*) FROM public.wallet_transactions w WHERE w."userId"=h.user_id
       AND w."referenceType"='GAME' AND w."referenceId"=h.id AND w.currency='COINS'
       AND w.status='SUCCEEDED' AND w."ledgerType"='CREDIT') IS DISTINCT FROM CASE WHEN z.payout>0 THEN 1::BIGINT ELSE 0::BIGINT END
    OR r.round_id IS NULL OR r.stake_total<>h.amount OR z.released_loss IS DISTINCT FROM r.reserved_loss
    OR o.id IS NULL OR o."userId" IS DISTINCT FROM h.user_id OR o."scopeType" IS DISTINCT FROM 'SCHEDULED_STAKE'
    OR o."scopeId" IS DISTINCT FROM h.id OR o."reversesOperationId" IS DISTINCT FROM h.hold_operation_id
    OR o."countryPolicyId" IS DISTINCT FROM h.policy_id OR o."countryPolicyVersion" IS DISTINCT FROM h.policy_version
    OR (z.disposition='SETTLED' AND (h.state<>'SETTLED' OR h.settlement_operation_id IS DISTINCT FROM z.operation_id
      OR g.state<>'DRAWN' OR o.type IS DISTINCT FROM 'SCHEDULED_STAKE_SETTLE'::public.operation_type
      OR r.payout_vector->g.outcome IS DISTINCT FROM pg_catalog.to_jsonb(z.payout)
      OR z.house_delta IS DISTINCT FROM h.amount::BIGINT-z.payout::BIGINT))
    OR (z.disposition='CANCELLED' AND (h.state<>'REFUNDED' OR h.refund_operation_id IS DISTINCT FROM z.operation_id
      OR g.state<>'CANCELLED' OR o.type IS DISTINCT FROM 'SCHEDULED_STAKE_REFUND'::public.operation_type
      OR z.payout IS DISTINCT FROM h.amount OR z.house_delta<>0
      OR o.snapshot->>'roundId' IS DISTINCT FROM z.round_id OR o.snapshot->>'reason' IS DISTINCT FROM g.cancel_reason
      OR o.snapshot->'coinsBalance' IS DISTINCT FROM pg_catalog.to_jsonb(z.coins_balance)
      OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=o."walletTransactionIds"[1]
        AND w."balanceAfter"=z.coins_balance)))
  UNION SELECT s.id FROM public.scheduled_stake_settlement_failures() s
$$;

CREATE OR REPLACE FUNCTION public.house_financial_hold_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT h.id FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
  WHERE o.snapshot ? 'financialTicket' AND (
    pg_catalog.jsonb_typeof(o.snapshot->'financialTicket') IS DISTINCT FROM 'object'
    OR NOT EXISTS(SELECT 1 FROM public.house_round_reservations r
      JOIN public.scheduled_game_rounds g ON g.id=o.snapshot->'financialTicket'->>'roundId'
      WHERE r.round_id='ticket:'||h.id AND r.stake_total=h.amount
        AND r.payout_vector=o.snapshot->'financialTicket'->'payouts'
        AND g.mode='FINANCIAL' AND g.game_key=h.game_key AND g.rules_id=h.rules_id
        AND pg_catalog.floor(EXTRACT(EPOCH FROM h.created_at)*1000)>=g.opens_ms
        AND pg_catalog.floor(EXTRACT(EPOCH FROM h.created_at)*1000)<g.closes_ms)
    OR (h.state='HELD' AND EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.hold_id=h.id))
    OR (h.state<>'HELD' AND NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.hold_id=h.id))
  )
  UNION
  SELECT r.round_id FROM public.house_round_reservations r WHERE r.round_id LIKE 'ticket:%' AND NOT EXISTS(
    SELECT 1 FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
    WHERE r.round_id='ticket:'||h.id AND h.amount=r.stake_total AND r.payout_vector=o.snapshot->'financialTicket'->'payouts')
  UNION SELECT z.id FROM public.house_ticket_resolution_failures() z
$$;

CREATE FUNCTION public.house_ticket_resolution_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE failure TEXT;
BEGIN
  IF TG_TABLE_NAME='game_sessions' THEN
    IF NEW.id NOT LIKE 'scheduled:%' THEN RETURN NULL; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.session_id=NEW.id)
      THEN RAISE EXCEPTION 'scheduled financial session lacks its terminal proof'; END IF;
  END IF;
  IF TG_TABLE_NAME='wallet_transactions' THEN
    IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.hold_id=NEW."referenceId") THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.hold_id=OLD."referenceId") THEN RETURN NULL; END IF;
    IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE z.hold_id IN(NEW."referenceId",OLD."referenceId")) THEN RETURN NULL; END IF;
  END IF;
  SELECT f.id INTO failure FROM public.house_financial_hold_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'house ticket resolution proof mismatch: %',failure; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER house_ticket_resolution_proof AFTER INSERT ON public.house_ticket_resolutions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_ticket_resolution_constraint();

CREATE CONSTRAINT TRIGGER house_ticket_wallet_proof AFTER INSERT OR UPDATE OR DELETE ON public.wallet_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_ticket_resolution_constraint();

CREATE CONSTRAINT TRIGGER house_ticket_session_proof AFTER INSERT ON public.game_sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_ticket_resolution_constraint();

CREATE FUNCTION public.house_discharge_ticket(hid TEXT,opid TEXT,kind TEXT,units INTEGER,balance INTEGER,sid TEXT)
RETURNS BIGINT LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE h public.scheduled_stake_holds%ROWTYPE; r public.house_round_reservations%ROWTYPE;
  prior public.house_ticket_resolutions%ROWTYPE; rid TEXT; delta BIGINT; failed TEXT;
BEGIN
  PERFORM 1 FROM public.house_capital_accounts WHERE currency='COINS' FOR UPDATE;
  SELECT * INTO STRICT h FROM public.scheduled_stake_holds WHERE id=hid;
  SELECT o.snapshot->'financialTicket'->>'roundId' INTO rid FROM public.economic_operations o WHERE o.id=h.hold_operation_id;
  SELECT * INTO STRICT r FROM public.house_round_reservations WHERE round_id='ticket:'||hid;
  IF kind IS NULL OR kind NOT IN ('SETTLED','CANCELLED') OR units IS NULL OR units<0 OR balance IS NULL OR balance<0
    THEN RAISE EXCEPTION 'invalid capital discharge'; END IF;
  delta:=CASE WHEN kind='SETTLED' THEN h.amount::BIGINT-units ELSE 0 END;
  SELECT * INTO prior FROM public.house_ticket_resolutions WHERE hold_id=hid;
  IF FOUND THEN
    IF prior.operation_id IS DISTINCT FROM opid OR prior.disposition IS DISTINCT FROM kind OR prior.payout IS DISTINCT FROM units
      OR prior.coins_balance IS DISTINCT FROM balance OR prior.round_id IS DISTINCT FROM rid
      OR prior.session_id IS DISTINCT FROM sid
      THEN RAISE EXCEPTION 'ticket resolution reused with different terms'; END IF;
    RETURN prior.released_loss;
  END IF;
  INSERT INTO public.house_ticket_resolutions(hold_id,round_id,operation_id,disposition,payout,house_delta,released_loss,coins_balance,session_id)
    VALUES(hid,rid,opid,kind,units,delta,r.reserved_loss,balance,sid);
  UPDATE public.house_capital_accounts SET funded_amount=funded_amount+delta,reserved_amount=reserved_amount-r.reserved_loss
    WHERE currency='COINS';
  SELECT f.id INTO failed FROM public.scheduled_stake_integrity_failures(hid) f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'invalid completed ticket: %',failed; END IF;
  SELECT f.id INTO failed FROM public.house_financial_hold_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'invalid discharged ticket: %',failed; END IF;
  RETURN r.reserved_loss;
END $$;
CREATE OR REPLACE FUNCTION public.house_capital_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH sums AS (
    SELECT COALESCE((SELECT SUM(f.amount) FROM public.house_capital_fundings f),0)+
      COALESCE((SELECT SUM(z.house_delta) FROM public.house_ticket_resolutions z),0) AS funded,
           COALESCE((SELECT SUM(r.reserved_loss) FROM public.house_round_reservations r
             WHERE NOT EXISTS(SELECT 1 FROM public.house_ticket_resolutions z WHERE r.round_id='ticket:'||z.hold_id)),0) AS reserved
  )
  SELECT 'COINS'::TEXT FROM sums s LEFT JOIN public.house_capital_accounts a ON a.currency='COINS'
  WHERE a.currency IS NULL OR a.funded_amount IS DISTINCT FROM s.funded
    OR a.reserved_amount IS DISTINCT FROM s.reserved OR s.reserved > s.funded
  UNION
  SELECT r.round_id FROM public.house_round_reservations r WHERE
    pg_catalog.jsonb_typeof(r.payout_vector) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END) NOT BETWEEN 2 AND 100
    OR r.draw_count >= pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END)
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END) v
      WHERE pg_catalog.jsonb_typeof(v.value) IS DISTINCT FROM 'number'
        OR v.value::TEXT !~ '^(0|[1-9][0-9]*)$'
        OR (v.value::TEXT)::NUMERIC > 9223372036854775807)
    OR r.max_gross_payout IS DISTINCT FROM (
      SELECT COALESCE(SUM(p.amount),0) FROM (
        SELECT (v.value#>>'{}')::NUMERIC AS amount FROM pg_catalog.jsonb_array_elements(
          CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array' THEN r.payout_vector ELSE '[]'::JSONB END
        ) v WHERE pg_catalog.jsonb_typeof(v.value)='number'
        ORDER BY amount DESC LIMIT r.draw_count) p)
    OR r.reserved_loss IS DISTINCT FROM greatest(r.max_gross_payout::NUMERIC-r.stake_total::NUMERIC,0)
  UNION SELECT z.id FROM public.house_ticket_resolution_failures() z
$$;
CREATE OR REPLACE FUNCTION "ledger_apply_runtime_grants"(runtime_role TEXT)
RETURNS void AS $$
DECLARE
  -- Named, not current_schema(): with the fixed search path that is pg_catalog.
  schema_name TEXT := 'public';
  t TEXT;
  updatable_user_columns TEXT;
  updatable_columns TEXT;
  trusted TEXT;
  holders TEXT;
  planted TEXT;
  foreign_owned TEXT;
  creators TEXT;
  key_holders TEXT;
  acting TEXT;
  tables_owner OID := (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', schema_name, 'economic_operations')));
  runtime_oid OID := (SELECT r.oid FROM pg_roles r WHERE r.rolname = runtime_role);
  -- Every role the runtime role is, can become or inherits the privileges of.
  reach OID[];
  -- Those whose grants it holds (has_*_privilege): itself, every role it can
  -- become, and every role it inherits from in its own right, but a
  -- superuser it only inherits from. has_*_privilege reports every privilege
  -- for a superuser, whose bypass is not inherited; what such a role is
  -- granted explicitly, the runtime role inherits, and has_*_privilege
  -- reports it for the runtime role itself.
  subjects OID[];
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role % does not exist', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role % must be neither a superuser nor exempt from row security', runtime_role;
  END IF;
  reach := ARRAY(SELECT x.role_id FROM public.ledger_role_reach(runtime_oid) x);
  subjects := ARRAY(SELECT x.role_id FROM public.ledger_role_reach(runtime_oid) x JOIN pg_roles r ON r.oid = x.role_id
                    WHERE x.assumable OR (x.via_id = runtime_oid AND NOT r.rolsuper));
  -- Nor may it become a role that acts beyond any grant, as the setup script
  -- refuses too: attributes apply after SET ROLE, and are never inherited. A
  -- role allowed to create roles could, before PostgreSQL 16, grant itself
  -- any role but a superuser, the tables' owner included (from 16 it holds
  -- ADMIN OPTION only on the roles it created, which ledger_role_reach follows).
  SELECT string_agg(format('%s (%s)', r.rolname, concat_ws(', ',
           CASE WHEN r.rolsuper THEN 'a superuser' END, CASE WHEN r.rolbypassrls THEN 'exempt from row security' END,
           CASE WHEN r.rolcreaterole THEN 'allowed to create roles' END, CASE WHEN r.rolreplication THEN 'allowed to replicate' END)),
           ', ' ORDER BY r.rolname)
    INTO acting
  FROM public.ledger_role_reach(runtime_oid) x JOIN pg_roles r ON r.oid = x.role_id
  WHERE x.assumable AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication);
  IF acting IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s is, or can become, a role that acts beyond its grants: %s. Revoke that membership (or that attribute) as its grantor, then run this again',
        runtime_role, acting);
  END IF;
  -- The owner's privileges come with its ownership, by SET ROLE or by
  -- inheritance alike; a membership that grants neither gives nothing.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
             WHERE n.nspname = schema_name AND r.rolname = runtime_role)
     OR tables_owner = ANY (reach) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s must neither own, nor be able to become or inherit the privileges of, the owner of the schema''s tables', runtime_role);
  END IF;
  -- The approval functions run as the owner and resolve names in pg_catalog,
  -- this schema and pgcrypto's; other functions that run as the owner resolve
  -- names in this schema. A role that could create objects in any of them
  -- could plant a function or operator there that runs with the owner's
  -- privileges, so the runtime role may create nothing in them: not directly,
  -- not through PUBLIC, not as or through any role it can become or inherits
  -- from (the schema's owner included), and it may own nothing in them that
  -- it could have planted before, nor may any such role. What the owner can revoke is
  -- revoked; anything else stops here (SQLSTATE 42501), changing nothing.
  FOR trusted IN
    SELECT DISTINCT s FROM unnest(ARRAY['pg_catalog', schema_name,
      (SELECT n.nspname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto')]) AS s
    WHERE s IS NOT NULL
  LOOP
    IF trusted <> 'pg_catalog' THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', trusted);
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', trusted, runtime_role);
    END IF;
    SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname::text END, ', ')
      INTO holders
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE n.nspname = trusted AND a.privilege_type = 'CREATE'
      AND (a.grantee = 0 OR a.grantee = ANY (reach));
    -- The owner's CREATE is implicit (not in the ACL) and has_schema_privilege
    -- ignores a membership usable only by SET ROLE: check the owner directly.
    IF holders IS NULL AND (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = trusted) = ANY (reach) THEN
      SELECT r.rolname::text INTO holders FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = trusted;
    END IF;
    IF holders IS NOT NULL OR has_schema_privilege(runtime_role, trusted, 'CREATE') THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s can still create objects in schema %s, through %s: functions that run as the owner resolve names there. Revoke that CREATE privilege (or that membership) as its grantor, then run this again',
          runtime_role, trusted, COALESCE(holders, runtime_role));
    END IF;
    -- Nor may any other role outside the owner's trust still create there.
    -- A role is inside it when it can become a superuser or the tables' owner
    -- (ledger_role_is_trusted): nothing it creates gives it more than it has.
    -- A membership in the owner that grants neither SET nor usable ADMIN
    -- OPTION does not bring a role inside, nor does one that grants INHERIT
    -- alone: the owner's attributes stay behind. Any other role -
    -- another application's, an operator's, a retired account - could create
    -- after this setup what a retired role left before it: an exact-type
    -- overload or operator that code running as the owner (migrations, the
    -- preflight and scans, every function pinned to this schema, a cascade
    -- from a key the runtime role changes) would pick. CREATE comes from the
    -- schema's ACL (PUBLIC included) or its ownership, and reaches every role
    -- that can become its holder or inherits from it (ledger_role_reach). The
    -- setup revokes only its own grants (PUBLIC's and the runtime role's,
    -- above): anyone else's it names, and stops. (pg_has_role MEMBER follows
    -- every membership: a cheap first filter, checked in order.)
    SELECT left(string_agg(DISTINCT u.rolname::text || ' (through '
             || CASE WHEN src.holder = 0 THEN 'PUBLIC' ELSE src.holder::regrole::text END || ')', ', '), 2000)
      INTO creators
    FROM pg_namespace n
    CROSS JOIN LATERAL (
      SELECT a.grantee AS holder FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE a.privilege_type = 'CREATE'
      UNION SELECT n.nspowner) src
    JOIN pg_roles u ON u.rolname !~ '^pg_' AND CASE
      WHEN src.holder <> 0 AND NOT pg_has_role(u.oid, src.holder, 'MEMBER') THEN false
      WHEN src.holder <> 0 AND src.holder NOT IN (SELECT x.role_id FROM public.ledger_role_reach(u.oid) x) THEN false
      ELSE NOT public.ledger_role_is_trusted(u.oid, tables_owner) END
    WHERE n.nspname = trusted;
    IF creators IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('roles outside the owner''s trust can still create objects in schema %s: %s. Code that runs as the owner resolves names there; revoke that CREATE privilege (or that membership) as its grantor, or make the role one that can act as the tables'' owner %s, then run this again',
          trusted, creators, tables_owner::regrole::text);
    END IF;
    -- Nor may anything there belong to such a role, or to the runtime role
    -- (or a role it can become or inherits from, which can replace it): what
    -- it created while it could (an exact-type overload of a built-in, an
    -- operator on the ledger's types) sits where the same code resolves
    -- names. Trust is decided once for each owner.
    WITH objects AS MATERIALIZED (
      SELECT o.kind, o.name, o.owner FROM (
        SELECT 'function' AS kind, p.oid::regprocedure::text AS name, p.proowner AS owner, p.pronamespace AS ns FROM pg_proc p
        UNION ALL SELECT 'operator', o.oid::regoperator::text, o.oprowner, o.oprnamespace FROM pg_operator o
        UNION ALL SELECT 'type', t.oid::regtype::text, t.typowner, t.typnamespace FROM pg_type t
        UNION ALL SELECT 'relation', c.oid::regclass::text, c.relowner, c.relnamespace FROM pg_class c
        UNION ALL SELECT 'collation', co.collname::text, co.collowner, co.collnamespace FROM pg_collation co
        UNION ALL SELECT 'conversion', cv.conname::text, cv.conowner, cv.connamespace FROM pg_conversion cv
        UNION ALL SELECT 'operator class', oc.opcname::text, oc.opcowner, oc.opcnamespace FROM pg_opclass oc
        UNION ALL SELECT 'operator family', fam.opfname::text, fam.opfowner, fam.opfnamespace FROM pg_opfamily fam
        UNION ALL SELECT 'text search configuration', tc.cfgname::text, tc.cfgowner, tc.cfgnamespace FROM pg_ts_config tc
        UNION ALL SELECT 'text search dictionary', td.dictname::text, td.dictowner, td.dictnamespace FROM pg_ts_dict td
      ) o JOIN pg_namespace n ON n.oid = o.ns WHERE n.nspname = trusted),
    trust AS MATERIALIZED (
      SELECT r.oid, r.rolname, public.ledger_role_is_trusted(r.oid, tables_owner) AS is_trusted
      FROM pg_roles r WHERE r.oid IN (SELECT owner FROM objects))
    SELECT string_agg(DISTINCT o.kind || ' ' || o.name, ', ') FILTER (WHERE o.owner = ANY (reach)),
           left(string_agg(DISTINCT o.kind || ' ' || o.name || ' (owner ' || u.rolname::text || ')', ', ')
                  FILTER (WHERE NOT u.is_trusted), 2000)
      INTO planted, foreign_owned
    FROM objects o JOIN trust u ON u.oid = o.owner;
    IF planted IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s owns objects in schema %s: %s. Functions that run as the owner could pick them up; check what they are, drop them (or reassign them to the owner), then run this again',
          runtime_role, trusted, planted);
    END IF;
    IF foreign_owned IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('schema %s holds objects owned by roles that can act neither as a superuser nor as the tables'' owner %s: %s. Code that runs as the owner and resolves names there could pick them up; check what they are, drop them (or reassign them to the owner), then run this again',
          trusted, tables_owner::regrole::text, foreign_owned);
    END IF;
  END LOOP;

  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, runtime_role);

  -- Keys other tables follow by cascade: never changed by the runtime role.
  -- A cascade runs as the owner of the referencing table, and so do that
  -- table's triggers; the application never changes these keys (an id, a
  -- country code). So wherever a foreign key cascades or nulls on UPDATE,
  -- the runtime role may update every column of the referenced table but
  -- the referenced ones. (The table-level revokes below also remove these
  -- column grants where the runtime role updates nothing.)
  FOR t IN
    SELECT DISTINCT r.relname::text
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND n.nspname = schema_name
    ORDER BY 1
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass(format('%I.%I', schema_name, t)) AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd')
                        AND c.confrelid = a.attrelid AND a.attnum = ANY (c.confkey));
    EXECUTE format('REVOKE UPDATE ON %I.%I FROM %I', schema_name, t, runtime_role);
    IF updatable_columns IS NOT NULL THEN
      EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO %I', updatable_columns, schema_name, t, runtime_role);
    END IF;
  END LOOP;

  -- Append-only financial history and committed records: insert and read.
  FOREACH t IN ARRAY ARRAY['economic_operations', 'coin_lot_entries', 'wallet_transactions',
                           'agent_order_settlements', 'game_sessions'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Financial state is never deleted.
  FOREACH t IN ARRAY ARRAY['wallets', 'coin_provenance', 'coin_ledger_accounts'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Scheduled holds retain their immutable terms. Only the exact refund
  -- transition's two fields are writable; the row guard validates the pair.
  IF to_regclass(format('%I.scheduled_stake_holds', schema_name)) IS NOT NULL THEN
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a WHERE a.attrelid=to_regclass(format('%I.scheduled_stake_holds', schema_name))
      AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE UPDATE, DELETE ON %I.scheduled_stake_holds FROM %I', schema_name, runtime_role);
    EXECUTE format('REVOKE UPDATE (%s) ON %I.scheduled_stake_holds FROM %I', updatable_columns, schema_name, runtime_role);
    EXECUTE format('GRANT UPDATE (state, refund_operation_id) ON %I.scheduled_stake_holds TO %I', schema_name, runtime_role);
  END IF;

  -- Approvals and their signed assertions: only through the procedures.
  FOREACH t IN ARRAY ARRAY['admin_adjustment_approvals', 'ledger_approval_assertions'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
  END LOOP;
  -- Legacy reviews: the ledger opens them; they change only through the
  -- signed procedures.
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'legacy_balance_reviews', runtime_role);
  -- Immutable rules versions.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'game_rules', runtime_role);
  -- The signing key, and the migration history (which the preflight reads).
  EXECUTE format('REVOKE ALL ON %I.%I FROM %I', schema_name, 'ledger_approval_keys', runtime_role);
  IF to_regclass(format('%I.%I', schema_name, '_prisma_migrations')) IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, '_prisma_migrations', runtime_role);
  END IF;
  -- Users: inserted (users_privilege_guard admits only plain USER accounts
  -- from anyone but the owner), updated in every column but the id, the
  -- role and the status, never deleted.
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO updatable_user_columns
  FROM information_schema.columns c
  WHERE c.table_schema = schema_name AND c.table_name = 'users' AND c.column_name NOT IN ('id', 'role', 'status');
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'users', runtime_role);
  EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO %I', updatable_user_columns, schema_name, 'users', runtime_role);

  -- Nor through a role it can become or inherits from. has_column_privilege
  -- sees only what a role inherits: a membership usable by SET ROLE alone,
  -- directly or through other roles, still lets the runtime role become a
  -- role that changes these keys and start the cascade as it. So each of
  -- `subjects` must be unable to change them; a membership that grants
  -- neither INHERIT, SET nor usable ADMIN OPTION gives nothing. The setup does
  -- not change other roles' privileges: it names each and stops.
  SELECT left(string_agg(DISTINCT format('%s.%s through %s', c.confrelid::regclass::text, a.attname, m.rolname), ', '), 2000)
    INTO key_holders
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
  JOIN pg_roles m ON m.oid = ANY (subjects)
  WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND r.relnamespace = to_regnamespace(schema_name)
    AND has_column_privilege(m.oid, c.confrelid, a.attname::text, 'UPDATE');
  IF key_holders IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s can still change keys other tables follow by cascade, as a role it can become or inherits from: %s. A cascade, and the triggers it fires, run as the owner of the referencing table. Revoke that membership, or that role''s UPDATE on those columns, as its grantor, then run this again',
        runtime_role, key_holders);
  END IF;
  -- Operator capital is never customer runtime state. The broad table grant
  -- above must be narrowed after every runtime setup, including future runs.
  EXECUTE format('REVOKE ALL ON %I.house_round_randomness FROM %I', schema_name, runtime_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.house_ticket_resolutions FROM %I', schema_name, runtime_role);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.house_capital_accounts, %I.house_capital_fundings, %I.house_round_reservations FROM %I',
    schema_name, schema_name, schema_name, runtime_role);
  -- REVOKE on a table does not clear any earlier column-level grants.
  FOREACH t IN ARRAY ARRAY['house_capital_accounts', 'house_capital_fundings', 'house_round_reservations', 'house_ticket_resolutions', 'house_round_randomness'] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a WHERE a.attrelid=to_regclass(format('%I.%I', schema_name, t))
      AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON %I.%I FROM %I',
      updatable_columns, updatable_columns, schema_name, t, runtime_role);
    IF t='house_round_randomness' THEN
      EXECUTE format('REVOKE SELECT (%s) ON %I.%I FROM %I',updatable_columns,schema_name,t,runtime_role);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(TEXT) FROM PUBLIC;
REVOKE ALL ON public.house_round_randomness,public.house_ticket_resolutions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.house_spin_outcome(TEXT),public.house_round_randomness_guard(),
  public.house_round_randomness_constraint(),public.house_ticket_resolution_constraint(),
  public.house_discharge_ticket(TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scheduled_stake_payout_sources(TEXT,INTEGER),
  public.scheduled_stake_settlement_failures(TEXT),public.house_ticket_resolution_failures(),
  public.house_capital_failures(),public.house_financial_hold_failures(),public.house_round_randomness_failures() TO PUBLIC;
COMMIT;
