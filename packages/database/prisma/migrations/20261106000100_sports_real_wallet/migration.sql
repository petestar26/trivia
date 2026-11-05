BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.sg_sports_players (
 user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
 username text NOT NULL UNIQUE CHECK(username ~ '^sr_[a-f0-9]{32}$'),
 game_id text NOT NULL CHECK(length(game_id) BETWEEN 1 AND 256),
 policy_id text REFERENCES public.country_casino_policies(id) ON DELETE RESTRICT,
 policy_version integer,
 live_started_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((live_started_at IS NULL AND policy_id IS NULL AND policy_version IS NULL)
    OR (live_started_at IS NOT NULL AND policy_id IS NOT NULL AND policy_version>0))
);
CREATE TABLE public.sg_sports_movements (
 call_id text PRIMARY KEY CHECK(length(call_id) BETWEEN 1 AND 256),
 username text NOT NULL REFERENCES public.sg_sports_players(username) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('debit','credit')),
 amount_minor integer NOT NULL CHECK(amount_minor BETWEEN 0 AND 1000000000),
 error integer NOT NULL CHECK(error IN (0,1,2)),
 balance_minor integer NOT NULL CHECK(balance_minor BETWEEN 0 AND 1000000000),
 round_id text NOT NULL CHECK(length(round_id)<=256),
 game_id text NOT NULL CHECK(length(game_id) BETWEEN 1 AND 256),
 rollback boolean NOT NULL,
 operation_id text UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((error=0 AND amount_minor>0) = (operation_id IS NOT NULL))
);
CREATE INDEX sg_sports_player_history ON public.sg_sports_movements(username,created_at DESC);
INSERT INTO public.platform_gates(key,enabled) VALUES('SPORTSBOOK_PLAY',false) ON CONFLICT(key) DO NOTHING;

CREATE FUNCTION public.sg_sports_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Sports identities are permanent'; END IF;
 IF TG_OP='INSERT' AND NEW.live_started_at IS NOT NULL THEN RAISE EXCEPTION 'Sports identity must start without cash access'; END IF;
 IF TG_OP='UPDATE' AND ((NEW.user_id,NEW.username,NEW.game_id,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.username,OLD.game_id,OLD.created_at)
   OR (OLD.live_started_at IS NOT NULL AND (NEW.live_started_at,NEW.policy_id,NEW.policy_version) IS DISTINCT FROM (OLD.live_started_at,OLD.policy_id,OLD.policy_version)))
 THEN RAISE EXCEPTION 'Sports identity and policy pin are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sg_sports_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sg_sports_players FOR EACH ROW EXECUTE FUNCTION public.sg_sports_identity_guard();
CREATE TRIGGER sg_sports_identity_truncate BEFORE TRUNCATE ON public.sg_sports_players FOR EACH STATEMENT EXECUTE FUNCTION public.sg_sports_identity_guard();
CREATE TRIGGER sg_sports_receipt_append_only BEFORE UPDATE OR DELETE ON public.sg_sports_movements FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();
CREATE TRIGGER sg_sports_receipt_no_truncate BEFORE TRUNCATE ON public.sg_sports_movements FOR EACH STATEMENT EXECUTE FUNCTION public.financial_history_append_only();

-- Extend only the two new, independently witnessed operation shapes. Preserve
-- all existing entry, owner, bonus, refund and withdrawal protections verbatim.
DO $extend$ DECLARE def text; original text; BEGIN
 SELECT pg_get_functiondef('public.coin_lot_entry_validate()'::regprocedure) INTO def;
 original := def;
 def := replace(def, $$OR op."type" NOT IN ('PURCHASE', 'BONUS_GRANT', 'LEGACY_OPENING', 'LEGACY_RESOLVE', 'ADMIN_ADJUST')$$,
                     $$OR op."type" NOT IN ('PURCHASE', 'BONUS_GRANT', 'LEGACY_OPENING', 'LEGACY_RESOLVE', 'ADMIN_ADJUST', 'SPORTS_CREDIT')$$);
 def := replace(def, $$OR op."type" NOT IN ('WAGER', 'GIFT_SPEND', 'LEGACY_OPENING', 'ADMIN_ADJUST')$$,
                     $$OR op."type" NOT IN ('WAGER', 'GIFT_SPEND', 'LEGACY_OPENING', 'ADMIN_ADJUST', 'SPORTS_DEBIT')$$);
 def := replace(def, $$(op."type" = 'PURCHASE' AND NEW."entryType" = 'MINT') OR$$,
                     $$(op."type" IN ('PURCHASE','SPORTS_CREDIT') AND NEW."entryType" = 'MINT') OR$$);
 IF def=original OR position($$'SPORTS_DEBIT'$$ IN def)=0 OR position($$'PURCHASE','SPORTS_CREDIT'$$ IN def)=0 THEN
   RAISE EXCEPTION 'Sports entry guard extension did not match current ledger';
 END IF;
 EXECUTE def;
END $extend$;

CREATE FUNCTION public.sg_sports_receipt_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE op public.economic_operations%ROWTYPE; receipt public.sg_sports_movements%ROWTYPE;
 player public.sg_sports_players%ROWTYPE; wt public.wallet_transactions%ROWTYPE; value_sum bigint; count_entries integer;
