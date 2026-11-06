BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE public.play_together_policies (
 version integer PRIMARY KEY CHECK(version>0),
 fee_bps integer NOT NULL CHECK(fee_bps BETWEEN 0 AND 2000),
 min_entry integer NOT NULL CHECK(min_entry BETWEEN 100 AND 100000 AND min_entry%100=0),
 max_entry integer NOT NULL CHECK(max_entry BETWEEN min_entry AND 100000 AND max_entry%100=0),
 enabled_games text[] NOT NULL,
 practice_enabled boolean NOT NULL,
 cash_enabled boolean NOT NULL DEFAULT false,
 public_rooms_enabled boolean NOT NULL DEFAULT false,
 changed_by text REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.play_together_policies VALUES
 (1,700,100,100000,ARRAY['spin_win','turbo_keno','dice','number_challenge'],true,false,false,NULL,clock_timestamp());

CREATE TABLE public.play_together_rounds (
 id text PRIMARY KEY,
 group_id text REFERENCES public.groups(id) ON DELETE RESTRICT,
 creator_id text REFERENCES public.users(id) ON DELETE RESTRICT,
 request_id text NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 game text NOT NULL CHECK(game IN ('spin_win','turbo_keno','dice','number_challenge',
   'roulette_keno','lucky_six','thunder_derby_3d','neon_hounds_3d',
   'virtual_football_3d','blackjack','sky_crash','crash_point')),
 currency text NOT NULL CHECK(currency IN ('GAME_POINTS','ETB')),
 entry_amount integer NOT NULL CHECK(entry_amount BETWEEN 100 AND 100000 AND entry_amount%100=0),
 fee_bps integer NOT NULL CHECK(fee_bps BETWEEN 0 AND 2000),
 policy_version integer NOT NULL REFERENCES public.play_together_policies(version),
 rules_id text NOT NULL CHECK(rules_id='salem-together-v1'),
 min_players integer NOT NULL CHECK(min_players BETWEEN 2 AND 20),
 max_players integer NOT NULL CHECK(max_players BETWEEN min_players AND 20),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closes_at timestamptz NOT NULL,
 recovery_deadline timestamptz NOT NULL,
 seed text NOT NULL CHECK(seed ~ '^[0-9a-f]{64}$'),
 seed_commitment text NOT NULL CHECK(seed_commitment ~ '^[0-9a-f]{64}$'),
 terms_hash text NOT NULL CHECK(terms_hash ~ '^[0-9a-f]{64}$'),
 beacon_round bigint NOT NULL CHECK(beacon_round>0),
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','LOCKED','DRAWN','PAID','REFUNDED')),
 locked_at timestamptz,
 locked_entry_ids text[],
 roster_hash text,
 outcome jsonb,
 proof jsonb,
 ranking jsonb,
 void_reason text,
 settlement jsonb,
 funded integer,
 platform_fee integer,
 paid_at timestamptz,
 retry_after timestamptz,
 CHECK((group_id IS NULL)=(creator_id IS NULL)),
 CHECK(closes_at>created_at AND recovery_deadline=closes_at+interval '10 minutes'),
 CHECK((outcome IS NULL)=(proof IS NULL)),
 CHECK((state IN ('PAID','REFUNDED'))=(settlement IS NOT NULL)),
 CHECK((settlement IS NULL)=(paid_at IS NULL)),
 CHECK((settlement IS NULL)=(funded IS NULL)),
 CHECK((settlement IS NULL)=(platform_fee IS NULL)),
 CHECK(funded IS NULL OR (funded>=0 AND platform_fee BETWEEN 0 AND funded))
);
CREATE UNIQUE INDEX play_together_group_open ON public.play_together_rounds(group_id)
 WHERE group_id IS NOT NULL AND state IN ('OPEN','LOCKED','DRAWN');
CREATE UNIQUE INDEX play_together_public_open ON public.play_together_rounds(game,currency)
 WHERE group_id IS NULL AND state IN ('OPEN','LOCKED','DRAWN');
CREATE INDEX play_together_due ON public.play_together_rounds(state,closes_at);
CREATE INDEX play_together_history ON public.play_together_rounds(group_id,created_at DESC,id DESC);

CREATE TABLE public.play_together_entries (
 id text PRIMARY KEY,
 round_id text NOT NULL REFERENCES public.play_together_rounds(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 request_id text NOT NULL UNIQUE,
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='array'),
 amount integer NOT NULL CHECK(amount BETWEEN 100 AND 100000),
 state text NOT NULL DEFAULT 'ACCEPTED' CHECK(state IN ('ACCEPTED','REFUNDED','SETTLED')),
 policy_id text REFERENCES public.country_casino_policies(id) ON DELETE RESTRICT,
 policy_version integer,
 hold_operation_id text UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT,
 hold_transaction_id text NOT NULL UNIQUE REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT,
 close_operation_id text UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT,
 prize_operation_id text UNIQUE REFERENCES public.economic_operations(id) ON DELETE RESTRICT,
 payout_transaction_id text UNIQUE REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT,
 payout integer CHECK(payout>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz,
 CHECK((state='ACCEPTED')=(payout IS NULL)),
 CHECK((state='ACCEPTED')=(closed_at IS NULL)),
 CHECK((COALESCE(payout,0)>0)=(payout_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX play_together_one_active_entry ON public.play_together_entries(round_id,user_id) WHERE state<>'REFUNDED';
CREATE INDEX play_together_member_history ON public.play_together_entries(user_id,created_at DESC,id DESC);

-- Both successful and rejected confirmations have permanent receipts. A failed
-- request cannot become a new bet after a later deposit or network retry.
CREATE TABLE public.play_together_requests (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 round_id text NOT NULL REFERENCES public.play_together_rounds(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.platform_gates(key,enabled) VALUES('GROUP_PLAY',false) ON CONFLICT(key) DO NOTHING;

CREATE FUNCTION public.play_together_round_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE accepted text[]; p public.play_together_policies%ROWTYPE;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Group round history is permanent'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO STRICT p FROM public.play_together_policies WHERE version=NEW.policy_version;
   IF NEW.fee_bps<>p.fee_bps OR NEW.entry_amount NOT BETWEEN p.min_entry AND p.max_entry
     OR NOT NEW.game=ANY(p.enabled_games)
   THEN RAISE EXCEPTION 'New round must match its published platform policy'; END IF;
   IF NEW.state<>'OPEN' OR NEW.outcome IS NOT NULL OR NEW.locked_entry_ids IS NOT NULL
     OR NEW.settlement IS NOT NULL OR NEW.void_reason IS NOT NULL THEN RAISE EXCEPTION 'Round must begin open'; END IF;
   RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','locked_at','locked_entry_ids','roster_hash','outcome','proof','ranking','void_reason','settlement','funded','platform_fee','paid_at','retry_after'])
   IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','locked_at','locked_entry_ids','roster_hash','outcome','proof','ranking','void_reason','settlement','funded','platform_fee','paid_at','retry_after'])
 THEN RAISE EXCEPTION 'Published round terms cannot change'; END IF;
 IF OLD.state IN ('PAID','REFUNDED') THEN RAISE EXCEPTION 'Settled rounds are immutable'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='OPEN' AND NEW.state IN ('LOCKED','DRAWN')) OR
   (OLD.state='LOCKED' AND NEW.state='DRAWN') OR (OLD.state='DRAWN' AND NEW.state IN ('PAID','REFUNDED')))
 THEN RAISE EXCEPTION 'Invalid group round transition'; END IF;
 IF OLD.locked_entry_ids IS NOT NULL AND (NEW.locked_entry_ids,NEW.roster_hash,NEW.locked_at)
   IS DISTINCT FROM (OLD.locked_entry_ids,OLD.roster_hash,OLD.locked_at) THEN RAISE EXCEPTION 'Locked roster cannot change'; END IF;
 IF OLD.locked_entry_ids IS NULL AND NEW.locked_entry_ids IS NOT NULL THEN
   SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::text[]) INTO accepted
    FROM public.play_together_entries WHERE round_id=OLD.id AND state='ACCEPTED';
   IF NEW.locked_entry_ids IS DISTINCT FROM accepted OR NEW.locked_at IS NULL OR NEW.roster_hash IS NULL
     OR NEW.state NOT IN ('LOCKED','DRAWN') THEN RAISE EXCEPTION 'Locked roster must contain exactly the accepted entries'; END IF;
 END IF;
 IF NEW.state='LOCKED' AND (clock_timestamp()<NEW.closes_at OR cardinality(NEW.locked_entry_ids)<NEW.min_players)
 THEN RAISE EXCEPTION 'Round cannot lock early or underfunded'; END IF;
 IF OLD.outcome IS NOT NULL AND (NEW.outcome,NEW.proof,NEW.ranking)
   IS DISTINCT FROM (OLD.outcome,OLD.proof,OLD.ranking) THEN RAISE EXCEPTION 'Official group result cannot change'; END IF;
 IF OLD.void_reason IS NOT NULL AND NEW.void_reason IS DISTINCT FROM OLD.void_reason
 THEN RAISE EXCEPTION 'Refund reason cannot change'; END IF;
 IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND
   (OLD.state<>'LOCKED' OR NEW.state<>'DRAWN' OR NEW.ranking IS NULL OR NEW.void_reason IS NOT NULL)
 THEN RAISE EXCEPTION 'An outcome requires a locked round'; END IF;
 IF NEW.state='DRAWN' AND (NEW.locked_entry_ids IS NULL OR
   (NEW.outcome IS NULL AND NEW.void_reason IS NULL)) THEN RAISE EXCEPTION 'Round needs a result or refund reason'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER play_together_round_guard BEFORE INSERT OR UPDATE OR DELETE ON public.play_together_rounds FOR EACH ROW EXECUTE FUNCTION public.play_together_round_guard();
CREATE TRIGGER play_together_round_no_truncate BEFORE TRUNCATE ON public.play_together_rounds FOR EACH STATEMENT EXECUTE FUNCTION public.play_together_round_guard();

CREATE FUNCTION public.play_together_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.play_together_rounds%ROWTYPE; pick_count integer; lo integer; hi integer;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Group entries are permanent'; END IF;
 SELECT * INTO STRICT r FROM public.play_together_rounds WHERE id=NEW.round_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
   IF r.state<>'OPEN' OR clock_timestamp()>=r.closes_at OR NEW.state<>'ACCEPTED' OR NEW.amount<>r.entry_amount
     OR (SELECT count(*) FROM public.play_together_entries WHERE round_id=r.id AND state='ACCEPTED')>=r.max_players
   THEN RAISE EXCEPTION 'Round no longer accepts this entry'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=NEW.user_id AND status='ACTIVE')
     OR (r.group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.groups g JOIN public.group_members m ON m."groupId"=g.id
       WHERE g.id=r.group_id AND g.status='ACTIVE' AND g."expiresAt">clock_timestamp()
         AND m."userId"=NEW.user_id AND m.status IN ('ACTIVE','MUTED')))
   THEN RAISE EXCEPTION 'Account or group no longer admits this entry'; END IF;
   IF r.currency='ETB' THEN
     PERFORM 1 FROM public.platform_gates WHERE key IN ('GROUP_PLAY','CASINO_PLAY') ORDER BY key FOR SHARE;
     IF (SELECT count(*) FROM public.platform_gates WHERE key IN ('GROUP_PLAY','CASINO_PLAY') AND enabled)<>2
       OR NOT EXISTS(SELECT 1 FROM public.country_casino_policies WHERE id=NEW.policy_id AND version=NEW.policy_version AND state='ACTIVE' AND status='ENABLED')
     THEN RAISE EXCEPTION 'Cash group admission is disabled'; END IF;
   END IF;
   pick_count:=CASE WHEN r.game IN ('spin_win','dice') THEN 0 WHEN r.game IN ('turbo_keno','roulette_keno') THEN 5
     WHEN r.game IN ('lucky_six','blackjack') THEN 6 WHEN r.game='virtual_football_3d' THEN 3 ELSE 1 END;
   lo:=CASE WHEN r.game IN ('blackjack','virtual_football_3d') THEN 0 WHEN r.game IN ('sky_crash','crash_point') THEN 101 ELSE 1 END;
   hi:=CASE r.game WHEN 'turbo_keno' THEN 80 WHEN 'roulette_keno' THEN 72 WHEN 'lucky_six' THEN 48
     WHEN 'number_challenge' THEN 100 WHEN 'blackjack' THEN 2 WHEN 'virtual_football_3d' THEN 2
     WHEN 'sky_crash' THEN 2000 WHEN 'crash_point' THEN 2000 ELSE 8 END;
   IF jsonb_array_length(NEW.selection)<>pick_count OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.selection) v
     WHERE jsonb_typeof(v)<>'number' OR v::text !~ '^[0-9]+$' OR (v::text)::integer NOT BETWEEN lo AND hi)
     OR (r.game NOT IN ('blackjack','virtual_football_3d') AND (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.selection) v)<>pick_count)
   THEN RAISE EXCEPTION 'Invalid group selection'; END IF;
 ELSE
   IF (to_jsonb(NEW)-ARRAY['state','close_operation_id','prize_operation_id','payout_transaction_id','payout','closed_at'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','close_operation_id','prize_operation_id','payout_transaction_id','payout','closed_at'])
     OR OLD.state<>'ACCEPTED' OR NEW.state NOT IN ('REFUNDED','SETTLED')
   THEN RAISE EXCEPTION 'Accepted entry terms and completed payments are immutable'; END IF;
   IF NOT ((r.state='OPEN' AND clock_timestamp()<r.closes_at AND NEW.state='REFUNDED') OR r.state='DRAWN')
   THEN RAISE EXCEPTION 'Entry cannot change after betting closes'; END IF;
 END IF;
 IF (r.currency='ETB') IS DISTINCT FROM (NEW.hold_operation_id IS NOT NULL AND NEW.policy_id IS NOT NULL AND NEW.policy_version IS NOT NULL)
 THEN RAISE EXCEPTION 'Cash entry requires a pinned funding operation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER play_together_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.play_together_entries FOR EACH ROW EXECUTE FUNCTION public.play_together_entry_guard();
CREATE TRIGGER play_together_entry_no_truncate BEFORE TRUNCATE ON public.play_together_entries FOR EACH STATEMENT EXECUTE FUNCTION public.play_together_entry_guard();
CREATE TRIGGER play_together_policy_immutable BEFORE UPDATE OR DELETE ON public.play_together_policies FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();
CREATE TRIGGER play_together_policy_no_truncate BEFORE TRUNCATE ON public.play_together_policies FOR EACH STATEMENT EXECUTE FUNCTION public.financial_history_append_only();
CREATE TRIGGER play_together_request_immutable BEFORE UPDATE OR DELETE ON public.play_together_requests FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();
CREATE TRIGGER play_together_request_no_truncate BEFORE TRUNCATE ON public.play_together_requests FOR EACH STATEMENT EXECUTE FUNCTION public.financial_history_append_only();

-- Extend exact ledger shapes. Existing ledger guards are retained in full.
DO $extend$ DECLARE def text; original text; BEGIN
 SELECT pg_get_functiondef('public.coin_lot_entry_validate()'::regprocedure) INTO def;
 original:=def;
 def:=replace(def, $$'SPORTS_CREDIT'$$, $$'SPORTS_CREDIT','TOGETHER_PRIZE'$$);
 def:=replace(def, $$'SCHEDULED_STAKE_HOLD'$$, $$'SCHEDULED_STAKE_HOLD','TOGETHER_HOLD'$$);
 def:=replace(def, $$op."type" = 'SCHEDULED_STAKE_REFUND'$$, $$op."type" IN ('SCHEDULED_STAKE_REFUND')$$);
 def:=replace(def, $$'SCHEDULED_STAKE_REFUND'$$, $$'SCHEDULED_STAKE_REFUND','TOGETHER_REFUND'$$);
 def:=replace(def, $$'WITHDRAWAL_FINALIZE','SCHEDULED_STAKE_SETTLE'$$, $$'WITHDRAWAL_FINALIZE','SCHEDULED_STAKE_SETTLE','TOGETHER_SETTLE'$$);
 def:=replace(def, $$'WITHDRAWAL_FINALIZE', 'SCHEDULED_STAKE_SETTLE'$$, $$'WITHDRAWAL_FINALIZE', 'SCHEDULED_STAKE_SETTLE', 'TOGETHER_SETTLE'$$);
 IF def=original OR position('TOGETHER_SETTLE' IN def)=0 OR position('TOGETHER_REFUND' IN def)=0 OR position('TOGETHER_HOLD' IN def)=0
 THEN RAISE EXCEPTION 'Group ledger extension did not match the expected ledger'; END IF;
 EXECUTE def;
END $extend$;

CREATE FUNCTION public.play_together_funding_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.play_together_entries%ROWTYPE; r public.play_together_rounds%ROWTYPE;
 op public.economic_operations%ROWTYPE; wt public.wallet_transactions%ROWTYPE;
 opid text; kind text; expected bigint; n integer; value_a bigint; value_r bigint; source_id text;
BEGIN
 IF TG_TABLE_NAME='play_together_entries' THEN
   SELECT * INTO STRICT e FROM public.play_together_entries WHERE id=NEW.id;
 ELSE
   IF TG_TABLE_NAME='economic_operations' THEN op:=NEW;
   ELSE SELECT * INTO STRICT op FROM public.economic_operations WHERE id=NEW."operationId"; END IF;
   IF op.type::text NOT IN ('TOGETHER_HOLD','TOGETHER_REFUND','TOGETHER_SETTLE','TOGETHER_PRIZE') THEN RETURN NULL; END IF;
   SELECT * INTO e FROM public.play_together_entries WHERE id=op."scopeId";
   IF NOT FOUND OR op.id NOT IN (COALESCE(e.hold_operation_id,''),COALESCE(e.close_operation_id,''),COALESCE(e.prize_operation_id,''))
   THEN RAISE EXCEPTION 'Group operation has no accepted entry witness'; END IF;
 END IF;
 SELECT * INTO STRICT r FROM public.play_together_rounds WHERE id=e.round_id;
 SELECT * INTO STRICT wt FROM public.wallet_transactions WHERE id=e.hold_transaction_id;
 IF wt."userId"<>e.user_id OR wt.amount<>e.amount OR wt."ledgerType"<>'DEBIT' OR wt.status<>'SUCCEEDED'
   OR wt."referenceType" IS DISTINCT FROM 'GAME' OR wt."referenceId" IS DISTINCT FROM e.id OR wt.currency::text<>(CASE WHEN r.currency='ETB' THEN 'COINS' ELSE 'GAME_POINTS' END)
 THEN RAISE EXCEPTION 'Entry is not backed by its exact wallet debit'; END IF;
 IF e.payout>0 THEN
   SELECT * INTO STRICT wt FROM public.wallet_transactions WHERE id=e.payout_transaction_id;
   IF wt."userId"<>e.user_id OR wt.amount<>e.payout OR wt."ledgerType"<>'CREDIT' OR wt.status<>'SUCCEEDED'
     OR wt."referenceType" IS DISTINCT FROM 'GAME' OR wt."referenceId" IS DISTINCT FROM e.id OR wt.currency::text<>(CASE WHEN r.currency='ETB' THEN 'COINS' ELSE 'GAME_POINTS' END)
   THEN RAISE EXCEPTION 'Entry payout is not backed by its exact wallet credit'; END IF;
 END IF;
 IF e.state='REFUNDED' AND e.payout<>e.amount THEN RAISE EXCEPTION 'Refund must return the full entry'; END IF;
 IF r.currency<>'ETB' THEN
   IF e.hold_operation_id IS NOT NULL OR e.close_operation_id IS NOT NULL OR e.prize_operation_id IS NOT NULL
   THEN RAISE EXCEPTION 'Practice cannot create cash operations'; END IF;
   RETURN NULL;
 END IF;
 IF e.state<>'ACCEPTED' AND e.close_operation_id IS NULL THEN RAISE EXCEPTION 'Cash hold must close with a journal'; END IF;
 IF (e.state='SETTLED' AND e.payout>0) IS DISTINCT FROM (e.prize_operation_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Cash prize witness mismatch'; END IF;
 FOREACH kind IN ARRAY ARRAY['HOLD','CLOSE','PRIZE'] LOOP
   opid:=CASE kind WHEN 'HOLD' THEN e.hold_operation_id WHEN 'CLOSE' THEN e.close_operation_id ELSE e.prize_operation_id END;
   IF opid IS NULL THEN CONTINUE; END IF;
   SELECT * INTO STRICT op FROM public.economic_operations WHERE id=opid;
   IF op."userId"<>e.user_id OR op."scopeType"<>'PLAY_TOGETHER' OR op."scopeId"<>e.id
     OR op."countryPolicyId" IS DISTINCT FROM e.policy_id OR op."countryPolicyVersion" IS DISTINCT FROM e.policy_version
     OR op.type::text<>(CASE kind WHEN 'HOLD' THEN 'TOGETHER_HOLD' WHEN 'PRIZE' THEN 'TOGETHER_PRIZE'
        ELSE CASE WHEN e.state='REFUNDED' THEN 'TOGETHER_REFUND' ELSE 'TOGETHER_SETTLE' END END)
   THEN RAISE EXCEPTION 'Group operation terms differ from entry'; END IF;
   IF kind='HOLD' AND op."walletTransactionIds"<>ARRAY[e.hold_transaction_id] OR
      kind='PRIZE' AND op."walletTransactionIds"<>ARRAY[e.payout_transaction_id] OR
      kind='CLOSE' AND ((e.state='REFUNDED' AND op."walletTransactionIds"<>ARRAY[e.payout_transaction_id]) OR
                       (e.state='SETTLED' AND cardinality(op."walletTransactionIds")<>0))
   THEN RAISE EXCEPTION 'Group wallet journal mismatch'; END IF;
   IF kind='CLOSE' AND op."reversesOperationId" IS DISTINCT FROM e.hold_operation_id
   THEN RAISE EXCEPTION 'Group closure must reference the original hold'; END IF;
   SELECT count(*),COALESCE(sum("availableDelta"),0),COALESCE(sum("reservedDelta"),0)
     INTO n,value_a,value_r FROM public.coin_lot_entries WHERE "operationId"=opid;
   IF n=0 OR value_a<>(CASE kind WHEN 'HOLD' THEN -e.amount WHEN 'PRIZE' THEN e.payout ELSE CASE WHEN e.state='REFUNDED' THEN e.amount ELSE 0 END END)
     OR value_r<>(CASE kind WHEN 'HOLD' THEN e.amount WHEN 'PRIZE' THEN 0 ELSE -e.amount END)
   THEN RAISE EXCEPTION 'Group cash operation does not balance'; END IF;
   IF EXISTS(SELECT 1 FROM public.coin_lot_entries x JOIN public.coin_provenance p ON p.id=x."lotId"
     WHERE x."operationId"=opid AND (p."lotClass" IS DISTINCT FROM 'WITHDRAWABLE' OR p."userId"<>e.user_id OR x."userId"<>e.user_id
       OR x."obligationDelta"<>0 OR x."progressDelta"<>0
       OR x."entryType"::text<>CASE kind WHEN 'HOLD' THEN 'RESERVE' WHEN 'PRIZE' THEN 'MINT'
           ELSE CASE WHEN e.state='REFUNDED' THEN 'RELEASE' ELSE 'FINALIZE' END END
       OR (kind='CLOSE' AND NOT EXISTS(SELECT 1 FROM public.coin_lot_entries src
           WHERE src.id=x."reversesEntryId" AND src."operationId"=e.hold_operation_id AND src."lotId"=x."lotId"))
       OR (kind='PRIZE' AND (p."sourceOperationId" IS DISTINCT FROM opid OR p."walletTransactionId" IS DISTINCT FROM e.payout_transaction_id OR p.amount<>e.payout OR p."provenanceType"<>'GAME_WIN'))))
   THEN RAISE EXCEPTION 'Group funds must be backed by the original cash lots'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER play_together_entry_proof AFTER INSERT OR UPDATE ON public.play_together_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.play_together_funding_proof();
CREATE CONSTRAINT TRIGGER play_together_operation_proof AFTER INSERT ON public.economic_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.play_together_funding_proof();
CREATE CONSTRAINT TRIGGER play_together_lot_proof AFTER INSERT ON public.coin_lot_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.play_together_funding_proof();

CREATE FUNCTION public.play_together_pool_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.play_together_rounds%ROWTYPE; funded bigint; paid bigint; winners integer; n integer;
BEGIN
 IF TG_TABLE_NAME='play_together_entries' THEN SELECT * INTO STRICT r FROM public.play_together_rounds WHERE id=NEW.round_id;
 ELSE SELECT * INTO STRICT r FROM public.play_together_rounds WHERE id=NEW.id; END IF;
 IF r.state NOT IN ('PAID','REFUNDED') THEN
   IF EXISTS(SELECT 1 FROM public.play_together_entries WHERE round_id=r.id AND
     (state='SETTLED' OR (state='REFUNDED' AND id=ANY(r.locked_entry_ids))))
   THEN RAISE EXCEPTION 'A completed payment requires its completed round'; END IF;
   RETURN NULL;
 END IF;
 SELECT COALESCE(sum(amount),0),COALESCE(sum(payout),0),count(*) FILTER(WHERE payout>0),count(*)
 INTO funded,paid,winners,n FROM public.play_together_entries WHERE id=ANY(r.locked_entry_ids) AND round_id=r.id;
 IF n<>cardinality(r.locked_entry_ids) OR EXISTS(SELECT 1 FROM public.play_together_entries WHERE round_id=r.id AND state='ACCEPTED')
   OR r.funded<>funded OR paid+r.platform_fee<>funded OR (r.settlement->>'funded')::bigint IS DISTINCT FROM funded
   OR (r.settlement->>'platformFee')::bigint IS DISTINCT FROM r.platform_fee
   OR (r.settlement->>'feeBps')::integer IS DISTINCT FROM r.fee_bps
   OR (r.settlement->>'refunds')::boolean IS DISTINCT FROM (r.state='REFUNDED')
   OR (r.settlement->>'winnerCount')::integer IS DISTINCT FROM (CASE WHEN r.state='REFUNDED' THEN 0 ELSE winners END)
 THEN RAISE EXCEPTION 'Group settlement fails fund conservation'; END IF;
 IF jsonb_typeof(r.settlement->'payouts') IS DISTINCT FROM 'array'
   OR jsonb_array_length(r.settlement->'payouts')<>n
   OR (SELECT count(DISTINCT p->>'entryId') FROM jsonb_array_elements(r.settlement->'payouts') p)<>n
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.settlement->'payouts') p
     LEFT JOIN public.play_together_entries e ON e.id=p->>'entryId' AND e.round_id=r.id AND e.id=ANY(r.locked_entry_ids)
     WHERE e.id IS NULL OR (p->>'amount')::integer IS DISTINCT FROM e.payout
       OR (p->>'profit')::integer IS DISTINCT FROM e.payout-e.amount)
 THEN RAISE EXCEPTION 'Group receipt must match every actual payout'; END IF;
 IF r.state='REFUNDED' THEN
   IF r.platform_fee<>0 OR EXISTS(SELECT 1 FROM public.play_together_entries WHERE id=ANY(r.locked_entry_ids) AND (state<>'REFUNDED' OR payout<>amount))
   THEN RAISE EXCEPTION 'Voided round must refund every entry without fees'; END IF;
 ELSE
   IF r.outcome IS NULL OR r.proof IS NULL OR n<r.min_players OR winners<1 OR winners=n
     OR r.platform_fee<>((funded-winners*r.entry_amount)*r.fee_bps/10000)
     OR EXISTS(SELECT 1 FROM public.play_together_entries WHERE id=ANY(r.locked_entry_ids) AND
       (state<>'SETTLED' OR (payout>0 AND (payout<amount OR payout NOT BETWEEN paid/winners AND (paid+winners-1)/winners))))
   THEN RAISE EXCEPTION 'Group prize or profit fee is invalid'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER play_together_round_pool_proof AFTER UPDATE ON public.play_together_rounds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.play_together_pool_proof();
CREATE CONSTRAINT TRIGGER play_together_entry_pool_proof AFTER INSERT OR UPDATE ON public.play_together_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.play_together_pool_proof();

REVOKE ALL ON public.play_together_rounds,public.play_together_entries,public.play_together_requests,public.play_together_policies FROM PUBLIC;
ALTER FUNCTION public.ledger_apply_runtime_grants(text) RENAME TO ledger_apply_runtime_grants_pre_together;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_together(runtime_role);
 EXECUTE format('REVOKE ALL ON public.play_together_rounds,public.play_together_entries,public.play_together_requests,public.play_together_policies FROM %I',runtime_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.play_together_rounds,public.play_together_entries,public.play_together_requests,public.play_together_policies TO %I',runtime_role);
 EXECUTE format('GRANT UPDATE(state,locked_at,locked_entry_ids,roster_hash,outcome,proof,ranking,void_reason,settlement,funded,platform_fee,paid_at,retry_after) ON public.play_together_rounds TO %I',runtime_role);
 EXECUTE format('GRANT UPDATE(state,close_operation_id,prize_operation_id,payout_transaction_id,payout,closed_at) ON public.play_together_entries TO %I',runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text),public.ledger_apply_runtime_grants_pre_together(text),
 public.play_together_round_guard(),public.play_together_entry_guard(),public.play_together_funding_proof(),public.play_together_pool_proof() FROM PUBLIC;
COMMIT;
