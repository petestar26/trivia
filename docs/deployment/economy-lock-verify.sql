-- Verify the economy-lock restriction is in effect: READ ONLY, changes nothing.
--
--   psql -X -v ON_ERROR_STOP=1 -v runtime_role=<API runtime login> \
--     -f docs/deployment/economy-lock-verify.sql
--
-- Exits non-zero (and names the problem) unless every one of these holds for
-- public.ledger_lock_economy_for_invariant_check():
--   - PUBLIC cannot execute it;
--   - the runtime login holds EXECUTE, without grant option, and nobody but the
--     owner and the runtime holds any direct grant;
--   - the runtime login cannot act as the owner;
--   - no login other than superusers, owner-equivalents and the runtime can
--     execute it: directly, through an inherited role, or after SET ROLE to
--     any role, the runtime included.
-- On success it lists the owner-equivalent and superuser logins, who can always
-- run it, so a reviewer can confirm they are the expected operators.
--
-- Run it after applying the restriction and after anything that can change
-- grants or memberships: migrations (a DROP and CREATE of the function resets
-- its ACL to PUBLIC), practice provisioning, new logins or memberships.
\set ON_ERROR_STOP on
\if :{?runtime_role}
\else
  DO $missing$ BEGIN RAISE EXCEPTION 'economy-lock-verify: pass -v runtime_role=<API runtime login>'; END $missing$;
\endif
SELECT pg_catalog.set_config('economy_lock.runtime_role', :'runtime_role', false) AS economy_lock_runtime_role \gset
BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE
  fn regprocedure := pg_catalog.to_regprocedure('public.ledger_lock_economy_for_invariant_check()');
  runtime_name text := pg_catalog.current_setting('economy_lock.runtime_role');
  runtime_oid oid;
  fn_owner oid;
  problem text;
  privileged text;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'public.ledger_lock_economy_for_invariant_check() is not installed';
  END IF;
  SELECT p.proowner INTO fn_owner FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  SELECT r.oid INTO runtime_oid FROM pg_catalog.pg_roles r
   WHERE r.rolname = runtime_name AND r.rolcanlogin AND NOT r.rolsuper AND r.oid <> fn_owner;
  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'runtime role % must be an existing login that is neither a superuser nor the owner', runtime_name;
  END IF;
  IF pg_catalog.pg_has_role(runtime_oid, fn_owner, 'MEMBER') THEN
    RAISE EXCEPTION 'runtime role % can act as the owner through a membership', runtime_name;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee = runtime_oid) THEN
    RAISE EXCEPTION 'runtime role % holds no EXECUTE grant: the API could not enable a ledger gate', runtime_name;
  END IF;
  SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
           || CASE WHEN a.is_grantable THEN ' (with grant option)' ELSE '' END, ', ' ORDER BY 1)
    INTO problem
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> fn_owner
    AND (a.grantee <> runtime_oid OR a.is_grantable);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'restriction not in effect: EXECUTE is held by %', problem;
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
    RAISE EXCEPTION 'restriction not in effect: these logins can execute it (directly, inherited or by SET ROLE): %', problem;
  END IF;
  SELECT pg_catalog.string_agg(l.rolname::text || CASE WHEN l.rolsuper THEN ' (superuser)' ELSE ' (owner-equivalent)' END,
           ', ' ORDER BY l.rolname)
    INTO privileged
  FROM pg_catalog.pg_roles l
  WHERE l.rolcanlogin AND (l.rolsuper OR pg_catalog.pg_has_role(l.oid, fn_owner, 'MEMBER'));
  RAISE NOTICE 'economy lock: runtime-only (%); also always able: %', runtime_name, COALESCE(privileged, 'none');
END
$verify$;
ROLLBACK;
