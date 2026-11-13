-- Restrict ledger_lock_economy_for_invariant_check() to the API runtime login
-- (dormant; operator-applied, never a Prisma migration).
--
--   psql -X -v ON_ERROR_STOP=1 -v runtime_role=<API runtime login> \
--     -f docs/deployment/economy-lock-restriction.sql
--
-- Run as the function's owner. One atomic statement.
--
-- Why (docs/deployment/security-definer-review.md, finding 1): the function
-- takes SHARE locks on the economy tables for its caller's transaction, and
-- PUBLIC can execute it, so any database login (a worker, a staff login once
-- one exists, or any login created later) can block every write to wallets,
-- wallet transactions and the ledger for as long as its transaction stays
-- open. Practice activation already moves it from PUBLIC to every role that
-- exists at that moment; this goes further and leaves EXECUTE with the owner
-- and the API runtime login only, which is its sole caller
-- (economy/ledger-admin-service.ts, enabling a ledger gate).
--
-- It revokes EXECUTE from PUBLIC and from every other role that holds it,
-- grants it to the runtime login, and verifies the result. It refuses to run as
-- anyone but the owner (a non-owner's GRANT and REVOKE would only warn), and
-- refuses a runtime role that is missing, cannot log in, or is a superuser.
-- Re-running it is harmless.
--
-- Rollback: GRANT EXECUTE ON FUNCTION public.ledger_lock_economy_for_invariant_check() TO PUBLIC;
SELECT pg_catalog.set_config('economy_lock_restriction.runtime_role', :'runtime_role', false) AS economy_lock_runtime_role \gset
DO $restrict$
DECLARE
  fn regprocedure := pg_catalog.to_regprocedure('public.ledger_lock_economy_for_invariant_check()');
  runtime_name text := pg_catalog.current_setting('economy_lock_restriction.runtime_role');
  runtime_oid oid;
  fn_owner oid;
  holder record;
  stray text;
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

  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, runtime_name);
  EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  FOR holder IN
    SELECT DISTINCT a.grantee::regrole::text AS name
    FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid = fn AND a.grantee NOT IN (0, fn_owner, runtime_oid)
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM %s', fn, holder.name);
  END LOOP;

  SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ', ')
    INTO stray
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee NOT IN (fn_owner, runtime_oid);
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTE is still held by %', stray;
  END IF;
END
$restrict$;
