-- Internal financial rounds only. No public admission, draw, or settlement.
BEGIN;
SET LOCAL lock_timeout = '20s';
ALTER TABLE public.scheduled_game_streams DROP CONSTRAINT scheduled_game_streams_mode_check;
ALTER TABLE public.scheduled_game_streams ADD CONSTRAINT scheduled_game_streams_mode_check
  CHECK (mode IN ('PRACTICE','FINANCIAL'));
ALTER TABLE public.scheduled_game_rounds DROP CONSTRAINT scheduled_game_rounds_mode_check;
ALTER TABLE public.scheduled_game_rounds ADD CONSTRAINT scheduled_game_rounds_mode_check
  CHECK (mode IN ('PRACTICE','FINANCIAL'));

-- Runtime table grants must never allow creation/activation of a financial
-- stream or a financial round. Practice triggers still check schedule/time.
CREATE FUNCTION public.scheduled_financial_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE owner_oid OID;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.mode='FINANCIAL' OR (TG_OP='UPDATE' AND OLD.mode='FINANCIAL') THEN
    SELECT c.relowner INTO owner_oid FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID;
    IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER)
      IS DISTINCT FROM owner_oid THEN
      RAISE EXCEPTION 'financial rounds are owner-only' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_financial_stream_guard BEFORE INSERT OR UPDATE ON public.scheduled_game_streams
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_financial_owner_guard();
CREATE TRIGGER scheduled_financial_round_guard BEFORE INSERT OR UPDATE ON public.scheduled_game_rounds
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_financial_owner_guard();
REVOKE ALL ON FUNCTION public.scheduled_financial_owner_guard() FROM PUBLIC;

INSERT INTO public.platform_gates(key,enabled,"changedAt")
VALUES ('HOUSE_TICKET_ADMISSION',false,pg_catalog.clock_timestamp());

-- A financial hold cannot commit without the owner-booked, exactly matching
-- reserve. The runtime can create a hold but cannot write operator capital.
CREATE FUNCTION public.house_financial_hold_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT h.id FROM public.scheduled_stake_holds h
  JOIN public.economic_operations o ON o.id=h.hold_operation_id
  WHERE o.snapshot ? 'financialTicket' AND (
    h.state <> 'HELD' OR
    pg_catalog.jsonb_typeof(o.snapshot->'financialTicket') IS DISTINCT FROM 'object' OR
    NOT EXISTS (
      SELECT 1 FROM public.house_round_reservations r
      JOIN public.scheduled_game_rounds g ON g.id=o.snapshot->'financialTicket'->>'roundId'
      WHERE r.round_id='ticket:'||h.id AND r.stake_total=h.amount
        AND r.payout_vector=o.snapshot->'financialTicket'->'payouts'
        AND g.mode='FINANCIAL' AND g.game_key=h.game_key AND g.rules_id=h.rules_id
    )
  )
  UNION
  SELECT r.round_id FROM public.house_round_reservations r
  WHERE r.round_id LIKE 'ticket:%' AND NOT EXISTS (
    SELECT 1 FROM public.scheduled_stake_holds h
    JOIN public.economic_operations o ON o.id=h.hold_operation_id
    WHERE r.round_id='ticket:'||h.id AND h.state='HELD' AND h.amount=r.stake_total
      AND r.payout_vector=o.snapshot->'financialTicket'->'payouts'
  )
$$;
CREATE FUNCTION public.house_financial_hold_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE failure TEXT;
BEGIN
  SELECT f.id INTO failure FROM public.house_financial_hold_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'financial hold/reserve proof mismatch: %', failure; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER house_financial_hold_proof AFTER INSERT OR UPDATE ON public.scheduled_stake_holds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_financial_hold_constraint();
CREATE CONSTRAINT TRIGGER house_financial_reserve_proof AFTER INSERT ON public.house_round_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_financial_hold_constraint();
REVOKE ALL ON FUNCTION public.house_financial_hold_failures(),public.house_financial_hold_constraint() FROM PUBLIC;
COMMIT;
