-- Forward correction: refundable holds must retain aggregate source backing.
-- No gate, wagering status, catalog pointer or player balance is changed.
BEGIN;
SET LOCAL lock_timeout = '20s';
LOCK TABLE public.scheduled_stake_holds, public.coin_provenance,
  public.coin_lot_entries IN SHARE ROW EXCLUSIVE MODE;

-- Every active hold is counted together, including other users of a source lot.
-- Extra non-scheduled reservations may exist, but cannot substitute for the
-- amount still owed to scheduled holds. The per-lot trigger runs for ALL
-- reserved-cache writes, including entries under unrelated operation types.
CREATE FUNCTION public.scheduled_stake_backing_failures(target_lot TEXT DEFAULT NULL)
RETURNS TABLE(id TEXT) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH sources AS (
    SELECT h.id,e."lotId" AS lot_id,e."reservedDelta"::BIGINT AS amount
    FROM public.scheduled_stake_holds h
    JOIN public.coin_lot_entries e ON e."operationId"=h.hold_operation_id
    WHERE h.state='HELD' AND (target_lot IS NULL OR e."lotId"=target_lot)
  ), obligations AS (
    SELECT lot_id,SUM(amount) AS amount FROM sources GROUP BY lot_id
  )
  SELECT DISTINCT s.id FROM sources s JOIN obligations o ON o.lot_id=s.lot_id
  LEFT JOIN public.coin_provenance p ON p.id=s.lot_id
  WHERE p.id IS NULL OR p.state IS DISTINCT FROM 'OPEN'
    OR p."reservedAmount" IS NULL OR p."reservedAmount" < o.amount
$$;

CREATE FUNCTION public.scheduled_stake_backing_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE failed TEXT;
BEGIN
  SELECT b.id INTO failed FROM public.scheduled_stake_backing_failures(NEW.id) b LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'scheduled stake backing mismatch: %',failed; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER scheduled_stake_lot_backing
AFTER UPDATE OF "reservedAmount",state ON public.coin_provenance
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.scheduled_stake_backing_constraint();
REVOKE ALL ON FUNCTION public.scheduled_stake_backing_constraint() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.scheduled_stake_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'stake hold history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'HELD' OR NEW.refund_operation_id IS NOT NULL THEN RAISE EXCEPTION 'new hold must be HELD'; END IF;
    PERFORM 1 FROM public.platform_gates WHERE key='SCHEDULED_STAKE_HOLD' AND enabled FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled stake holds are disabled'; END IF;
    PERFORM 1 FROM public.country_casino_policies
      WHERE id=NEW.policy_id AND version=NEW.policy_version AND state='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'scheduled stake requires an active published policy'; END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
  ELSIF OLD.state <> 'HELD' OR NEW.state <> 'REFUNDED' OR NEW.refund_operation_id IS NULL
    OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','refund_operation_id']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD)-ARRAY['state','refund_operation_id']) THEN
    RAISE EXCEPTION 'stake hold terms are immutable; only exact refund is supported';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.scheduled_stake_integrity_failures(target_id TEXT DEFAULT NULL)
