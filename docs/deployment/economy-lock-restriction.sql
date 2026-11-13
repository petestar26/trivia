-- Restrict ledger_lock_economy_for_invariant_check() to the API runtime login
-- (dormant; operator-applied, never a Prisma migration).
--
--   psql -X -v ON_ERROR_STOP=1 -v runtime_role=<API runtime login> \
--     [-v revoke_roles=<role>,<role>] -f docs/deployment/economy-lock-restriction.sql
--
-- Run as the function's owner. One atomic statement after the variables.
-- Needs psql 10 or later (\if).
--
-- Why (docs/deployment/security-definer-review.md, finding 1): the function
-- takes SHARE locks on the economy tables for its caller's transaction. Any
-- login that can execute it, directly, through an inherited role or after
-- SET ROLE, can block wallet and ledger writes while its transaction stays
-- open. Its only caller is the API runtime (economy/ledger-admin-service.ts).
--
-- What it does, in one transaction:
--   1. Refuses layouts it cannot make safe (fail closed):
--      - it is run by anyone but the function's owner (a non-owner's GRANT
--        and REVOKE would only warn);
--      - the runtime role is missing, cannot log in, is a superuser, is the
--        owner, or can itself act as the owner (any membership);
--      - any other role, superusers and owner-equivalents aside, can inherit
--        from or SET ROLE to the runtime, directly or through other roles:
--        restricting EXECUTE to the runtime would then also grant it to them;
--      - any EXECUTE grant was made by someone other than the owner (the
--        owner cannot revoke it);
--      - roles hold their own EXECUTE grant and are not listed, exactly, in
--        revoke_roles. Named consumers are never revoked silently: list them
--        only after confirming none is a real caller.
--   2. Captures the function's exact ACL in an owner-only snapshot (first run
--      only; a re-run keeps the original capture), for
--      docs/deployment/economy-lock-rollback.sql.
--   3. Grants EXECUTE to the runtime (without grant option) and revokes it from
--      PUBLIC and from every listed role.
--   4. Verifies the direct ACL (owner and runtime only) and the effective one:
--      no login outside superusers, owner-equivalents and the runtime can
--      execute it, directly, by inheritance or by SET ROLE.
--
-- Check it at any time, read only: docs/deployment/economy-lock-verify.sql.
\set ON_ERROR_STOP on
DO $preflight$ BEGIN
  IF pg_catalog.current_setting('server_version_num')::int < 130000 THEN
    RAISE EXCEPTION 'PostgreSQL 13 or later is required';
  END IF;
END $preflight$;
\if :{?runtime_role}
\else
  DO $missing$ BEGIN RAISE EXCEPTION 'economy-lock-restriction: pass -v runtime_role=<API runtime login>'; END $missing$;
\endif
\if :{?revoke_roles}
\else
  \set revoke_roles ''
\endif
SELECT pg_catalog.set_config('economy_lock.runtime_role', :'runtime_role', false) AS economy_lock_runtime_role,
       pg_catalog.set_config('economy_lock.revoke_roles', :'revoke_roles', false) AS economy_lock_revoke_roles \gset
