-- Retire new admission to the historical 7+/2x Coin Dice rules. Completed
-- sessions still replay before catalog checks; immutable rules/history stay intact.
UPDATE game_definitions SET "catalogStatus"='COMING_SOON', "isActive"=false WHERE key='dice';

-- Free, nonredeemable credits. No Coin/Game Point wallet, financial gate or rule activation.
CREATE TABLE system_dice_practice_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 1000 CHECK (balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE system_dice_practice_rounds (
  id text PRIMARY KEY,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  die1 smallint, die2 smallint,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  CHECK (closes_at=opens_at+interval '45 seconds' AND ends_at=opens_at+interval '60 seconds'),
  CHECK ((die1 IS NULL AND die2 IS NULL) OR (die1 IS NOT NULL AND die2 IS NOT NULL AND die1 BETWEEN 1 AND 6 AND die2 BETWEEN 1 AND 6))
);
CREATE INDEX system_dice_due ON system_dice_practice_rounds(closes_at) WHERE die1 IS NULL;
CREATE TABLE system_dice_practice_tickets (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES system_dice_practice_rounds(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES system_dice_practice_accounts(user_id) ON DELETE RESTRICT,
  stake integer NOT NULL CHECK (stake BETWEEN 35 AND 490 AND stake%35=0),
  payout integer CHECK (payout>=0),
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  UNIQUE(round_id,user_id)
);
CREATE FUNCTION system_dice_practice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE one smallint; two smallint; cutoff timestamptz; opened timestamptz;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dice practice history is immutable'; END IF;
  IF TG_TABLE_NAME='system_dice_practice_rounds' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.die1 IS NOT NULL THEN RAISE EXCEPTION 'New rounds must await their draw'; END IF;
      RETURN NEW;
    END IF;
    IF (pg_catalog.to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.opens_at,NEW.closes_at,NEW.ends_at) IS DISTINCT FROM (OLD.id,OLD.opens_at,OLD.closes_at,OLD.ends_at)
      OR OLD.die1 IS NOT NULL OR NEW.die1 IS NULL OR clock_timestamp()<OLD.closes_at THEN
      RAISE EXCEPTION 'Dice result is immutable and cannot draw before cutoff';
    END IF;
  ELSE
    SELECT die1,die2,closes_at,opens_at INTO one,two,cutoff,opened FROM public.system_dice_practice_rounds WHERE id=NEW.round_id;
    IF TG_OP='INSERT' THEN
      IF one IS NOT NULL OR clock_timestamp()<opened OR clock_timestamp()>=cutoff OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Dice admission is closed'; END IF;
      RETURN NEW;
    END IF;
    IF (pg_catalog.to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.round_id,NEW.user_id,NEW.stake) IS DISTINCT FROM (OLD.id,OLD.round_id,OLD.user_id,OLD.stake)
      OR OLD.payout IS NOT NULL OR NEW.payout IS NULL OR one IS NULL
      OR NEW.payout<>(CASE WHEN one+two>=7 THEN NEW.stake/35*54 ELSE 0 END) THEN
      RAISE EXCEPTION 'Dice ticket must use its immutable result and exact payout';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER system_dice_round_guard BEFORE INSERT OR UPDATE OR DELETE ON system_dice_practice_rounds FOR EACH ROW EXECUTE FUNCTION system_dice_practice_guard();
CREATE TRIGGER system_dice_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON system_dice_practice_tickets FOR EACH ROW EXECUTE FUNCTION system_dice_practice_guard();
CREATE FUNCTION system_dice_practice_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
  IF TG_TABLE_NAME='system_dice_practice_accounts' AND TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN
    RAISE EXCEPTION 'Dice practice account identity is immutable';
  END IF;
  SELECT balance INTO actual FROM public.system_dice_practice_accounts WHERE user_id=NEW.user_id;
  SELECT 1000+COALESCE(pg_catalog.sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.system_dice_practice_tickets WHERE user_id=NEW.user_id;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dice practice balance does not match tickets'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER system_dice_account_check AFTER INSERT OR UPDATE ON system_dice_practice_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_dice_practice_balance_check();
CREATE CONSTRAINT TRIGGER system_dice_ticket_check AFTER INSERT OR UPDATE ON system_dice_practice_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_dice_practice_balance_check();
REVOKE ALL ON system_dice_practice_accounts,system_dice_practice_rounds,system_dice_practice_tickets FROM PUBLIC;
