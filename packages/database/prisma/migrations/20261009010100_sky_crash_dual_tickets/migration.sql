-- Additive practice-only release. Existing tickets remain slot 1.
ALTER TABLE sky_crash_tickets ADD COLUMN slot integer NOT NULL DEFAULT 1 CHECK (slot IN (1,2));
ALTER TABLE sky_crash_tickets DROP CONSTRAINT sky_crash_tickets_round_id_user_id_key;
ALTER TABLE sky_crash_tickets ADD CONSTRAINT sky_crash_ticket_slot UNIQUE(round_id,user_id,slot);
CREATE FUNCTION sky_crash_slot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.slot IS DISTINCT FROM OLD.slot THEN RAISE EXCEPTION 'Crash ticket slot is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crash_ticket_slot_guard BEFORE UPDATE ON sky_crash_tickets FOR EACH ROW EXECUTE FUNCTION sky_crash_slot_guard();
CREATE INDEX sky_crash_recent_returns ON sky_crash_tickets(settled_at DESC) WHERE payout > 0;