DO $restrict$
DECLARE
  signature constant text := 'public.ledger_lock_economy_for_invariant_check()';
  fn regprocedure := pg_catalog.to_regprocedure('public.ledger_lock_economy_for_invariant_check()');
  runtime_name text := pg_catalog.current_setting('economy_lock.runtime_role');
  runtime_oid oid;
  fn_owner oid;
  private_ns oid;
  listed text[];
  direct text[];
  problem text;
  role_name text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'public.ledger_lock_economy_for_invariant_check() is not installed';
  END IF;
  SELECT p.proowner INTO fn_owner FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  IF fn_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'run this as the owner of public.ledger_lock_economy_for_invariant_check()';
  END IF;
  SELECT r.oid INTO runtime_oid FROM pg_catalog.pg_roles r
   WHERE r.rolname = runtime_name AND r.rolcanlogin AND NOT r.rolsuper AND r.oid <> fn_owner;
  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'runtime role % must be an existing login that is neither a superuser nor the owner', runtime_name;
  END IF;

  -- 1. Layouts this cannot make safe.
  IF pg_catalog.pg_has_role(runtime_oid, fn_owner, 'MEMBER') THEN
    RAISE EXCEPTION 'unsupported layout: runtime role % can act as the owner through a membership', runtime_name;
  END IF;
  SELECT pg_catalog.string_agg(r.rolname::text, ', ' ORDER BY r.rolname) INTO problem
  FROM pg_catalog.pg_roles r
  WHERE r.oid NOT IN (runtime_oid, fn_owner) AND NOT r.rolsuper
    AND NOT pg_catalog.pg_has_role(r.oid, fn_owner, 'MEMBER')
    AND pg_catalog.pg_has_role(r.oid, runtime_oid, 'MEMBER');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'unsupported layout: these roles can inherit from or SET ROLE to runtime role %: %', runtime_name, problem;
  END IF;
  SELECT pg_catalog.string_agg(DISTINCT pg_catalog.pg_get_userbyid(a.grantor)::text, ', ') INTO problem
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantor <> fn_owner;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'unsupported layout: EXECUTE was granted by % (not the owner); the owner cannot revoke it', problem;
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT pg_catalog.btrim(x) ORDER BY pg_catalog.btrim(x)) INTO listed
  FROM pg_catalog.unnest(pg_catalog.string_to_array(pg_catalog.current_setting('economy_lock.revoke_roles'), ',')) x
  WHERE pg_catalog.btrim(x) <> '';
  SELECT pg_catalog.array_agg(DISTINCT pg_catalog.pg_get_userbyid(a.grantee)::text ORDER BY pg_catalog.pg_get_userbyid(a.grantee)::text)
    INTO direct
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee NOT IN (0, fn_owner, runtime_oid);
  IF COALESCE(listed, '{}') IS DISTINCT FROM COALESCE(direct, '{}') THEN
    RAISE EXCEPTION 'roles holding their own EXECUTE grant: [%]; listed in revoke_roles: [%]. Confirm none is a real caller, then pass exactly those roles as -v revoke_roles=',
      pg_catalog.array_to_string(COALESCE(direct, '{}'), ','), pg_catalog.array_to_string(COALESCE(listed, '{}'), ',');
  END IF;

  -- 2. Owner-only snapshot of the exact ACL before the first change.
  SELECT n.oid INTO private_ns FROM pg_catalog.pg_namespace n WHERE n.nspname = 'economy_lock_restriction';
  IF private_ns IS NULL THEN
    CREATE SCHEMA economy_lock_restriction;
  ELSIF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = private_ns) <> fn_owner THEN
    RAISE EXCEPTION 'schema economy_lock_restriction exists and is not owned by the function owner';
  END IF;
  private_ns := 'economy_lock_restriction'::regnamespace;
  REVOKE ALL ON SCHEMA economy_lock_restriction FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS economy_lock_restriction.acl_snapshots (
    id bigserial PRIMARY KEY,
    function_signature text NOT NULL,
    captured_acl aclitem[],
    captured_entries jsonb NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    captured_by text NOT NULL DEFAULT session_user,
    restored_at timestamptz,
    restored_by text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS acl_snapshots_one_active
    ON economy_lock_restriction.acl_snapshots (function_signature) WHERE restored_at IS NULL;
  REVOKE ALL ON TABLE economy_lock_restriction.acl_snapshots FROM PUBLIC;
  REVOKE ALL ON SEQUENCE economy_lock_restriction.acl_snapshots_id_seq FROM PUBLIC;
  SELECT pg_catalog.string_agg(what, ', ' ORDER BY what) INTO problem FROM (
    SELECT 'schema economy_lock_restriction' AS what
    FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    WHERE n.oid = private_ns AND a.grantee <> fn_owner
    UNION
    SELECT 'relation ' || c.oid::regclass::text FROM pg_catalog.pg_class c
    WHERE c.relnamespace = private_ns AND (c.relowner <> fn_owner OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE a.grantee <> fn_owner))
    UNION
    SELECT 'function ' || p.oid::regprocedure::text FROM pg_catalog.pg_proc p WHERE p.pronamespace = private_ns
  ) found;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'economy_lock_restriction must be reachable by its owner only; found: %', problem;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM economy_lock_restriction.acl_snapshots s
                 WHERE s.function_signature = signature AND s.restored_at IS NULL) THEN
    INSERT INTO economy_lock_restriction.acl_snapshots (function_signature, captured_acl, captured_entries)
    SELECT signature, p.proacl,
      COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
                  'grantable', a.is_grantable)
                ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END)
                FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), '[]'::jsonb)
    FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  END IF;

  -- 3. The change.
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, runtime_name);
  EXECUTE pg_catalog.format('REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION %s FROM %I', fn, runtime_name);
  EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  FOREACH role_name IN ARRAY COALESCE(direct, '{}') LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM %I', fn, role_name);
  END LOOP;

  -- 4. Direct and effective access.
  SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
           || CASE WHEN a.is_grantable THEN ' (with grant option)' ELSE '' END, ', ')
    INTO problem
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> fn_owner
    AND (a.grantee <> runtime_oid OR a.is_grantable);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTE is still held by %', problem;
  END IF;
  SELECT pg_catalog.string_agg(l.rolname::text, ', ' ORDER BY l.rolname) INTO problem
  FROM pg_catalog.pg_roles l
  WHERE l.rolcanlogin AND l.oid <> runtime_oid AND NOT l.rolsuper
    AND NOT pg_catalog.pg_has_role(l.oid, fn_owner, 'MEMBER')
    AND (pg_catalog.has_function_privilege(l.oid, fn, 'EXECUTE') OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      WHERE p.oid = fn AND a.privilege_type = 'EXECUTE'
        AND CASE WHEN a.grantee = 0 THEN true ELSE pg_catalog.pg_has_role(l.oid, a.grantee, 'MEMBER') END));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'these logins could still execute it: %', problem;
  END IF;
END
$restrict$;
