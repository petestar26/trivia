-- A payout cannot commit separately from its immutable ticket settlement.
-- Keep the earlier migrations unchanged; validate any existing rows before adding guards.
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM public.football_tickets t
  JOIN public.football_ticket_lines l ON l.ticket_id=t.id
  WHERE (t.total_return IS NULL) IS DISTINCT FROM (l.payout IS NULL)
 ) THEN
  RAISE EXCEPTION 'Football settlement must include ticket and every line';
 END IF;
END $$;

CREATE FUNCTION football_settlement_atomic() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE tid text; ticket_settled boolean;
BEGIN
 IF TG_TABLE_NAME='football_tickets' THEN tid:=NEW.id; ELSE tid:=NEW.ticket_id; END IF;
 SELECT total_return IS NOT NULL INTO ticket_settled FROM public.football_tickets WHERE id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Football ticket missing'; END IF;
 IF EXISTS (
  SELECT 1 FROM public.football_ticket_lines l
  WHERE l.ticket_id=tid AND (l.payout IS NOT NULL) IS DISTINCT FROM ticket_settled
 ) THEN
  RAISE EXCEPTION 'Football settlement must include ticket and every line';
 END IF;
 RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER football_settlement_atomic_t
AFTER INSERT OR UPDATE ON football_tickets DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION football_settlement_atomic();
CREATE CONSTRAINT TRIGGER football_settlement_atomic_l
AFTER INSERT OR UPDATE ON football_ticket_lines DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION football_settlement_atomic();
