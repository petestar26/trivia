-- Staff member-status boundary (dormant; operator-applied, never a Prisma migration).
--
-- Run only as the owner of public.users, in an isolated owner maintenance
-- connection, after current migrations: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- One atomic statement: the function is created and EXECUTE is revoked from
-- PUBLIC together, so there is no window in which any role can call it.
--
-- It grants EXECUTE to nobody. Granting it to the staff login is a separate,
-- explicit activation decision (see staff-database-identity.md).
--
-- Scope: move one plain USER between ACTIVE and SUSPENDED for an active
-- ADMIN/SUPER_ADMIN actor, with optimistic concurrency, refresh-session drain on
-- suspension and an audit row. It never changes a role, never touches staff,
-- pending, banned or inactive accounts, and leaves users_privilege_guard
-- unchanged: the update passes that guard only because this owner-defined
-- function performs it, exactly like activate_provisioned_agent.
--
-- Uninstall: DROP FUNCTION IF EXISTS public.staff_set_member_status(text, text, text, text, text);
DO $install$
DECLARE
  users_owner oid;
BEGIN
  SELECT c.relowner INTO users_owner FROM pg_catalog.pg_class c WHERE c.oid = 'public.users'::regclass;
  IF users_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'staff member-status boundary must be installed by the owner of public.users';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.users'::regclass AND p.proname = 'users_privilege_guard' AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'users_privilege_guard must be present and enabled before installing the boundary';
  END IF;

  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.staff_set_member_status(
  actor_id text, member_id text, target_status text, expected_updated_at text, reason text)
RETURNS TABLE (outcome text, updated_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  actor_role text;
  actor_status text;
  member_role text;
  member_status text;
  member_updated timestamp(3);
  expected timestamp(3);
  note text := pg_catalog.btrim(reason);
  stamp timestamp(3);
BEGIN
  IF actor_id IS NULL OR member_id IS NULL OR target_status IS NULL
    OR target_status NOT IN ('ACTIVE', 'SUSPENDED')
    OR note IS NULL OR pg_catalog.char_length(note) NOT BETWEEN 5 AND 500
    OR expected_updated_at IS NULL
    OR expected_updated_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;
  BEGIN
    expected := (expected_updated_at::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
  EXCEPTION WHEN others THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END;
  IF actor_id = member_id THEN
    RETURN QUERY SELECT 'SELF'::text, NULL::text;
    RETURN;
  END IF;

  -- Same lock order as every account change: actor (share), then member (update).
  SELECT u.role::text, u.status::text INTO actor_role, actor_status
  FROM public.users u WHERE u.id = actor_id FOR SHARE;
  IF NOT FOUND OR actor_status <> 'ACTIVE' OR actor_role NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RETURN QUERY SELECT 'ACTOR_FORBIDDEN'::text, NULL::text;
    RETURN;
  END IF;
  SELECT u.role::text, u.status::text, u."updatedAt" INTO member_role, member_status, member_updated
  FROM public.users u WHERE u.id = member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::text;
    RETURN;
  END IF;
  IF member_role <> 'USER' OR member_status NOT IN ('ACTIVE', 'SUSPENDED') THEN
    RETURN QUERY SELECT 'NOT_MANAGEABLE'::text, NULL::text;
    RETURN;
  END IF;
  IF member_updated <> expected OR member_status = target_status THEN
    RETURN QUERY SELECT 'CONFLICT'::text, NULL::text;
    RETURN;
  END IF;

  stamp := GREATEST(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', member_updated + interval '1 millisecond')::timestamp(3);
  UPDATE public.users SET status = target_status::public."UserStatus", "updatedAt" = stamp WHERE id = member_id;
  IF target_status = 'SUSPENDED' THEN
    -- Same drain as the direct path: refresh sessions only. tokenVersion is
    -- unchanged so bounded own-funds-return access keeps working.
    DELETE FROM public.sessions WHERE "userId" = member_id;
  END IF;
  INSERT INTO public.audit_logs (id, "userId", action, entity, "entityId", "oldData", "newData")
  VALUES (
    pg_catalog.gen_random_uuid()::text, actor_id,
    CASE WHEN target_status = 'ACTIVE' THEN 'ADMIN_MEMBER_REACTIVATED' ELSE 'ADMIN_MEMBER_SUSPENDED' END,
    'User', member_id,
    pg_catalog.jsonb_build_object('status', member_status),
    pg_catalog.jsonb_build_object(
      'status', target_status, 'reason', note,
      'refreshSessionsRevoked', target_status = 'SUSPENDED',
      'boundary', 'staff_set_member_status', 'databaseLogin', session_user::text));
  RETURN QUERY SELECT 'OK'::text, pg_catalog.to_char(stamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END
$body$
$create$;

  REVOKE ALL ON FUNCTION public.staff_set_member_status(text, text, text, text, text) FROM PUBLIC;
END
$install$;
