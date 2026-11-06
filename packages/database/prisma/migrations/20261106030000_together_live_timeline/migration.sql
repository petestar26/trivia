BEGIN;
SET LOCAL lock_timeout='5s';
-- Additive: historical receipts retain v1 terms, proof, and settlement behavior.
ALTER TABLE public.play_together_rounds
 ADD COLUMN presentation_version integer NOT NULL DEFAULT 1 CHECK(presentation_version IN (1,2)),
 ADD COLUMN presentation_duration_ms integer,
 ADD COLUMN presentation_starts_at timestamptz,
 ADD COLUMN presentation_finishes_at timestamptz,
 ADD COLUMN presentation_data jsonb,
 ADD CONSTRAINT together_versioned_timeline CHECK (
  (presentation_version=1 AND presentation_duration_ms IS NULL AND presentation_starts_at IS NULL
    AND presentation_finishes_at IS NULL AND presentation_data IS NULL) OR
  (presentation_version=2 AND presentation_duration_ms IS NOT NULL AND presentation_duration_ms BETWEEN 10000 AND 120000 AND
    ((outcome IS NULL AND presentation_starts_at IS NULL AND presentation_finishes_at IS NULL AND presentation_data IS NULL) OR
     (outcome IS NOT NULL AND presentation_starts_at IS NOT NULL AND presentation_finishes_at IS NOT NULL
       AND presentation_finishes_at=presentation_starts_at+presentation_duration_ms*interval '1 millisecond'
       AND presentation_data IS NOT NULL AND jsonb_typeof(presentation_data)='array'))));

CREATE TABLE public.play_together_streams (
 round_id text PRIMARY KEY REFERENCES public.play_together_rounds(id) ON DELETE RESTRICT,
 revision integer NOT NULL DEFAULT 0,
 sequence bigint NOT NULL DEFAULT 0
);
-- Payload-free invalidations: no secret result can leak through the outbox.
CREATE TABLE public.play_together_events (
 round_id text NOT NULL REFERENCES public.play_together_rounds(id) ON DELETE RESTRICT,
 sequence bigint NOT NULL,
 revision integer NOT NULL,
 available_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN ('changed','clock')),
 delivered_at timestamptz,
 PRIMARY KEY(round_id,sequence)
);
CREATE INDEX together_event_due ON public.play_together_events(available_at) WHERE delivered_at IS NULL;
CREATE TABLE public.play_together_jobs (
 round_id text PRIMARY KEY REFERENCES public.play_together_rounds(id) ON DELETE RESTRICT,
 lease_token text,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0,
 last_error_at timestamptz
);
CREATE TABLE public.play_together_workers (
 id text PRIMARY KEY,
 healthy_at timestamptz NOT NULL,
 processing integer NOT NULL DEFAULT 0
);
INSERT INTO public.play_together_jobs(round_id)
 SELECT id FROM public.play_together_rounds WHERE state IN ('OPEN','LOCKED','DRAWN');