RETURNS TABLE(id TEXT) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  WITH subjects AS (
    SELECT * FROM public.scheduled_stake_holds h WHERE target_id IS NULL OR h.id=target_id
  ), operations AS (
    SELECT h.*,o.id AS operation_id,o.type::TEXT AS operation_type,o."userId" AS owner,
      o."scopeType" AS scope_type,o."scopeId" AS scope_id,o."countryPolicyId" AS policy,
      o."countryPolicyVersion" AS version,o."walletTransactionIds" AS wallet_ids,
      o."reversesOperationId" AS reverse_id,false AS refund
    FROM subjects h LEFT JOIN public.economic_operations o ON o.id=h.hold_operation_id
    UNION ALL
    SELECT h.*,o.id,o.type::TEXT,o."userId",o."scopeType",o."scopeId",o."countryPolicyId",
      o."countryPolicyVersion",o."walletTransactionIds",o."reversesOperationId",true
    FROM subjects h LEFT JOIN public.economic_operations o ON o.id=h.refund_operation_id WHERE h.state='REFUNDED'
  )
  SELECT DISTINCT o.id FROM operations o
  WHERE o.operation_id IS NULL OR o.owner IS DISTINCT FROM o.user_id
    OR o.scope_type IS DISTINCT FROM 'SCHEDULED_STAKE' OR o.scope_id IS DISTINCT FROM o.id
    OR o.operation_type IS DISTINCT FROM CASE WHEN o.refund THEN 'SCHEDULED_STAKE_REFUND' ELSE 'SCHEDULED_STAKE_HOLD' END
    OR o.policy IS DISTINCT FROM o.policy_id OR o.version IS DISTINCT FROM o.policy_version
    OR NOT EXISTS(SELECT 1 FROM public.country_casino_policies p WHERE p.id=o.policy_id AND p.version=o.policy_version AND p.state IN ('ACTIVE','SUPERSEDED'))
    OR o.reverse_id IS DISTINCT FROM CASE WHEN o.refund THEN o.hold_operation_id ELSE NULL END
    OR pg_catalog.cardinality(o.wallet_ids) IS DISTINCT FROM 1
    OR NOT EXISTS(SELECT 1 FROM public.wallet_transactions w WHERE w.id=o.wallet_ids[1]
      AND w."userId"=o.user_id AND w.currency='COINS' AND w.status='SUCCEEDED'
      AND w.type::TEXT=CASE WHEN o.refund THEN 'COIN_CREDIT' ELSE 'COIN_DEBIT' END
      AND w."ledgerType"::TEXT=CASE WHEN o.refund THEN 'CREDIT' ELSE 'DEBIT' END
      AND w."referenceType"='GAME' AND w."referenceId"=o.id AND w.amount=o.amount
      AND w."balanceAfter"::BIGINT-w."balanceBefore"::BIGINT=CASE WHEN o.refund THEN o.amount ELSE -o.amount END)
    OR (SELECT COALESCE(SUM(e."availableDelta"),0) FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id)
       <> CASE WHEN o.refund THEN o.amount ELSE -o.amount END
    OR EXISTS(SELECT 1 FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id AND (
      e."userId"<>o.user_id OR e."entryType"::TEXT<>CASE WHEN o.refund THEN 'RELEASE' ELSE 'RESERVE' END
      OR e."reservedDelta"<>-e."availableDelta" OR e."progressDelta"<>0 OR e."obligationDelta"<>0
      OR e."counterpartyLotId" IS NOT NULL
      OR (NOT o.refund AND (e."availableDelta">=0 OR e."reversesEntryId" IS NOT NULL))
      OR (o.refund AND NOT EXISTS(SELECT 1 FROM public.coin_lot_entries src WHERE src.id=e."reversesEntryId"
        AND src."operationId"=o.hold_operation_id AND src."lotId"=e."lotId" AND src."userId"=e."userId"
        AND e."availableDelta"=-src."availableDelta" AND e."reservedDelta"=-src."reservedDelta"))))
    OR (o.refund AND (SELECT COUNT(*) FROM public.coin_lot_entries e WHERE e."operationId"=o.operation_id)
      <> (SELECT COUNT(*) FROM public.coin_lot_entries e WHERE e."operationId"=o.hold_operation_id))
  UNION
  SELECT h.id FROM subjects h JOIN public.coin_lot_entries src ON src."operationId"=h.hold_operation_id
    JOIN public.coin_lot_entries reversal ON reversal."reversesEntryId"=src.id
    WHERE h.state<>'REFUNDED' OR reversal."operationId" IS DISTINCT FROM h.refund_operation_id
  UNION
  SELECT h.id FROM subjects h JOIN public.economic_operations reversal ON reversal."reversesOperationId"=h.hold_operation_id
    WHERE h.state<>'REFUNDED' OR reversal.id IS DISTINCT FROM h.refund_operation_id
  UNION
  SELECT o.id FROM public.economic_operations o
    WHERE o.type IN ('SCHEDULED_STAKE_HOLD','SCHEDULED_STAKE_REFUND')
      AND (target_id IS NULL OR o."scopeId"=target_id OR o.id=target_id)
      AND NOT EXISTS(SELECT 1 FROM public.scheduled_stake_holds h
        WHERE (o.type='SCHEDULED_STAKE_HOLD' AND h.hold_operation_id=o.id)
          OR (o.type='SCHEDULED_STAKE_REFUND' AND h.refund_operation_id=o.id))
  UNION
  SELECT b.id FROM public.scheduled_stake_backing_failures() b
    WHERE target_id IS NULL OR b.id=target_id
