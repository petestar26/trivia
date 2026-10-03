-- Game Points only. No Coin capability, catalog activation or runtime grants.
CREATE TABLE group_pvp_rounds (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  creator_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  game text NOT NULL CHECK (game IN ('spin_win','turbo_keno')),
  rules_id text NOT NULL CHECK (rules_id = 'group-pvp-points-v1'),
  policy_id text NOT NULL CHECK (policy_id = 'pvp-entry-fee7-v1'),
  entry_amount integer NOT NULL CHECK (entry_amount BETWEEN 100 AND 10000 AND entry_amount % 100 = 0),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','COUNTDOWN','DRAWN','SETTLED','VOID')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  starts_at timestamptz,
  outcome jsonb,
  void_reason text,
  settlement jsonb,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  UNIQUE (creator_id, request_id),
  CHECK ((state IN ('SETTLED','VOID')) = (settlement IS NOT NULL)),
  CHECK (state <> 'COUNTDOWN' OR starts_at IS NOT NULL),
  CHECK (state NOT IN ('DRAWN','SETTLED','VOID') OR outcome IS NOT NULL OR void_reason IS NOT NULL)
);
CREATE UNIQUE INDEX group_pvp_one_active ON group_pvp_rounds(group_id) WHERE state IN ('OPEN','COUNTDOWN','DRAWN');
CREATE INDEX group_pvp_recovery ON group_pvp_rounds(state, starts_at, expires_at);
CREATE TABLE group_pvp_entries (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES group_pvp_rounds(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  username text NOT NULL,
  state text NOT NULL DEFAULT 'JOINED' CHECK (state IN ('JOINED','READY','WITHDRAWN')),
  selection jsonb,
  debit_id text UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  refund_id text UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(round_id,user_id),
  CHECK (state <> 'READY' OR (selection IS NOT NULL AND debit_id IS NOT NULL)),
  CHECK (refund_id IS NULL OR (debit_id IS NOT NULL AND state = 'WITHDRAWN'))
);
CREATE FUNCTION group_pvp_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PVP history is immutable'; END IF;
  IF TG_TABLE_NAME = 'group_pvp_rounds' THEN
    IF OLD.state IN ('OPEN','COUNTDOWN','DRAWN') AND NEW.state=OLD.state
       AND (pg_catalog.to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'retry_at')
       AND NEW.retry_at >= OLD.retry_at THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.group_id,NEW.creator_id,NEW.request_id,NEW.game,NEW.rules_id,NEW.policy_id,NEW.entry_amount,NEW.created_at,NEW.expires_at)
       IS DISTINCT FROM (OLD.id,OLD.group_id,OLD.creator_id,OLD.request_id,OLD.game,OLD.rules_id,OLD.policy_id,OLD.entry_amount,OLD.created_at,OLD.expires_at)
       OR (OLD.state <> 'OPEN' AND NEW.starts_at IS DISTINCT FROM OLD.starts_at)
       OR (OLD.state IN ('DRAWN','SETTLED','VOID') AND (NEW.outcome,NEW.void_reason) IS DISTINCT FROM (OLD.outcome,OLD.void_reason))
       OR OLD.state IN ('SETTLED','VOID')
       OR NOT ((OLD.state = 'OPEN' AND NEW.state IN ('COUNTDOWN','DRAWN')) OR
               (OLD.state = 'COUNTDOWN' AND NEW.state = 'DRAWN') OR
               (OLD.state = 'DRAWN' AND NEW.state IN ('SETTLED','VOID'))) THEN
      RAISE EXCEPTION 'Invalid PVP round transition';
    END IF;
  ELSE
    IF (NEW.id,NEW.round_id,NEW.user_id,NEW.username,NEW.created_at) IS DISTINCT FROM
       (OLD.id,OLD.round_id,OLD.user_id,OLD.username,OLD.created_at)
       OR (OLD.debit_id IS NOT NULL AND (NEW.debit_id,NEW.selection) IS DISTINCT FROM (OLD.debit_id,OLD.selection))
       OR NOT ((OLD.state = 'JOINED' AND NEW.state IN ('READY','WITHDRAWN')) OR (OLD.state = 'READY' AND NEW.state = 'WITHDRAWN'))
       OR NOT EXISTS (SELECT 1 FROM public.group_pvp_rounds WHERE id=NEW.round_id AND state='OPEN') THEN
      RAISE EXCEPTION 'Invalid PVP entry transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_pvp_round_guard BEFORE UPDATE OR DELETE ON group_pvp_rounds FOR EACH ROW EXECUTE FUNCTION group_pvp_immutable();
CREATE TRIGGER group_pvp_entry_guard BEFORE UPDATE OR DELETE ON group_pvp_entries FOR EACH ROW EXECUTE FUNCTION group_pvp_immutable();
REVOKE ALL ON group_pvp_rounds, group_pvp_entries FROM PUBLIC;