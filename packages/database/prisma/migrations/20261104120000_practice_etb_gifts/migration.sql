BEGIN;
-- Isolated virtual ETB gift economy. No changes to financial wallets or historical gifts.
CREATE TABLE practice_etb_gift_catalog (
  id text PRIMARY KEY, name text NOT NULL, emoji text NOT NULL, description text NOT NULL,
  theme text NOT NULL CHECK (theme IN ('rose','amber','violet','sky','emerald','indigo')),
  face_value integer NOT NULL CHECK (face_value BETWEEN 500 AND 10000 AND face_value % 10 = 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO practice_etb_gift_catalog (id,name,emoji,description,theme,face_value) VALUES
 ('little-rose','Little Rose','🌹','A small thank-you that says a lot.','rose',500),
 ('coffee-break','Coffee Break','☕','A little warmth for someone’s day.','amber',750),
 ('golden-heart','Golden Heart','💛','For the people who make your group special.','amber',1000),
 ('lucky-star','Lucky Star','🌟','Celebrate a brilliant moment.','violet',2500),
 ('blue-diamond','Blue Diamond','💎','A bright token of appreciation.','sky',5000),
 ('royal-crown','Royal Crown','👑','Give someone their moment in the spotlight.','indigo',10000);

CREATE TABLE practice_etb_gift_items (
  id text PRIMARY KEY,
  catalog_id text NOT NULL REFERENCES practice_etb_gift_catalog(id) ON DELETE RESTRICT,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL, emoji text NOT NULL, theme text NOT NULL,
  face_value integer NOT NULL CHECK (face_value BETWEEN 500 AND 10000 AND face_value % 10 = 0),
  state text NOT NULL CHECK (state IN ('OWNED','CONVERTED')),
  version integer NOT NULL CHECK (version >= 0),
  latest_operation_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX practice_etb_gift_inventory ON practice_etb_gift_items(owner_id,state,acquired_at DESC,id DESC);
CREATE TABLE practice_etb_gift_operations (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('BUY','SEND','CONVERT')),
  item_id text NOT NULL REFERENCES practice_etb_gift_items(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  recipient_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 0),
  previous_operation_id text UNIQUE REFERENCES practice_etb_gift_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  amount integer NOT NULL CHECK (amount >= 0), fee integer NOT NULL CHECK (fee >= 0),
  group_id text REFERENCES groups(id) ON DELETE RESTRICT,
  message_id text UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  request jsonb NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,request_id), UNIQUE(item_id,version),
  CHECK ((kind='BUY' AND version=0 AND previous_operation_id IS NULL) OR
         (kind<>'BUY' AND version>0 AND previous_operation_id IS NOT NULL)),
  CHECK ((kind='SEND' AND amount=0 AND fee=0) OR
         (kind<>'SEND' AND amount>0)),
  CHECK ((kind='CONVERT' AND recipient_id=actor_id AND message_id IS NULL AND group_id IS NULL) OR
         (kind='SEND' AND group_id IS NOT NULL) OR (kind='BUY' AND (group_id IS NOT NULL OR actor_id=recipient_id))),
  CHECK ((kind='SEND' OR (kind='BUY' AND recipient_id<>actor_id)) = (message_id IS NOT NULL))
);
ALTER TABLE practice_etb_gift_items ADD CONSTRAINT practice_etb_gift_latest_operation
  FOREIGN KEY (latest_operation_id) REFERENCES practice_etb_gift_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION practice_etb_gift_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='practice_etb_gift_operations' THEN
    RAISE EXCEPTION 'Gift receipts cannot be changed or deleted';
  END IF;
  IF (NEW.id,NEW.catalog_id,NEW.name,NEW.emoji,NEW.theme,NEW.face_value,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.catalog_id,OLD.name,OLD.emoji,OLD.theme,OLD.face_value,OLD.created_at)
     OR OLD.state<>'OWNED' OR NEW.version<>OLD.version+1
     OR NEW.latest_operation_id=OLD.latest_operation_id THEN
    RAISE EXCEPTION 'Invalid gift ownership transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER practice_etb_gift_item_immutable BEFORE UPDATE OR DELETE ON practice_etb_gift_items
  FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_immutable();
CREATE TRIGGER practice_etb_gift_receipt_immutable BEFORE UPDATE OR DELETE ON practice_etb_gift_operations
  FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_immutable();

CREATE FUNCTION practice_etb_gift_validate() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE item public.practice_etb_gift_items%ROWTYPE;
        op public.practice_etb_gift_operations%ROWTYPE;
        previous public.practice_etb_gift_operations%ROWTYPE;

BEGIN
  IF TG_TABLE_NAME='practice_etb_gift_items' THEN
    SELECT * INTO item FROM public.practice_etb_gift_items WHERE id=NEW.id;
    SELECT * INTO op FROM public.practice_etb_gift_operations WHERE id=item.latest_operation_id;
    IF NOT FOUND OR op.item_id<>item.id OR op.version<>item.version OR op.recipient_id<>item.owner_id
       OR (op.kind='CONVERT')<>(item.state='CONVERTED') THEN
      RAISE EXCEPTION 'Gift ownership must match its latest receipt';
    END IF;
    RETURN NULL;
  END IF;
  op:=NEW;
  SELECT * INTO item FROM public.practice_etb_gift_items WHERE id=op.item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gift receipt requires an item'; END IF;
  IF item.latest_operation_id<>op.id OR item.version<>op.version OR item.owner_id<>op.recipient_id
     OR (item.state='CONVERTED')<>(op.kind='CONVERT') THEN
    RAISE EXCEPTION 'Gift receipt must atomically update ownership';
  END IF;
  IF op.kind='BUY' THEN
    IF op.amount<>item.face_value OR op.fee<>0 THEN RAISE EXCEPTION 'Gift purchase amount does not match'; END IF;
  ELSE
    SELECT * INTO previous FROM public.practice_etb_gift_operations WHERE id=op.previous_operation_id;
    IF NOT FOUND OR previous.item_id<>op.item_id OR previous.version<>op.version-1
       OR previous.kind='CONVERT' OR previous.recipient_id<>op.actor_id THEN
      RAISE EXCEPTION 'Gift action requires current ownership';
    END IF;
    IF op.kind='CONVERT' AND (op.fee<>item.face_value/10 OR op.amount<>item.face_value*9/10) THEN
      RAISE EXCEPTION 'Gift conversion must retain exactly ten percent';
    END IF;
    IF op.kind='SEND' AND op.actor_id=op.recipient_id THEN RAISE EXCEPTION 'Cannot send a gift to yourself'; END IF;
  END IF;
  IF op.message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages m WHERE m.id=op.message_id AND m."groupId"=op.group_id
      AND m."userId"=op.actor_id AND m.type::text='GIFT'
  ) THEN RAISE EXCEPTION 'Gift chat message does not match its receipt'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER practice_etb_gift_item_receipt AFTER INSERT OR UPDATE ON practice_etb_gift_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_validate();