CREATE OR REPLACE FUNCTION public.play_together_round_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE accepted text[]; p public.play_together_policies%ROWTYPE;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Group round history is permanent'; END IF;
 IF NEW.presentation_version=2 AND NEW.presentation_duration_ms IS DISTINCT FROM
   (CASE NEW.game WHEN 'spin_win' THEN 20000 WHEN 'turbo_keno' THEN 44000 WHEN 'dice' THEN 40000
    WHEN 'number_challenge' THEN 18000 WHEN 'roulette_keno' THEN 40000 WHEN 'lucky_six' THEN 72000
    WHEN 'thunder_derby_3d' THEN 45000 WHEN 'neon_hounds_3d' THEN 32000 WHEN 'virtual_football_3d' THEN 90000
    WHEN 'blackjack' THEN 54000 WHEN 'sky_crash' THEN 42000 WHEN 'crash_point' THEN 42000 END)
 THEN RAISE EXCEPTION 'Unsupported published game duration'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO STRICT p FROM public.play_together_policies WHERE version=NEW.policy_version;
   IF NEW.fee_bps<>p.fee_bps OR NEW.entry_amount NOT BETWEEN p.min_entry AND p.max_entry
     OR NOT NEW.game=ANY(p.enabled_games)
   THEN RAISE EXCEPTION 'New round must match its published platform policy'; END IF;
   IF NEW.state<>'OPEN' OR NEW.outcome IS NOT NULL OR NEW.locked_entry_ids IS NOT NULL
     OR NEW.settlement IS NOT NULL OR NEW.void_reason IS NOT NULL THEN RAISE EXCEPTION 'Round must begin open'; END IF;
   RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','locked_at','locked_entry_ids','roster_hash','outcome','proof','ranking','void_reason','settlement','funded','platform_fee','paid_at','retry_after','presentation_starts_at','presentation_finishes_at','presentation_data'])
   IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','locked_at','locked_entry_ids','roster_hash','outcome','proof','ranking','void_reason','settlement','funded','platform_fee','paid_at','retry_after','presentation_starts_at','presentation_finishes_at','presentation_data'])
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
 IF OLD.presentation_starts_at IS NOT NULL AND
   (NEW.presentation_starts_at,NEW.presentation_finishes_at,NEW.presentation_data)
   IS DISTINCT FROM (OLD.presentation_starts_at,OLD.presentation_finishes_at,OLD.presentation_data)
 THEN RAISE EXCEPTION 'Committed game timeline cannot change'; END IF;
 IF NEW.presentation_version=2 AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND
   (NEW.presentation_starts_at IS NULL OR NEW.presentation_starts_at<transaction_timestamp()+interval '5 seconds')
 THEN RAISE EXCEPTION 'Outcome and future game schedule must commit together'; END IF;
 IF NEW.presentation_version=2 AND NEW.outcome IS NOT NULL AND NEW.state IN ('PAID','REFUNDED')
   AND clock_timestamp()<NEW.presentation_finishes_at
 THEN RAISE EXCEPTION 'Game must finish before payment or outcome refund'; END IF;
 IF OLD.void_reason IS NOT NULL AND NEW.void_reason IS DISTINCT FROM OLD.void_reason
 THEN RAISE EXCEPTION 'Refund reason cannot change'; END IF;
 IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND
   (OLD.state<>'LOCKED' OR NEW.state<>'DRAWN' OR NEW.ranking IS NULL OR NEW.void_reason IS NOT NULL)
 THEN RAISE EXCEPTION 'An outcome requires a locked round'; END IF;
 IF NEW.state='DRAWN' AND (NEW.locked_entry_ids IS NULL OR
   (NEW.outcome IS NULL AND NEW.void_reason IS NULL)) THEN RAISE EXCEPTION 'Round needs a result or refund reason'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.play_together_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
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
   IF r.presentation_version=2 AND r.outcome IS NOT NULL AND clock_timestamp()<r.presentation_finishes_at
   THEN RAISE EXCEPTION 'Game must finish before closing any entry'; END IF;
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

CREATE FUNCTION public.together_record_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE rid text; rev integer; seq bigint; due timestamptz;
BEGIN
 IF TG_TABLE_NAME='play_together_rounds' THEN rid:=NEW.id; ELSE rid:=NEW.round_id; END IF;
 IF TG_TABLE_NAME='play_together_rounds' AND TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NULL; END IF;
 INSERT INTO public.play_together_streams(round_id) VALUES(rid) ON CONFLICT DO NOTHING;
 UPDATE public.play_together_streams SET revision=revision+1,sequence=sequence+1 WHERE round_id=rid
 RETURNING revision,sequence INTO rev,seq;
 INSERT INTO public.play_together_events VALUES(rid,seq,rev,clock_timestamp(),'changed',NULL);
 IF TG_TABLE_NAME='play_together_rounds' THEN
  IF TG_OP='INSERT' THEN INSERT INTO public.play_together_jobs(round_id) VALUES(rid); END IF;
  IF NEW.presentation_version=2 AND NEW.state='DRAWN' AND NEW.outcome IS NOT NULL THEN
   FOR due IN SELECT generate_series(NEW.presentation_starts_at,NEW.presentation_finishes_at,interval '1 second') LOOP
    seq:=seq+1;
    INSERT INTO public.play_together_events VALUES(rid,seq,rev,due,'clock',NULL);
   END LOOP;
   UPDATE public.play_together_streams SET sequence=seq WHERE round_id=rid;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER together_round_event AFTER INSERT OR UPDATE ON public.play_together_rounds FOR EACH ROW EXECUTE FUNCTION public.together_record_event();
CREATE TRIGGER together_entry_event AFTER INSERT OR UPDATE ON public.play_together_entries FOR EACH ROW EXECUTE FUNCTION public.together_record_event();

REVOKE ALL ON public.play_together_streams,public.play_together_events,public.play_together_jobs,public.play_together_workers FROM PUBLIC;
ALTER FUNCTION public.ledger_apply_runtime_grants(text) RENAME TO ledger_apply_runtime_grants_pre_together_live;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_together_live(runtime_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.play_together_streams,public.play_together_events,public.play_together_jobs,public.play_together_workers TO %I',runtime_role);
 EXECUTE format('GRANT UPDATE(presentation_starts_at,presentation_finishes_at,presentation_data) ON public.play_together_rounds TO %I',runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.together_record_event(),public.ledger_apply_runtime_grants(text),public.ledger_apply_runtime_grants_pre_together_live(text) FROM PUBLIC;
COMMIT;
