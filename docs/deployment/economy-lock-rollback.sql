-- Roll back docs/deployment/economy-lock-restriction.sql by restoring the exact
-- EXECUTE permissions it captured before its first change (dormant;
-- operator-applied).
--
--   psql -X -v ON_ERROR_STOP=1 -f docs/deployment/economy-lock-rollback.sql
--
-- Run as the function's owner. One atomic statement. It:
--   - refuses anyone but the owner, and refuses when there is no unrestored
--     capture to return to;
--   - refuses if a captured grantee no longer exists (restore it by hand
--     after deciding what that role should be), or if a current EXECUTE grant
--     was made by someone other than the owner;
--   - revokes every current non-owner EXECUTE grant, then grants exactly the
--     captured ones back, grant options included. A capture of the default ACL
--     (NULL) restores PUBLIC;
--   - verifies the result equals the capture, then marks the capture restored.
--     A later restriction captures afresh.
--
-- It does not touch role memberships; the restriction never changed any.
\set ON_ERROR_STOP on
DO $rollback$
DECLARE
  signature constant text := 'public.ledger_lock_economy_for_invariant_check()';
  fn regprocedure := pg_catalog.to_regprocedure('public.ledger_lock_economy_for_invariant_check()');
  fn_owner oid;
  snap record;
  problem text;
  entry jsonb;
  holder text;
  now_entries jsonb;
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'public.ledger_lock_economy_for_invariant_check() is not installed';
  END IF;
  SELECT p.proowner INTO fn_owner FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  IF fn_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'run this as the owner of public.ledger_lock_economy_for_invariant_check()';
  END IF;
  IF pg_catalog.to_regclass('economy_lock_restriction.acl_snapshots') IS NULL THEN
    RAISE EXCEPTION 'nothing to roll back: no capture exists';
  END IF;
  SELECT s.* INTO snap FROM economy_lock_restriction.acl_snapshots s
   WHERE s.function_signature = signature AND s.restored_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nothing to roll back: every capture has already been restored';
  END IF;

  SELECT pg_catalog.string_agg(e ->> 'grantee', ', ' ORDER BY e ->> 'grantee') INTO problem
  FROM pg_catalog.jsonb_array_elements(snap.captured_entries) e
  WHERE e ->> 'grantee' <> 'PUBLIC'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = e ->> 'grantee');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'captured grantees no longer exist: %; nothing was changed', problem;
  END IF;
  SELECT pg_catalog.string_agg(DISTINCT pg_catalog.pg_get_userbyid(a.grantor)::text, ', ') INTO problem
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantor <> fn_owner;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'EXECUTE was granted by % (not the owner); the owner cannot revoke it', problem;
  END IF;

  FOR holder IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)::text) END
    FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> fn_owner
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM %s', fn, holder);
  END LOOP;
  FOR entry IN SELECT e FROM pg_catalog.jsonb_array_elements(snap.captured_entries) e LOOP
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO %s%s', fn,
      CASE WHEN entry ->> 'grantee' = 'PUBLIC' THEN 'PUBLIC' ELSE pg_catalog.quote_ident(entry ->> 'grantee') END,
      CASE WHEN (entry ->> 'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
           'grantable', a.is_grantable)
         ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END), '[]'::jsonb)
    INTO now_entries
  FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner;
  IF now_entries IS DISTINCT FROM snap.captured_entries THEN
    RAISE EXCEPTION 'restored permissions % differ from the capture %', now_entries, snap.captured_entries;
  END IF;
  UPDATE economy_lock_restriction.acl_snapshots
     SET restored_at = pg_catalog.clock_timestamp(), restored_by = session_user
   WHERE id = snap.id;
END
$rollback$;
