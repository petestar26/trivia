-- Dormant owner-capital journal and capacity reservations. No player API.
BEGIN;
SET LOCAL lock_timeout = '20s';
CREATE TABLE public.house_capital_accounts (
  currency TEXT PRIMARY KEY CHECK (currency = 'COINS'),
  funded_amount BIGINT NOT NULL DEFAULT 0 CHECK (funded_amount >= 0),
  reserved_amount BIGINT NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0 AND reserved_amount <= funded_amount)
);
INSERT INTO public.house_capital_accounts(currency) VALUES ('COINS');
CREATE TABLE public.house_capital_fundings (
  external_reference TEXT PRIMARY KEY CHECK (external_reference ~ '^[A-Za-z0-9_:.-]{8,128}$'),
  amount BIGINT NOT NULL CHECK (amount > 0),
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.house_round_reservations (
  round_id TEXT PRIMARY KEY CHECK (round_id ~ '^[A-Za-z0-9_:-]{1,128}$'),
  stake_total BIGINT NOT NULL CHECK (stake_total > 0),
  payout_vector JSONB NOT NULL,
  draw_count INTEGER NOT NULL CHECK (draw_count BETWEEN 1 AND 20),
  max_gross_payout BIGINT NOT NULL CHECK (max_gross_payout > 0),
  reserved_loss BIGINT NOT NULL CHECK (reserved_loss >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
-- A runtime role cannot alter operator funds even if another setup later
-- grants it table DML. Truncate and deletion cannot remove the evidence.
CREATE FUNCTION public.house_capital_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE table_owner OID;
BEGIN
  SELECT c.relowner INTO table_owner FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=TG_TABLE_NAME;
  IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER) IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'operator capital is owner-only' USING ERRCODE='42501';
  END IF;
  IF TG_OP IN ('DELETE','TRUNCATE') OR (TG_TABLE_NAME <> 'house_capital_accounts' AND TG_OP='UPDATE') THEN
    RAISE EXCEPTION 'operator capital history is append-only';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN RAISE EXCEPTION 'capital currency is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER house_capital_account_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_capital_accounts
  FOR EACH ROW EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_funding_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_capital_fundings
  FOR EACH ROW EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_round_reservations
  FOR EACH ROW EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_capital_account_no_truncate BEFORE TRUNCATE ON public.house_capital_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_funding_no_truncate BEFORE TRUNCATE ON public.house_capital_fundings
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_capital_owner_guard();
CREATE TRIGGER house_reservation_no_truncate BEFORE TRUNCATE ON public.house_round_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_capital_owner_guard();

CREATE FUNCTION public.house_capital_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH sums AS (
    SELECT COALESCE((SELECT SUM(f.amount) FROM public.house_capital_fundings f),0) AS funded,
           COALESCE((SELECT SUM(r.reserved_loss) FROM public.house_round_reservations r),0) AS reserved
  )
  SELECT 'COINS'::TEXT FROM sums s LEFT JOIN public.house_capital_accounts a ON a.currency='COINS'
  WHERE a.currency IS NULL OR a.funded_amount IS DISTINCT FROM s.funded
    OR a.reserved_amount IS DISTINCT FROM s.reserved OR s.reserved > s.funded
  UNION
  SELECT r.round_id FROM public.house_round_reservations r WHERE
    pg_catalog.jsonb_typeof(r.payout_vector) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END) NOT BETWEEN 2 AND 100
    OR r.draw_count >= pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END)
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array'
      THEN r.payout_vector ELSE '[]'::JSONB END) v
      WHERE pg_catalog.jsonb_typeof(v.value) IS DISTINCT FROM 'number'
        OR v.value::TEXT !~ '^(0|[1-9][0-9]*)$'
        OR (v.value::TEXT)::NUMERIC > 9223372036854775807)
    OR r.max_gross_payout IS DISTINCT FROM (
      SELECT COALESCE(SUM(p.amount),0) FROM (
        SELECT (v.value#>>'{}')::NUMERIC AS amount FROM pg_catalog.jsonb_array_elements(
          CASE WHEN pg_catalog.jsonb_typeof(r.payout_vector)='array' THEN r.payout_vector ELSE '[]'::JSONB END
        ) v WHERE pg_catalog.jsonb_typeof(v.value)='number'
        ORDER BY amount DESC LIMIT r.draw_count) p)
    OR r.reserved_loss IS DISTINCT FROM greatest(r.max_gross_payout::NUMERIC-r.stake_total::NUMERIC,0)