$$;

CREATE OR REPLACE FUNCTION public.scheduled_practice_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.scheduled_game_rounds%ROWTYPE;
  stream_enabled BOOLEAN;
  now_ms BIGINT;
  admitted_at TIMESTAMPTZ;
  item JSONB;
  market TEXT;
  seen TEXT[] := ARRAY[]::TEXT[];
  amount NUMERIC;
  stake NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'practice tickets are immutable';
  END IF;
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || target.stream_id, 0));
  -- Re-read after the same lock used by admission, pause and draw workers.
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id FOR SHARE;
  SELECT enabled INTO STRICT stream_enabled FROM public.scheduled_game_streams WHERE id = target.stream_id FOR SHARE;
  PERFORM 1 FROM public.users WHERE id = NEW.user_id AND status::TEXT = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active player required' USING ERRCODE = '23514'; END IF;
  -- The acceptance timestamp and cutoff use the same clock sample, after
  -- every potentially blocking lock. Locking reads also fail closed when a
  -- repeatable-read snapshot predates a committed pause or draw.
  admitted_at := pg_catalog.clock_timestamp();
  now_ms := pg_catalog.floor(EXTRACT(EPOCH FROM admitted_at) * 1000)::BIGINT;
  IF NOT stream_enabled OR target.mode <> 'PRACTICE' OR target.state <> 'OPEN'
    OR target.rules_id <> 'single-zero-rtp90-v2' OR now_ms < target.opens_ms OR now_ms >= target.closes_ms THEN
    RAISE EXCEPTION 'practice round is closed' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.bets) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid practice ticket' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.bets) NOT BETWEEN 1 AND 52 THEN
    RAISE EXCEPTION 'invalid practice ticket' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(NEW.bets) LOOP
    IF pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(item->'marketId') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(item->'amount') IS DISTINCT FROM 'number'
      OR (item - ARRAY['marketId','amount']) <> '{}'::JSONB THEN
      RAISE EXCEPTION 'invalid practice line' USING ERRCODE = '23514';
    END IF;
    market := item->>'marketId';
    IF NOT (market ~ '^number:([0-9]|[12][0-9]|3[0-6])$' OR market ~ '^sector:[0-5]$'
      OR market ~ '^dozen:[0-2]$' OR market = ANY(ARRAY['red','black','odd','even','low','high']))
      OR market = ANY(seen) THEN
      RAISE EXCEPTION 'invalid practice market' USING ERRCODE = '23514';
    END IF;
    amount := (item->>'amount')::NUMERIC;
    IF amount < 40 OR amount > 480 OR pg_catalog.mod(amount,40) <> 0 THEN
      RAISE EXCEPTION 'invalid practice amount' USING ERRCODE = '23514';
    END IF;
    seen := pg_catalog.array_append(seen, market);
    stake := stake + amount;
  END LOOP;
  IF stake > 480 THEN RAISE EXCEPTION 'practice stake exceeds limit' USING ERRCODE = '23514'; END IF;
  NEW.accepted_at := admitted_at;
  RETURN NEW;
END $$;

-- Full forward definition; existing installations must receive the grant correction.
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
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_apply_runtime_grants"(TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.scheduled_stake_integrity_failures()) THEN
    RAISE EXCEPTION 'scheduled hold upgrade stopped: existing proof or backing mismatch';
  END IF;
END $$;
COMMIT;
