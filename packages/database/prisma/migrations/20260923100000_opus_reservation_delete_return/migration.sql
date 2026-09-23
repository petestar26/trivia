-- A BEFORE DELETE trigger must return OLD to permit an unrelated, unsettled
-- reservation deletion. Returning NEW (NULL) silently suppresses it.
CREATE OR REPLACE FUNCTION "settled_agent_reservation_proof_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_order_settlements" s WHERE s."reservationId" = OLD."id") THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'settled Agent reservation purchase proof cannot be deleted';
    END IF;
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'settled Agent reservation purchase proof is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
