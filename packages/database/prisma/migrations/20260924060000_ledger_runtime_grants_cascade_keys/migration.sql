-- Installs the corrected ledger_apply_runtime_grants on every database,
-- including one that already applied an earlier version of it with
-- migration 20260924010000 (a migration once applied is never re-run, so a
-- correction to it must come forward). Two rules beyond that version:
--
-- 1. Keys other tables follow by cascade are never the runtime role's to
--    change. A foreign key's ON UPDATE action writes the referencing table
--    as its owner, and that table's triggers run with the owner's
--    privileges; the application never changes these keys (an id, a
--    country code). Wherever a foreign key cascades or nulls on UPDATE, the
--    runtime role keeps UPDATE on every column of the referenced table but
--    the referenced ones.
-- 2. Nor may it change them as a role it can become. A membership usable
--    by SET ROLE alone (the runtime role NOINHERIT), directly or through
--    other roles, is invisible to has_column_privilege; every role the
--    runtime role is a member of is checked, and the setup stops, naming
--    each, if any of them can change such a key.
--
-- Everything else is as before: the function revokes everything, grants
-- data access, takes back what the runtime never needs, and refuses (SQLSTATE
-- 42501, changing nothing) whatever it cannot make safe. It is idempotent;
-- run it, as the owner, after every deploy (ledger:runtime-access).

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
  tables_owner OID := (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', schema_name, 'economic_operations')));
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role % does not exist', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role % must be neither a superuser nor exempt from row security', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
             WHERE n.nspname = schema_name AND r.rolname = runtime_role)
     OR pg_has_role(runtime_role, tables_owner, 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s must neither own nor be a member of the owner of the schema''s tables', runtime_role);
  END IF;
  -- The approval functions run as the owner and resolve names in pg_catalog,
  -- this schema and pgcrypto's; other functions that run as the owner resolve
  -- names in this schema. A role that could create objects in any of them
  -- could plant a function or operator there that runs with the owner's
  -- privileges, so the runtime role may create nothing in them: not directly,
  -- not through PUBLIC, not as or through any role it belongs to (inherited
  -- or by SET ROLE, the schema's owner included), and it may own nothing in
  -- them that it could have planted before. What the owner can revoke is
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
      AND (a.grantee = 0 OR pg_has_role(runtime_role, a.grantee, 'MEMBER'));
    -- The owner's CREATE is implicit (not in the ACL) and has_schema_privilege
    -- ignores a membership usable only by SET ROLE: check the owner directly.
    IF holders IS NULL AND pg_has_role(runtime_role, (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = trusted), 'MEMBER') THEN
      SELECT r.rolname::text INTO holders FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = trusted;
    END IF;
    IF holders IS NOT NULL OR has_schema_privilege(runtime_role, trusted, 'CREATE') THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s can still create objects in schema %s, through %s: functions that run as the owner resolve names there. Revoke that CREATE privilege (or that membership) as its grantor, then run this again',
          runtime_role, trusted, COALESCE(holders, runtime_role));
    END IF;
    -- Nor may any other role outside the owner's trust still create there.
    -- A role is inside it when it can act as a superuser or as the tables'
    -- owner: nothing it creates gives it more than it has. Any other role -
    -- another application's, an operator's, a retired account - could create
    -- after this setup what a retired role left before it: an exact-type
    -- overload or operator that code running as the owner (migrations, the
    -- preflight and scans, every function pinned to this schema, a cascade
    -- from a key the runtime role changes) would pick. CREATE comes from the
    -- schema's ACL (PUBLIC included) or its ownership, and reaches every role
    -- that can become its holder, inherited or by SET ROLE. The setup
    -- revokes only its own grants (PUBLIC's and the runtime role's, above):
    -- anyone else's it names, and stops.
    WITH trust AS (
      SELECT r.oid, r.rolname, EXISTS (
               SELECT 1 FROM pg_roles t
               WHERE (t.rolsuper OR t.oid = tables_owner) AND pg_has_role(r.oid, t.oid, 'MEMBER')) AS is_trusted
      FROM pg_roles r)
    SELECT left(string_agg(DISTINCT u.rolname::text || ' (through '
             || CASE WHEN src.holder = 0 THEN 'PUBLIC' ELSE src.holder::regrole::text END || ')', ', '), 2000)
      INTO creators
    FROM pg_namespace n
    CROSS JOIN LATERAL (
      SELECT a.grantee AS holder FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE a.privilege_type = 'CREATE'
      UNION SELECT n.nspowner) src
    JOIN trust u ON NOT u.is_trusted AND u.rolname !~ '^pg_'
      AND CASE WHEN src.holder = 0 THEN true ELSE pg_has_role(u.oid, src.holder, 'MEMBER') END
    WHERE n.nspname = trusted;
    IF creators IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('roles outside the owner''s trust can still create objects in schema %s: %s. Code that runs as the owner resolves names there; revoke that CREATE privilege (or that membership) as its grantor, or make the role one that can act as the tables'' owner %s, then run this again',
          trusted, creators, tables_owner::regrole::text);
    END IF;
    -- Nor may anything there belong to such a role, or to the runtime role:
    -- what it created while it could (an exact-type overload of a built-in,
    -- an operator on the ledger's types) sits where the same code resolves
    -- names.
    WITH trust AS (
      SELECT r.oid, r.rolname, EXISTS (
               SELECT 1 FROM pg_roles t
               WHERE (t.rolsuper OR t.oid = tables_owner) AND pg_has_role(r.oid, t.oid, 'MEMBER')) AS is_trusted
      FROM pg_roles r)
    SELECT string_agg(DISTINCT o.kind || ' ' || o.name, ', ') FILTER (WHERE pg_has_role(runtime_role, o.owner, 'MEMBER')),
           left(string_agg(DISTINCT o.kind || ' ' || o.name || ' (owner ' || u.rolname::text || ')', ', ')
                  FILTER (WHERE NOT u.is_trusted), 2000)
      INTO planted, foreign_owned
    FROM (
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
    ) o JOIN pg_namespace n ON n.oid = o.ns JOIN trust u ON u.oid = o.owner
    WHERE n.nspname = trusted;
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

  -- Nor through a role it can become. has_column_privilege sees only what a
  -- role inherits: a membership usable by SET ROLE alone (the member
  -- NOINHERIT), directly or through other roles, still lets the runtime
  -- role become a role that changes these keys and start the cascade as it.
  -- So every role it is a member of, directly or transitively, inherited or
  -- not (pg_has_role MEMBER), must be unable to change them. The setup does
  -- not change other roles' privileges: it names each and stops.
  SELECT left(string_agg(DISTINCT format('%s.%s through %s', c.confrelid::regclass::text, a.attname, m.rolname), ', '), 2000)
    INTO key_holders
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
  JOIN pg_roles m ON pg_has_role(runtime_role, m.oid, 'MEMBER')
  WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND r.relnamespace = to_regnamespace(schema_name)
    AND has_column_privilege(m.oid, c.confrelid, a.attname::text, 'UPDATE');
  IF key_holders IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s can still change keys other tables follow by cascade, as a role it can become: %s. A cascade, and the triggers it fires, run as the owner of the referencing table. Revoke that membership, or that role''s UPDATE on those columns, as its grantor, then run this again',
        runtime_role, key_holders);
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_apply_runtime_grants"(TEXT) FROM PUBLIC;