$$;
CREATE FUNCTION public.house_capital_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE failure TEXT;
BEGIN
  SELECT f.id INTO failure FROM public.house_capital_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'operator capital proof mismatch: %',failure; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER house_capital_account_proof AFTER INSERT OR UPDATE ON public.house_capital_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_capital_constraint();
CREATE CONSTRAINT TRIGGER house_funding_proof AFTER INSERT ON public.house_capital_fundings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_capital_constraint();
CREATE CONSTRAINT TRIGGER house_reservation_proof AFTER INSERT ON public.house_round_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_capital_constraint();

-- The owner independently verifies the external receipt before calling this.
-- A reference/hash is an audit pointer, not proof that funds actually cleared.
CREATE FUNCTION public.house_record_capital_funding(ref TEXT, units BIGINT, digest TEXT)
RETURNS BIGINT LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE prior public.house_capital_fundings%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.house_capital_accounts WHERE currency='COINS' FOR UPDATE;
  IF units IS NULL OR units <= 0 OR digest !~ '^[a-f0-9]{64}$' OR ref !~ '^[A-Za-z0-9_:.-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid external funding evidence';
  END IF;
  SELECT * INTO prior FROM public.house_capital_fundings WHERE external_reference=ref;
  IF FOUND THEN
    IF prior.amount IS DISTINCT FROM units OR prior.evidence_sha256 IS DISTINCT FROM digest THEN
      RAISE EXCEPTION 'funding reference reused with different terms';
    END IF;
  ELSE
    INSERT INTO public.house_capital_fundings(external_reference,amount,evidence_sha256) VALUES(ref,units,digest);
    UPDATE public.house_capital_accounts SET funded_amount=funded_amount+units WHERE currency='COINS';
  END IF;
  -- Return the accepted entry, not a changing global balance, on replay.
  RETURN units;
END $$;
-- A serial account lock protects all concurrent round reservations. This
-- internal operation never authorizes a wager or releases an existing reserve.
CREATE FUNCTION public.house_reserve_round_loss(rid TEXT, stake BIGINT, vector JSONB, draws INT)
RETURNS BIGINT LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE account public.house_capital_accounts%ROWTYPE;
  prior public.house_round_reservations%ROWTYPE;
  gross NUMERIC; loss NUMERIC;
