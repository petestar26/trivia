BEGIN;
-- Historical receipts retain slot 1. Balance proof already sums every ticket.
ALTER TABLE system_keno_practice_tickets ADD COLUMN slot integer NOT NULL DEFAULT 1 CHECK(slot BETWEEN 1 AND 10);
ALTER TABLE system_keno_practice_tickets ADD CONSTRAINT system_keno_ticket_slot_unique UNIQUE(round_id,user_id,slot);
ALTER TABLE system_keno_practice_tickets DROP CONSTRAINT system_keno_practice_tickets_round_id_user_id_key;
CREATE FUNCTION system_keno_slot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.slot IS DISTINCT FROM OLD.slot THEN RAISE EXCEPTION 'Practice ticket slot is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER system_keno_slot_guard BEFORE UPDATE OF slot ON system_keno_practice_tickets FOR EACH ROW EXECUTE FUNCTION system_keno_slot_guard();
REVOKE ALL ON FUNCTION system_keno_slot_guard() FROM PUBLIC;
COMMIT;
