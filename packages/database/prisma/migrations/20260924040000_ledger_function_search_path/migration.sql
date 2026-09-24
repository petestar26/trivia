-- Every function this schema defines now runs with a fixed search_path: this
-- schema, then pg_temp. Without it, PostgreSQL searches a session's
-- temporary schema FIRST for table names, so an ordinary role (no superuser,
-- not the owner, only DML grants) could create TEMP tables named like the
-- ledger tables - admin_adjustment_approvals, users, economic_operations -
-- fill them with invented rows, and every guard function would read those
-- instead of the real ones. That forged an ADMIN_ADJUST with no approval.
-- With pg_temp listed last, table and type names resolve to this schema
-- first; function names are never looked up in pg_temp at all.
--
-- Extension functions (pgcrypto) are left as installed, and so are the
-- ledger approval functions, which already run with the stricter fixed path
-- pg_catalog, pg_temp and schema-qualified names (migration 20260924010000).
-- Invariant I3 checks that every other function in the schema keeps this
-- setting, so a later migration that creates a function without it is
-- reported.
DO $pin$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND NOT (COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, pg_temp'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn.signature, current_schema());
  END LOOP;
END
$pin$;