BEGIN
  SELECT * INTO STRICT account FROM public.house_capital_accounts WHERE currency='COINS' FOR UPDATE;
  SELECT * INTO prior FROM public.house_round_reservations WHERE round_id=rid;
  IF FOUND THEN
    IF prior.stake_total IS DISTINCT FROM stake OR prior.payout_vector IS DISTINCT FROM vector
      OR prior.draw_count IS DISTINCT FROM draws THEN
      RAISE EXCEPTION 'round reservation reused with different terms';
    END IF;
    RETURN prior.reserved_loss;
  END IF;
  IF rid IS NULL OR rid !~ '^[A-Za-z0-9_:-]{1,128}$' OR stake IS NULL OR stake <= 0
    OR pg_catalog.jsonb_typeof(vector) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(vector) NOT BETWEEN 2 AND 100
    OR draws IS NULL OR draws < 1 OR draws >= pg_catalog.jsonb_array_length(vector) OR draws > 20
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(vector) v
      WHERE pg_catalog.jsonb_typeof(v.value) IS DISTINCT FROM 'number'
        OR v.value::TEXT !~ '^(0|[1-9][0-9]*)$'
        OR (v.value::TEXT)::NUMERIC > 9223372036854775807) THEN
    RAISE EXCEPTION 'invalid round risk vector';
  END IF;
  SELECT SUM(v.amount) INTO gross FROM (
    SELECT (value#>>'{}')::NUMERIC AS amount FROM pg_catalog.jsonb_array_elements(vector)
    ORDER BY amount DESC LIMIT draws) v;
  loss:=greatest(gross-stake::NUMERIC,0);
  IF gross > 9223372036854775807 OR loss > 9223372036854775807
    OR account.reserved_amount::NUMERIC+loss > account.funded_amount THEN
    RAISE EXCEPTION 'operator capital capacity exhausted';
  END IF;
  INSERT INTO public.house_round_reservations(round_id,stake_total,payout_vector,draw_count,max_gross_payout,reserved_loss)
    VALUES(rid,stake,vector,draws,gross::BIGINT,loss::BIGINT);
  UPDATE public.house_capital_accounts SET reserved_amount=reserved_amount+loss::BIGINT WHERE currency='COINS';
  RETURN loss::BIGINT;
END $$;
REVOKE ALL ON public.house_capital_accounts, public.house_capital_fundings,
  public.house_round_reservations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.house_capital_owner_guard(),public.house_capital_constraint(),
  public.house_record_capital_funding(TEXT,BIGINT,TEXT),public.house_reserve_round_loss(TEXT,BIGINT,JSONB,INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.house_capital_failures()) THEN
    RAISE EXCEPTION 'initial house capital proof mismatch';
  END IF;
END $$;

-- The preceding migration installed the current grants function. Install a
-- forward definition so every future runtime setup preserves owner-only DML.
CREATE OR REPLACE FUNCTION "ledger_apply_runtime_grants"(runtime_role TEXT)
RETURNS void AS $$
DECLARE
  -- Named, not current_schema(): with the fixed search path that is pg_catalog.
  schema_name TEXT := 'public';
  t TEXT;
  updatable_user_columns TEXT;
  updatable_columns TEXT;
  trusted TEXT;
  holders TEXT;
  planted TEXT;
  foreign_owned TEXT;
  creators TEXT;
  key_holders TEXT;
  acting TEXT;
  tables_owner OID := (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', schema_name, 'economic_operations')));
  runtime_oid OID := (SELECT r.oid FROM pg_roles r WHERE r.rolname = runtime_role);
  -- Every role the runtime role is, can become or inherits the privileges of.
  reach OID[];
  -- Those whose grants it holds (has_*_privilege): itself, every role it can
  -- become, and every role it inherits from in its own right, but a
  -- superuser it only inherits from. has_*_privilege reports every privilege
  -- for a superuser, whose bypass is not inherited; what such a role is
  -- granted explicitly, the runtime role inherits, and has_*_privilege
  -- reports it for the runtime role itself.
  subjects OID[];
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role % does not exist', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role % must be neither a superuser nor exempt from row security', runtime_role;
  END IF;
  reach := ARRAY(SELECT x.role_id FROM public.ledger_role_reach(runtime_oid) x);
  subjects := ARRAY(SELECT x.role_id FROM public.ledger_role_reach(runtime_oid) x JOIN pg_roles r ON r.oid = x.role_id
                    WHERE x.assumable OR (x.via_id = runtime_oid AND NOT r.rolsuper));
  -- Nor may it become a role that acts beyond any grant, as the setup script
  -- refuses too: attributes apply after SET ROLE, and are never inherited. A
  -- role allowed to create roles could, before PostgreSQL 16, grant itself
  -- any role but a superuser, the tables' owner included (from 16 it holds
  -- ADMIN OPTION only on the roles it created, which ledger_role_reach follows).
  SELECT string_agg(format('%s (%s)', r.rolname, concat_ws(', ',
           CASE WHEN r.rolsuper THEN 'a superuser' END, CASE WHEN r.rolbypassrls THEN 'exempt from row security' END,
           CASE WHEN r.rolcreaterole THEN 'allowed to create roles' END, CASE WHEN r.rolreplication THEN 'allowed to replicate' END)),
           ', ' ORDER BY r.rolname)
    INTO acting
  FROM public.ledger_role_reach(runtime_oid) x JOIN pg_roles r ON r.oid = x.role_id
  WHERE x.assumable AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication);
  IF acting IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s is, or can become, a role that acts beyond its grants: %s. Revoke that membership (or that attribute) as its grantor, then run this again',
        runtime_role, acting);
  END IF;
  -- The owner's privileges come with its ownership, by SET ROLE or by
  -- inheritance alike; a membership that grants neither gives nothing.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
             WHERE n.nspname = schema_name AND r.rolname = runtime_role)
     OR tables_owner = ANY (reach) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s must neither own, nor be able to become or inherit the privileges of, the owner of the schema''s tables', runtime_role);
  END IF;
  -- The approval functions run as the owner and resolve names in pg_catalog,
  -- this schema and pgcrypto's; other functions that run as the owner resolve
  -- names in this schema. A role that could create objects in any of them
  -- could plant a function or operator there that runs with the owner's
  -- privileges, so the runtime role may create nothing in them: not directly,
  -- not through PUBLIC, not as or through any role it can become or inherits
  -- from (the schema's owner included), and it may own nothing in them that
  -- it could have planted before, nor may any such role. What the owner can revoke is
  -- revoked; anything else stops here (SQLSTATE 42501), changing nothing.
  FOR trusted IN
    SELECT DISTINCT s FROM unnest(ARRAY['pg_catalog', schema_name,
      (SELECT n.nspname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto')]) AS s
    WHERE s IS NOT NULL
  LOOP
    IF trusted <> 'pg_catalog' THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', trusted);
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', trusted, runtime_role);
    END IF;
    SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname::text END, ', ')
      INTO holders
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE n.nspname = trusted AND a.privilege_type = 'CREATE'
      AND (a.grantee = 0 OR a.grantee = ANY (reach));
    -- The owner's CREATE is implicit (not in the ACL) and has_schema_privilege
    -- ignores a membership usable only by SET ROLE: check the owner directly.
    IF holders IS NULL AND (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = trusted) = ANY (reach) THEN
      SELECT r.rolname::text INTO holders FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = trusted;
    END IF;
    IF holders IS NOT NULL OR has_schema_privilege(runtime_role, trusted, 'CREATE') THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s can still create objects in schema %s, through %s: functions that run as the owner resolve names there. Revoke that CREATE privilege (or that membership) as its grantor, then run this again',
          runtime_role, trusted, COALESCE(holders, runtime_role));
    END IF;
    -- Nor may any other role outside the owner's trust still create there.
    -- A role is inside it when it can become a superuser or the tables' owner
    -- (ledger_role_is_trusted): nothing it creates gives it more than it has.
    -- A membership in the owner that grants neither SET nor usable ADMIN
    -- OPTION does not bring a role inside, nor does one that grants INHERIT
    -- alone: the owner's attributes stay behind. Any other role -
    -- another application's, an operator's, a retired account - could create
    -- after this setup what a retired role left before it: an exact-type
    -- overload or operator that code running as the owner (migrations, the
    -- preflight and scans, every function pinned to this schema, a cascade
    -- from a key the runtime role changes) would pick. CREATE comes from the
    -- schema's ACL (PUBLIC included) or its ownership, and reaches every role
    -- that can become its holder or inherits from it (ledger_role_reach). The
    -- setup revokes only its own grants (PUBLIC's and the runtime role's,
    -- above): anyone else's it names, and stops. (pg_has_role MEMBER follows
    -- every membership: a cheap first filter, checked in order.)
    SELECT left(string_agg(DISTINCT u.rolname::text || ' (through '
             || CASE WHEN src.holder = 0 THEN 'PUBLIC' ELSE src.holder::regrole::text END || ')', ', '), 2000)
      INTO creators
    FROM pg_namespace n
    CROSS JOIN LATERAL (
      SELECT a.grantee AS holder FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE a.privilege_type = 'CREATE'
      UNION SELECT n.nspowner) src
    JOIN pg_roles u ON u.rolname !~ '^pg_' AND CASE
      WHEN src.holder <> 0 AND NOT pg_has_role(u.oid, src.holder, 'MEMBER') THEN false
      WHEN src.holder <> 0 AND src.holder NOT IN (SELECT x.role_id FROM public.ledger_role_reach(u.oid) x) THEN false
      ELSE NOT public.ledger_role_is_trusted(u.oid, tables_owner) END
    WHERE n.nspname = trusted;
    IF creators IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('roles outside the owner''s trust can still create objects in schema %s: %s. Code that runs as the owner resolves names there; revoke that CREATE privilege (or that membership) as its grantor, or make the role one that can act as the tables'' owner %s, then run this again',
          trusted, creators, tables_owner::regrole::text);
    END IF;
    -- Nor may anything there belong to such a role, or to the runtime role
    -- (or a role it can become or inherits from, which can replace it): what
    -- it created while it could (an exact-type overload of a built-in, an
    -- operator on the ledger's types) sits where the same code resolves
    -- names. Trust is decided once for each owner.
    WITH objects AS MATERIALIZED (
      SELECT o.kind, o.name, o.owner FROM (
        SELECT 'function' AS kind, p.oid::regprocedure::text AS name, p.proowner AS owner, p.pronamespace AS ns FROM pg_proc p
        UNION ALL SELECT 'operator', o.oid::regoperator::text, o.oprowner, o.oprnamespace FROM pg_operator o
        UNION ALL SELECT 'type', t.oid::regtype::text, t.typowner, t.typnamespace FROM pg_type t
        UNION ALL SELECT 'relation', c.oid::regclass::text, c.relowner, c.relnamespace FROM pg_class c
        UNION ALL SELECT 'collation', co.collname::text, co.collowner, co.collnamespace FROM pg_collation co
        UNION ALL SELECT 'conversion', cv.conname::text, cv.conowner, cv.connamespace FROM pg_conversion cv
        UNION ALL SELECT 'operator class', oc.opcname::text, oc.opcowner, oc.opcnamespace FROM pg_opclass oc
        UNION ALL SELECT 'operator family', fam.opfname::text, fam.opfowner, fam.opfnamespace FROM pg_opfamily fam
        UNION ALL SELECT 'text search configuration', tc.cfgname::text, tc.cfgowner, tc.cfgnamespace FROM pg_ts_config tc
        UNION ALL SELECT 'text search dictionary', td.dictname::text, td.dictowner, td.dictnamespace FROM pg_ts_dict td
      ) o JOIN pg_namespace n ON n.oid = o.ns WHERE n.nspname = trusted),
    trust AS MATERIALIZED (
      SELECT r.oid, r.rolname, public.ledger_role_is_trusted(r.oid, tables_owner) AS is_trusted
      FROM pg_roles r WHERE r.oid IN (SELECT owner FROM objects))
    SELECT string_agg(DISTINCT o.kind || ' ' || o.name, ', ') FILTER (WHERE o.owner = ANY (reach)),
           left(string_agg(DISTINCT o.kind || ' ' || o.name || ' (owner ' || u.rolname::text || ')', ', ')
                  FILTER (WHERE NOT u.is_trusted), 2000)
      INTO planted, foreign_owned
    FROM objects o JOIN trust u ON u.oid = o.owner;
    IF planted IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s owns objects in schema %s: %s. Functions that run as the owner could pick them up; check what they are, drop them (or reassign them to the owner), then run this again',
          runtime_role, trusted, planted);
    END IF;
    IF foreign_owned IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('schema %s holds objects owned by roles that can act neither as a superuser nor as the tables'' owner %s: %s. Code that runs as the owner and resolves names there could pick them up; check what they are, drop them (or reassign them to the owner), then run this again',
          trusted, tables_owner::regrole::text, foreign_owned);
    END IF;
  END LOOP;

  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, runtime_role);

  -- Keys other tables follow by cascade: never changed by the runtime role.
  -- A cascade runs as the owner of the referencing table, and so do that
  -- table's triggers; the application never changes these keys (an id, a
  -- country code). So wherever a foreign key cascades or nulls on UPDATE,
  -- the runtime role may update every column of the referenced table but
  -- the referenced ones. (The table-level revokes below also remove these
  -- column grants where the runtime role updates nothing.)
  FOR t IN
    SELECT DISTINCT r.relname::text
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND n.nspname = schema_name
    ORDER BY 1
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass(format('%I.%I', schema_name, t)) AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd')
                        AND c.confrelid = a.attrelid AND a.attnum = ANY (c.confkey));
    EXECUTE format('REVOKE UPDATE ON %I.%I FROM %I', schema_name, t, runtime_role);
    IF updatable_columns IS NOT NULL THEN
      EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO %I', updatable_columns, schema_name, t, runtime_role);
    END IF;
  END LOOP;

  -- Append-only financial history and committed records: insert and read.
  FOREACH t IN ARRAY ARRAY['economic_operations', 'coin_lot_entries', 'wallet_transactions',
                           'agent_order_settlements', 'game_sessions'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Financial state is never deleted.
  FOREACH t IN ARRAY ARRAY['wallets', 'coin_provenance', 'coin_ledger_accounts'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Scheduled holds retain their immutable terms. Only the exact refund
  -- transition's two fields are writable; the row guard validates the pair.
  IF to_regclass(format('%I.scheduled_stake_holds', schema_name)) IS NOT NULL THEN
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a WHERE a.attrelid=to_regclass(format('%I.scheduled_stake_holds', schema_name))
      AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE UPDATE, DELETE ON %I.scheduled_stake_holds FROM %I', schema_name, runtime_role);
    EXECUTE format('REVOKE UPDATE (%s) ON %I.scheduled_stake_holds FROM %I', updatable_columns, schema_name, runtime_role);
    EXECUTE format('GRANT UPDATE (state, refund_operation_id) ON %I.scheduled_stake_holds TO %I', schema_name, runtime_role);
  END IF;

  -- Approvals and their signed assertions: only through the procedures.
  FOREACH t IN ARRAY ARRAY['admin_adjustment_approvals', 'ledger_approval_assertions'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
  END LOOP;
  -- Legacy reviews: the ledger opens them; they change only through the
  -- signed procedures.
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'legacy_balance_reviews', runtime_role);
  -- Immutable rules versions.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'game_rules', runtime_role);
  -- The signing key, and the migration history (which the preflight reads).
  EXECUTE format('REVOKE ALL ON %I.%I FROM %I', schema_name, 'ledger_approval_keys', runtime_role);
  IF to_regclass(format('%I.%I', schema_name, '_prisma_migrations')) IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, '_prisma_migrations', runtime_role);
  END IF;
  -- Users: inserted (users_privilege_guard admits only plain USER accounts
  -- from anyone but the owner), updated in every column but the id, the
  -- role and the status, never deleted.
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO updatable_user_columns
  FROM information_schema.columns c
  WHERE c.table_schema = schema_name AND c.table_name = 'users' AND c.column_name NOT IN ('id', 'role', 'status');
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'users', runtime_role);
  EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO %I', updatable_user_columns, schema_name, 'users', runtime_role);

  -- Nor through a role it can become or inherits from. has_column_privilege
  -- sees only what a role inherits: a membership usable by SET ROLE alone,
  -- directly or through other roles, still lets the runtime role become a
  -- role that changes these keys and start the cascade as it. So each of
  -- `subjects` must be unable to change them; a membership that grants
  -- neither INHERIT, SET nor usable ADMIN OPTION gives nothing. The setup does
  -- not change other roles' privileges: it names each and stops.
  SELECT left(string_agg(DISTINCT format('%s.%s through %s', c.confrelid::regclass::text, a.attname, m.rolname), ', '), 2000)
    INTO key_holders
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
  JOIN pg_roles m ON m.oid = ANY (subjects)
  WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND r.relnamespace = to_regnamespace(schema_name)
    AND has_column_privilege(m.oid, c.confrelid, a.attname::text, 'UPDATE');
  IF key_holders IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s can still change keys other tables follow by cascade, as a role it can become or inherits from: %s. A cascade, and the triggers it fires, run as the owner of the referencing table. Revoke that membership, or that role''s UPDATE on those columns, as its grantor, then run this again',
        runtime_role, key_holders);
  END IF;
  -- Operator capital is never customer runtime state. The broad table grant
  -- above must be narrowed after every runtime setup, including future runs.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.house_capital_accounts, %I.house_capital_fundings, %I.house_round_reservations FROM %I',
    schema_name, schema_name, schema_name, runtime_role);
  -- REVOKE on a table does not clear any earlier column-level grants.
  FOREACH t IN ARRAY ARRAY['house_capital_accounts', 'house_capital_fundings', 'house_round_reservations'] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO updatable_columns
    FROM pg_attribute a WHERE a.attrelid=to_regclass(format('%I.%I', schema_name, t))
      AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE INSERT (%s), UPDATE (%s) ON %I.%I FROM %I',
      updatable_columns, updatable_columns, schema_name, t, runtime_role);
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_apply_runtime_grants"(TEXT) FROM PUBLIC;
COMMIT;
