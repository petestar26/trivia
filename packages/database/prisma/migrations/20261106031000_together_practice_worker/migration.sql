BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE public.together_practice_worker_roles(role_name name PRIMARY KEY);
REVOKE ALL ON public.together_practice_worker_roles FROM PUBLIC;
-- This read-only predicate retains the caller identity inside definer guards.
CREATE FUNCTION public.together_is_practice_worker() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.together_practice_worker_roles WHERE role_name=
  CASE WHEN current_setting('role')='none' THEN session_user ELSE current_setting('role')::name END)
$$;

CREATE FUNCTION public.together_practice_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT public.together_is_practice_worker() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='play_together_rounds' THEN
  IF NEW.currency<>'GAME_POINTS' THEN RAISE EXCEPTION 'Practice worker cannot process cash rounds'; END IF;
 ELSIF TG_TABLE_NAME='play_together_entries' THEN
  IF NOT EXISTS(SELECT 1 FROM public.play_together_rounds WHERE id=NEW.round_id AND currency='GAME_POINTS')
  THEN RAISE EXCEPTION 'Practice worker cannot process cash entries'; END IF;
 ELSIF TG_TABLE_NAME='wallet_transactions' THEN
  IF NEW.currency<>'GAME_POINTS' OR NEW."ledgerType"<>'CREDIT' OR NEW.type<>'GAME_POINT_CREDIT'
    OR NEW."referenceType"<>'GAME' OR NOT EXISTS(
      SELECT 1 FROM public.play_together_entries e JOIN public.play_together_rounds r ON r.id=e.round_id
      WHERE e.id=NEW."referenceId" AND e.user_id=NEW."userId" AND r.currency='GAME_POINTS' AND r.state='DRAWN')
  THEN RAISE EXCEPTION 'Practice worker only credits accepted shared-game obligations'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER together_practice_round_scope BEFORE UPDATE ON public.play_together_rounds FOR EACH ROW EXECUTE FUNCTION public.together_practice_write_guard();
CREATE TRIGGER together_practice_entry_scope BEFORE UPDATE ON public.play_together_entries FOR EACH ROW EXECUTE FUNCTION public.together_practice_write_guard();
CREATE TRIGGER together_practice_credit_scope BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.together_practice_write_guard();

CREATE FUNCTION public.together_practice_wallet_proof() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE credits bigint;
BEGIN
 IF NOT public.together_is_practice_worker() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='wallet_transactions' THEN
  IF NOT EXISTS(SELECT 1 FROM public.play_together_entries e JOIN public.play_together_rounds r ON r.id=e.round_id
    WHERE e.id=NEW."referenceId" AND e.user_id=NEW."userId" AND e.payout_transaction_id=NEW.id
      AND e.payout=NEW.amount AND e.state IN ('SETTLED','REFUNDED') AND r.currency='GAME_POINTS' AND r.state IN ('PAID','REFUNDED'))
  THEN RAISE EXCEPTION 'Practice credit requires its exact settled entry'; END IF;
 ELSE
  SELECT COALESCE(sum(amount),0) INTO credits FROM public.wallet_transactions
   WHERE "walletId"=NEW.id AND currency='GAME_POINTS' AND "ledgerType"='CREDIT'
     AND xmin::text::bigint=txid_current()%4294967296;
  IF NEW."coinsBalance"<>OLD."coinsBalance" OR NEW."gamePointsBalance"-OLD."gamePointsBalance"<>credits
  THEN RAISE EXCEPTION 'Practice wallet change requires exact current transaction credits'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER together_practice_wallet_witness AFTER UPDATE ON public.wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.together_practice_wallet_proof();
CREATE CONSTRAINT TRIGGER together_practice_credit_witness AFTER INSERT ON public.wallet_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.together_practice_wallet_proof();

CREATE FUNCTION public.together_stream_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Shared event history is permanent'; END IF;
 IF TG_TABLE_NAME='play_together_events' THEN
  IF (to_jsonb(NEW)-'delivered_at') IS DISTINCT FROM (to_jsonb(OLD)-'delivered_at') OR OLD.delivered_at IS NOT NULL
  THEN RAISE EXCEPTION 'Shared event sequence and schedule are immutable'; END IF;
 ELSE
  IF NEW.round_id<>OLD.round_id OR NEW.revision<OLD.revision OR NEW.sequence<OLD.sequence
  THEN RAISE EXCEPTION 'Shared revisions and sequences cannot go backwards'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER together_stream_guard BEFORE UPDATE OR DELETE ON public.play_together_streams FOR EACH ROW EXECUTE FUNCTION public.together_stream_guard();
CREATE TRIGGER together_event_guard BEFORE UPDATE OR DELETE ON public.play_together_events FOR EACH ROW EXECUTE FUNCTION public.together_stream_guard();
CREATE TRIGGER together_stream_no_truncate BEFORE TRUNCATE ON public.play_together_streams FOR EACH STATEMENT EXECUTE FUNCTION public.together_stream_guard();
CREATE TRIGGER together_event_no_truncate BEFORE TRUNCATE ON public.play_together_events FOR EACH STATEMENT EXECUTE FUNCTION public.together_stream_guard();

-- Owner-only provisioning of a distinct practice settlement identity. It gets
-- no cash writes, no account credentials, no admissions, and no payment jobs.
CREATE FUNCTION public.grant_together_practice_worker(worker_role text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF worker_role !~ '^salem_shared_round_worker(_[a-z0-9]+)?$' OR NOT EXISTS(
   SELECT 1 FROM pg_roles WHERE rolname=worker_role AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolinherit)
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=worker_role))
 THEN RAISE EXCEPTION 'Dedicated nonprivileged shared practice role required'; END IF;
 INSERT INTO public.together_practice_worker_roles VALUES(worker_role::name) ON CONFLICT DO NOTHING;
 EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',worker_role);
 EXECUTE format('GRANT SELECT(id,username,status),UPDATE("updatedAt") ON public.users TO %I',worker_role);
 EXECUTE format('GRANT SELECT(id,name,"ownerId",status,"expiresAt"),UPDATE("updatedAt") ON public.groups TO %I',worker_role);
 EXECUTE format('GRANT SELECT ON public.wallets,public.wallet_transactions,public.play_together_rounds,public.play_together_entries,public.play_together_policies,public.coin_ledger_accounts,public.coin_provenance,public.house_ticket_resolutions TO %I',worker_role);
 EXECUTE format('GRANT UPDATE("gamePointsBalance",version,"updatedAt") ON public.wallets TO %I',worker_role);
 EXECUTE format('GRANT INSERT ON public.wallet_transactions TO %I',worker_role);
 EXECUTE format('GRANT UPDATE(state,locked_at,locked_entry_ids,roster_hash,outcome,proof,ranking,void_reason,settlement,funded,platform_fee,paid_at,retry_after,presentation_starts_at,presentation_finishes_at,presentation_data) ON public.play_together_rounds TO %I',worker_role);
 EXECUTE format('GRANT UPDATE(state,close_operation_id,prize_operation_id,payout_transaction_id,payout,closed_at) ON public.play_together_entries TO %I',worker_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.play_together_streams,public.play_together_jobs,public.play_together_workers TO %I',worker_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.play_together_events TO %I',worker_role);
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.together_is_practice_worker() TO %I',worker_role);
END $$;
REVOKE ALL ON FUNCTION public.together_is_practice_worker(),public.together_practice_write_guard(),public.together_practice_wallet_proof(),public.together_stream_guard(),public.grant_together_practice_worker(text) FROM PUBLIC;
COMMIT;
