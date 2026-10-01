-- Run only in an isolated owner maintenance connection after current migrations.
-- Defaults to playqube_app; tests may SET LOCAL playqube.repair_role beforehand.
-- This atomic repair grants only the four snapshot SELECT capabilities. It
-- changes no application rows, activation flags, key material or write grants.
DO $repair$
DECLARE
  runtime_role text := COALESCE(NULLIF(current_setting('playqube.repair_role', true), ''), 'playqube_app');
  runtime_oid oid;
  ledger_owner oid;
  target text;
  target_oid oid;
BEGIN
  IF runtime_role !~ '^[A-Za-z_][A-Za-z_0-9]{0,62}$' THEN
    RAISE EXCEPTION 'invalid runtime role';
  END IF;
  SELECT oid INTO runtime_oid FROM pg_catalog.pg_roles WHERE rolname = runtime_role;
  SELECT relowner INTO ledger_owner FROM pg_catalog.pg_class WHERE oid = 'public.economic_operations'::regclass;
  IF runtime_oid IS NULL OR runtime_role = current_user
    OR NOT public.ledger_role_is_trusted((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user), ledger_owner)
    OR NOT pg_catalog.pg_has_role(current_user, ledger_owner, 'USAGE') THEN
    RAISE EXCEPTION 'repair requires an isolated ledger owner and an existing separate runtime role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ledger_role_reach(runtime_oid) x JOIN pg_catalog.pg_roles r ON r.oid=x.role_id
    WHERE r.oid=ledger_owner OR (x.assumable AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolreplication))
  ) THEN
    RAISE EXCEPTION 'unsafe runtime role; repair refused';
  END IF;
  IF pg_catalog.has_any_column_privilege(runtime_role, 'public.ledger_approval_keys', 'SELECT')
    OR pg_catalog.has_any_column_privilege(runtime_role, 'public._prisma_migrations', 'INSERT')
    OR pg_catalog.has_any_column_privilege(runtime_role, 'public._prisma_migrations', 'UPDATE')
    OR pg_catalog.has_table_privilege(runtime_role, 'public._prisma_migrations', 'DELETE') THEN
    RAISE EXCEPTION 'runtime signing-key or migration-write access; repair refused';
  END IF;
  FOREACH target IN ARRAY ARRAY['scheduled_game_streams', 'scheduled_game_rounds', 'scheduled_practice_tickets', 'users'] LOOP
    target_oid := pg_catalog.to_regclass('public.' || target);
    IF target_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=target_oid AND c.relkind IN ('r','p')
        AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
    ) THEN
      RAISE EXCEPTION 'required snapshot table is absent or not owner-accessible: %', target;
    END IF;
    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE public.%I TO %I', target, runtime_role);
  END LOOP;
END
$repair$;