CREATE CONSTRAINT TRIGGER practice_etb_gift_operation_receipt AFTER INSERT ON practice_etb_gift_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_validate();
REVOKE ALL ON practice_etb_gift_catalog,practice_etb_gift_items,practice_etb_gift_operations FROM PUBLIC;

CREATE TABLE practice_etb_gift_accounts (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 balance integer NOT NULL DEFAULT 10000 CHECK(balance >= 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION practice_etb_gift_balance_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor text; actual bigint; expected bigint;
BEGIN
 IF TG_TABLE_NAME='practice_etb_gift_accounts' THEN actor := NEW.user_id; ELSE actor := NEW.actor_id; END IF;
 SELECT balance INTO actual FROM public.practice_etb_gift_accounts WHERE user_id=actor;
 SELECT 10000+COALESCE(SUM(CASE kind WHEN 'BUY' THEN -amount WHEN 'CONVERT' THEN amount ELSE 0 END),0)
 INTO expected FROM public.practice_etb_gift_operations WHERE actor_id=actor;
 IF actual IS NULL OR actual<>expected THEN RAISE EXCEPTION 'Practice ETB balance must match immutable gift receipts'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER practice_etb_gift_account_proof AFTER INSERT OR UPDATE ON practice_etb_gift_accounts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_balance_proof();
CREATE CONSTRAINT TRIGGER practice_etb_gift_operation_balance AFTER INSERT ON practice_etb_gift_operations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_balance_proof();
CREATE FUNCTION practice_etb_gift_account_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Practice accounts cannot be deleted'; END IF;
 IF (NEW.user_id,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.created_at) THEN RAISE EXCEPTION 'Practice account identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER practice_etb_gift_account_identity BEFORE UPDATE OR DELETE ON practice_etb_gift_accounts
 FOR EACH ROW EXECUTE FUNCTION practice_etb_gift_account_identity();
REVOKE ALL ON practice_etb_gift_accounts FROM PUBLIC;

COMMIT;