BEGIN
 IF TG_TABLE_NAME='sg_sports_movements' THEN
   IF NEW.operation_id IS NULL THEN RETURN NULL; END IF;
   SELECT * INTO STRICT op FROM public.economic_operations WHERE id=NEW.operation_id;
 ELSIF TG_TABLE_NAME='economic_operations' THEN
   op:=NEW;
 ELSE
   SELECT * INTO STRICT op FROM public.economic_operations WHERE id=NEW."operationId";
 END IF;
 IF op.type NOT IN ('SPORTS_DEBIT','SPORTS_CREDIT') THEN
   IF TG_TABLE_NAME='sg_sports_movements' THEN RAISE EXCEPTION 'Sports receipt has wrong operation'; END IF;
   RETURN NULL;
 END IF;
 SELECT * INTO receipt FROM public.sg_sports_movements WHERE operation_id=op.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Sports movement lacks immutable receipt'; END IF;
 SELECT * INTO STRICT player FROM public.sg_sports_players WHERE username=receipt.username;
 IF receipt.error<>0 OR receipt.amount_minor<=0 OR player.live_started_at IS NULL
   OR receipt.game_id<>player.game_id OR op."userId"<>player.user_id OR op."scopeType"<>'SOFTAGGREGATOR_SPORTS'
   OR op."scopeId"<>receipt.call_id OR op."requestHash" IS DISTINCT FROM receipt.request_hash
   OR op."countryPolicyId" IS DISTINCT FROM player.policy_id OR op."countryPolicyVersion" IS DISTINCT FROM player.policy_version
   OR (op.type='SPORTS_DEBIT') IS DISTINCT FROM (receipt.action='debit')
   OR cardinality(op."walletTransactionIds")<>1 THEN RAISE EXCEPTION 'Sports receipt and operation disagree'; END IF;
 SELECT * INTO STRICT wt FROM public.wallet_transactions WHERE id=op."walletTransactionIds"[1];
 IF wt."userId"<>player.user_id OR wt.currency<>'COINS' OR wt.status<>'SUCCEEDED'
   OR wt."referenceType"<>'GAME' OR wt."referenceId"<>receipt.call_id OR wt.amount<>receipt.amount_minor
   OR (wt."ledgerType"='DEBIT') IS DISTINCT FROM (receipt.action='debit')
   OR (wt.type='COIN_DEBIT') IS DISTINCT FROM (receipt.action='debit') THEN RAISE EXCEPTION 'Sports wallet transaction is not backed by its receipt'; END IF;
 SELECT COALESCE(sum(e."availableDelta"),0),count(*) INTO value_sum,count_entries
   FROM public.coin_lot_entries e WHERE e."operationId"=op.id;
 IF count_entries=0 OR value_sum<>(CASE WHEN receipt.action='debit' THEN -receipt.amount_minor ELSE receipt.amount_minor END)
   OR EXISTS(SELECT 1 FROM public.coin_lot_entries e JOIN public.coin_provenance p ON p.id=e."lotId"
     WHERE e."operationId"=op.id AND (e."userId"<>player.user_id OR p."userId"<>player.user_id OR p."lotClass"<>'WITHDRAWABLE'
       OR e."reservedDelta"<>0 OR e."progressDelta"<>0 OR e."obligationDelta"<>0 OR e."obligationShare" IS NOT NULL
       OR e."entryType"::text<>(CASE WHEN receipt.action='debit' THEN 'CONSUME' ELSE 'MINT' END)
       OR (receipt.action='credit' AND (p."sourceOperationId" IS DISTINCT FROM op.id OR p."provenanceType"<>'GAME_WIN'
         OR p."walletTransactionId" IS DISTINCT FROM wt.id OR p.amount<>receipt.amount_minor))))
 THEN RAISE EXCEPTION 'Sports movement must reconcile to cash lots only'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sg_sports_receipt_proof AFTER INSERT ON public.sg_sports_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sg_sports_receipt_proof();
CREATE CONSTRAINT TRIGGER sg_sports_operation_proof AFTER INSERT ON public.economic_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type IN ('SPORTS_DEBIT','SPORTS_CREDIT')) EXECUTE FUNCTION public.sg_sports_receipt_proof();
CREATE CONSTRAINT TRIGGER sg_sports_entry_proof AFTER INSERT ON public.coin_lot_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sg_sports_receipt_proof();

REVOKE ALL ON public.sg_sports_players,public.sg_sports_movements FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sg_sports_identity_guard(),public.sg_sports_receipt_proof() FROM PUBLIC;
ALTER FUNCTION public.ledger_apply_runtime_grants(text) RENAME TO ledger_apply_runtime_grants_pre_sports;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_sports(runtime_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.sg_sports_players,public.sg_sports_movements TO %I',runtime_role);
 EXECUTE format('GRANT UPDATE(policy_id,policy_version,live_started_at) ON public.sg_sports_players TO %I',runtime_role);
 EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON public.sg_sports_movements FROM %I',runtime_role);
 EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON public.sg_sports_players FROM %I',runtime_role);
 EXECUTE format('GRANT UPDATE(policy_id,policy_version,live_started_at) ON public.sg_sports_players TO %I',runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text),public.ledger_apply_runtime_grants_pre_sports(text) FROM PUBLIC;
COMMIT;
