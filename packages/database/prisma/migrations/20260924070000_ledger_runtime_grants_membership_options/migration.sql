-- PostgreSQL 16 gives every role membership its own options: INHERIT (the
-- member holds the role's privileges), SET (it can SET ROLE to the role) and
-- ADMIN (it can grant the role, to itself too). pg_has_role MEMBER reports
-- every membership, even one that grants none of them. The grants function
-- 20260924060000 installed asked MEMBER throughout, so on 16 it refused a
-- runtime role for memberships that give it nothing, and counted a role
-- whose only link to the tables' owner is such a membership as inside the
-- owner's trust. This migration installs, on every database (also one that
-- applied the earlier versions, whose migrations never run again), a
-- version that asks what each membership gives, through three helpers that
-- the setup script (ledger:runtime-access) and invariant I3 share with it:
--
-- ledger_set_role_privilege(server_version_num): the pg_has_role privilege
--   that says one role can SET ROLE to another: SET from PostgreSQL 16,
--   where SET ROLE needs SET on every membership on the way; MEMBER before,
--   when any membership allowed SET ROLE whatever the member's INHERIT.
-- ledger_role_reach(role): every role it is, can become or inherits the
--   privileges of. It can become a role when SET ROLE to it succeeds, or when
--   it can grant the role to itself: a membership in it WITH ADMIN OPTION
--   held by itself or by a role it inherits from, the grantors GRANT accepts
--   (pg_has_role's ADMIN OPTION test also counts one behind a membership
--   that grants neither INHERIT nor SET, which GRANT cannot use), never a
--   superuser role, which only a superuser grants; and so on from every
--   role it can become. It inherits a role's privileges when every
--   membership on the way grants INHERIT (before 16, when no member on the
--   way is NOINHERIT): pg_has_role USAGE, which has_*_privilege follow. A
--   superuser can become every role: nothing is followed from it.
-- ledger_role_is_trusted(role, tables_owner): whether it can become a
--   superuser or the tables' owner, and so act as one, attributes included.
--   Inheriting the owner's privileges is not enough: what code running as
--   the owner picked up would still run with more than the role has.
--
-- The grants function then refuses a runtime role that is, or can become, a
-- superuser, a role exempt from row security, one allowed to create roles or
-- a replication role (as the setup script does; before 16 a role allowed to
-- create roles can grant itself any role but a superuser); one that can
-- become or inherits the privileges of the tables' owner, or of a role that
-- can create where the owner resolves names or owns an object there, or of a
-- role that can change a key other tables follow by cascade; and it refuses
-- any role outside the owner's trust (by ledger_role_is_trusted) that can
-- create there or owns an object there. Everything else is as before; run
-- it, as the owner, after every deploy (ledger:runtime-access).

CREATE OR REPLACE FUNCTION "ledger_set_role_privilege"(server_version_num INTEGER)
RETURNS TEXT AS $$
  SELECT CASE WHEN server_version_num >= 160000 THEN 'SET' ELSE 'MEMBER' END
$$ LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_role_reach"(member_role OID)
RETURNS TABLE (role_id OID, assumable BOOLEAN, via_id OID) AS $$
  WITH RECURSIVE can_become(oid) AS (
    SELECT r.oid FROM pg_roles r WHERE r.oid = member_role
    UNION
    SELECT m.oid FROM can_become a JOIN pg_roles s ON s.oid = a.oid AND NOT s.rolsuper CROSS JOIN pg_roles m
    WHERE pg_has_role(a.oid, m.oid, public.ledger_set_role_privilege(current_setting('server_version_num')::integer))
       OR (NOT m.rolsuper AND EXISTS (
         SELECT 1 FROM pg_auth_members g WHERE g.roleid = m.oid AND g.admin_option AND pg_has_role(a.oid, g.member, 'USAGE')))),
  sources AS (SELECT s.oid, s.rolname FROM can_become a JOIN pg_roles s ON s.oid = a.oid WHERE NOT s.rolsuper)
  -- For a role it cannot become, `via` names the role that inherits it: the
  -- member itself if it does, otherwise the first role it can become that does.
  SELECT m.oid, m.oid IN (SELECT oid FROM can_become),
         CASE WHEN m.oid NOT IN (SELECT oid FROM can_become) THEN (
           SELECT s.oid FROM sources s WHERE pg_has_role(s.oid, m.oid, 'USAGE') ORDER BY s.oid <> member_role, s.rolname LIMIT 1)
         END
  FROM pg_roles m
  WHERE m.oid IN (SELECT oid FROM can_become) OR EXISTS (SELECT 1 FROM sources s WHERE pg_has_role(s.oid, m.oid, 'USAGE'))
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_role_is_trusted"(candidate OID, tables_owner OID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.ledger_role_reach(candidate) x JOIN pg_roles t ON t.oid = x.role_id
                 WHERE x.assumable AND (t.rolsuper OR t.oid = tables_owner))
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp;

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
