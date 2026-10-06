-- Additive practice-only release. Existing tickets remain slot 1.
ALTER TABLE crash_point_tickets ADD COLUMN slot integer NOT NULL DEFAULT 1 CHECK (slot IN (1,2));
ALTER TABLE crash_point_tickets DROP CONSTRAINT crash_point_tickets_round_id_user_id_key;
ALTER TABLE crash_point_tickets ADD CONSTRAINT crash_point_ticket_slot UNIQUE(round_id,user_id,slot);
CREATE FUNCTION crash_point_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.slot IS DISTINCT FROM OLD.slot THEN RAISE EXCEPTION 'Crash ticket slot is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crash_ticket_slot_guard BEFORE UPDATE ON crash_point_tickets FOR EACH ROW EXECUTE FUNCTION crash_point_slot_guard();
CREATE INDEX crash_point_recent_returns ON crash_point_tickets(settled_at DESC) WHERE payout > 0;
