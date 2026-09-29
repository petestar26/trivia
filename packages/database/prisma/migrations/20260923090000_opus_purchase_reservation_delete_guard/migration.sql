-- AgentOrderSettlement.reservationId is a historical scalar reference, not a
-- foreign key. A consumed reservation backing a minted PURCHASE must survive.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "settled_agent_reservation_proof_immutable" ON "agent_reservations";
CREATE TRIGGER "settled_agent_reservation_proof_immutable"
BEFORE UPDATE OR DELETE ON "agent_reservations"
FOR EACH ROW EXECUTE FUNCTION "settled_agent_reservation_proof_immutable"();
