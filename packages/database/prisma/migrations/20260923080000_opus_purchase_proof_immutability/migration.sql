-- Once a purchase mints withdrawable Coins, its settlement witness must not
-- disappear or be rewritten. Corrections belong in the append-only ledger.
CREATE TRIGGER "agent_order_settlements_append_only"
BEFORE UPDATE OR DELETE ON "agent_order_settlements"
FOR EACH ROW EXECUTE FUNCTION "financial_history_append_only"();

CREATE OR REPLACE FUNCTION "settled_agent_order_proof_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_order_settlements" s WHERE s."orderId" = OLD."id")
     AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'settled Agent order purchase proof is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settled_agent_order_proof_immutable"
BEFORE UPDATE ON "agent_orders"
FOR EACH ROW EXECUTE FUNCTION "settled_agent_order_proof_immutable"();

CREATE OR REPLACE FUNCTION "settled_agent_reservation_proof_immutable"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_order_settlements" s WHERE s."reservationId" = OLD."id")
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'settled Agent reservation purchase proof is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "settled_agent_reservation_proof_immutable"
BEFORE UPDATE ON "agent_reservations"
FOR EACH ROW EXECUTE FUNCTION "settled_agent_reservation_proof_immutable"();
