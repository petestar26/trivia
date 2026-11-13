-- Staff member-status boundary, v2: signed approvals (dormant; operator-applied,
-- never a Prisma migration).
--
-- Run only as the owner of public.users, in an isolated owner maintenance
-- connection, after current migrations: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- One atomic statement. It creates or replaces the boundary, its owner-only
-- approval key and approval tables, revokes everything from PUBLIC, and grants
-- EXECUTE to nobody. Installing a key and granting EXECUTE to the staff login
-- are separate, explicit operator steps (staff-database-identity.md).
--
-- The key and approval tables live in their own schema, staff_status_approval,
-- not in public: ledger_apply_runtime_grants grants the API runtime login DML
-- on every table in public, so a key table there would become readable by the
-- runtime the next time grants are re-applied. Nobody but the owner has USAGE
-- on the private schema; the install refuses a schema, table or function there
-- that anyone else owns or holds a privilege on.
--
-- A caller-supplied administrator ID is not proof of approval. The API signs
-- each status change with HMAC-SHA256 after authenticating the administrator;
-- the signature binds the actor, the actor's current tokenVersion, the member,
-- the target status, the expected account version, a SHA-256 digest of the
-- reason, a single-use nonce, a short expiry and the key ID. The database
-- verifies it with a key the staff login cannot read, records the nonce
-- append-only (single use, and evidence even when the change is refused), then
-- re-checks that the administrator is still active with that tokenVersion.
--
-- Scope is unchanged: one plain USER between ACTIVE and SUSPENDED, optimistic
-- concurrency, refresh-session drain on suspension, one audit row, never role.
-- users_privilege_guard is unchanged; the update passes it only because this
-- owner-defined function performs it, like activate_provisioned_agent.
--
-- Disable (keeps evidence):  DROP FUNCTION IF EXISTS public.staff_set_member_status(
--   text, text, text, text, text, integer, text, text, text, text);
-- The approval tables and key table are kept as evidence; see the runbook.
DO $install$
DECLARE
  users_owner oid;
  private_ns oid;
  stray text;
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
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'the boundary expects pgcrypto in schema public';
  END IF;

  -- The unsigned v1 boundary is never a valid entry point.
  DROP FUNCTION IF EXISTS public.staff_set_member_status(text, text, text, text, text);

  SELECT n.oid INTO private_ns FROM pg_catalog.pg_namespace n WHERE n.nspname = 'staff_status_approval';
  IF private_ns IS NULL THEN
    CREATE SCHEMA staff_status_approval;
  ELSIF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = private_ns) <> users_owner THEN
    RAISE EXCEPTION 'schema staff_status_approval exists and is not owned by the owner of public.users';
  END IF;
  private_ns := 'staff_status_approval'::regnamespace;
  REVOKE ALL ON SCHEMA staff_status_approval FROM PUBLIC;

  EXECUTE $keys$
CREATE TABLE IF NOT EXISTS staff_status_approval.keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  secret bytea NOT NULL CHECK (octet_length(secret) >= 32),
  installed_at timestamp(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  retired_at timestamp(3)
)$keys$;
  EXECUTE $approvals$
CREATE TABLE IF NOT EXISTS staff_status_approval.approvals (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{64}$'),
  key_id text NOT NULL REFERENCES staff_status_approval.keys(key_id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  actor_token_version integer NOT NULL,
  member_id text NOT NULL,
  target_status text NOT NULL,
  expected_updated_at text NOT NULL,
  reason_digest text NOT NULL,
  expires_at text NOT NULL,
  -- Decided at admission: ADMITTED (went on to the account checks; the audit
  -- row records a completed change), APPROVAL_EXPIRED or SELF.
  admission text NOT NULL CHECK (admission IN ('ADMITTED', 'APPROVAL_EXPIRED', 'SELF')),
  database_login text NOT NULL,
  recorded_at timestamp(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')
)$approvals$;
  EXECUTE $append$
CREATE OR REPLACE FUNCTION staff_status_approval.approvals_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  RAISE EXCEPTION 'staff_status_approval.approvals is append-only';
END
$body$$append$;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'staff_status_approval.approvals'::regclass
                 AND tgname = 'approvals_append_only') THEN
    EXECUTE 'CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON staff_status_approval.approvals
             FOR EACH ROW EXECUTE FUNCTION staff_status_approval.approvals_append_only()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'staff_status_approval.approvals'::regclass
                 AND tgname = 'approvals_no_truncate') THEN
    EXECUTE 'CREATE TRIGGER approvals_no_truncate BEFORE TRUNCATE ON staff_status_approval.approvals
             FOR EACH STATEMENT EXECUTE FUNCTION staff_status_approval.approvals_append_only()';
  END IF;

  -- Owner-only key management, mirroring ledger_install_approval_key.
  EXECUTE $install_key$
CREATE OR REPLACE FUNCTION staff_status_approval.install_key(p_key_id text, p_secret bytea) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  INSERT INTO staff_status_approval.keys AS k (key_id, secret) VALUES (p_key_id, p_secret)
  ON CONFLICT (key_id) DO UPDATE SET key_id = EXCLUDED.key_id
    WHERE k.secret = EXCLUDED.secret;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'status approval key % is already installed with a different secret', p_key_id;
  END IF;
END
$body$$install_key$;
  EXECUTE $retire_key$
CREATE OR REPLACE FUNCTION staff_status_approval.retire_key(p_key_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  UPDATE staff_status_approval.keys
     SET retired_at = COALESCE(retired_at, clock_timestamp() AT TIME ZONE 'UTC') WHERE key_id = p_key_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'status approval key % is not installed', p_key_id; END IF;
END
$body$$retire_key$;

  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.staff_set_member_status(
  approval_key_id text, approval_nonce text, approval_expires_at text, approval_signature text,
  actor_id text, actor_token_version integer,
  member_id text, target_status text, expected_updated_at text, reason text)
RETURNS TABLE (outcome text, updated_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  iso constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$';
  key_secret bytea;
  reason_digest text;
  payload text;
  expires timestamptz;
  expected timestamp(3);
  actor_role text;
  actor_status text;
  actor_version integer;
  member_role text;
  member_status text;
  member_updated timestamp(3);
  stamp timestamp(3);
  result text;
BEGIN
  IF approval_key_id IS NULL OR approval_key_id !~ '^[A-Za-z0-9._-]{1,64}$'
    OR approval_nonce IS NULL OR approval_nonce !~ '^[0-9a-f]{64}$'
    OR approval_signature IS NULL OR approval_signature !~ '^[0-9a-f]{64}$'
    OR approval_expires_at IS NULL OR approval_expires_at !~ iso
    OR actor_id IS NULL OR actor_token_version IS NULL OR member_id IS NULL
    OR target_status IS NULL OR target_status NOT IN ('ACTIVE', 'SUSPENDED')
    OR reason IS NULL OR pg_catalog.char_length(reason) NOT BETWEEN 5 AND 500
    OR expected_updated_at IS NULL OR expected_updated_at !~ iso THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END IF;
  BEGIN
    expires := approval_expires_at::timestamptz;
    expected := (expected_updated_at::timestamptz AT TIME ZONE 'UTC')::timestamp(3);
  EXCEPTION WHEN others THEN
    RETURN QUERY SELECT 'INVALID'::text, NULL::text;
    RETURN;
  END;

  -- 1. The signature, with an unretired key the caller cannot read.
  SELECT k.secret INTO key_secret FROM staff_status_approval.keys k
   WHERE k.key_id = approval_key_id AND k.retired_at IS NULL;
  reason_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(reason, 'UTF8'), 'sha256'), 'hex');
  payload := pg_catalog.concat_ws(E'\n', 'salem-staff-member-status/v1', approval_key_id, actor_id,
    actor_token_version::text, member_id, target_status, expected_updated_at, reason_digest,
    approval_nonce, approval_expires_at);
  IF key_secret IS NULL OR pg_catalog.encode(
       public.hmac(pg_catalog.convert_to(payload, 'UTF8'), key_secret, 'sha256'), 'hex') <> approval_signature THEN
    RETURN QUERY SELECT 'APPROVAL_INVALID'::text, NULL::text;
    RETURN;
  END IF;

  -- 2. Single use. Recorded before any business check so a refused change
  --    still consumes the approval and leaves evidence.
  IF expires <= pg_catalog.clock_timestamp() OR expires > pg_catalog.clock_timestamp() + interval '5 minutes' THEN
    result := 'APPROVAL_EXPIRED';
  ELSIF actor_id = member_id THEN
    result := 'SELF';
  END IF;
  BEGIN
    INSERT INTO staff_status_approval.approvals (nonce, key_id, actor_id, actor_token_version, member_id,
      target_status, expected_updated_at, reason_digest, expires_at, admission, database_login)
    VALUES (approval_nonce, approval_key_id, actor_id, actor_token_version, member_id, target_status,
      expected_updated_at, reason_digest, approval_expires_at, COALESCE(result, 'ADMITTED'), session_user::text);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'APPROVAL_REPLAYED'::text, NULL::text;
    RETURN;
  END;
  IF result IS NOT NULL THEN
    RETURN QUERY SELECT result, NULL::text;
    RETURN;
  END IF;

  -- 3. The signer must still be an active administrator on the same session
  --    generation (a logout or revocation after signing voids the approval).
  SELECT u.role::text, u.status::text, u."tokenVersion" INTO actor_role, actor_status, actor_version
  FROM public.users u WHERE u.id = actor_id FOR SHARE;
  IF NOT FOUND OR actor_status <> 'ACTIVE' OR actor_role NOT IN ('ADMIN', 'SUPER_ADMIN')
     OR actor_version <> actor_token_version THEN
    RETURN QUERY SELECT 'ACTOR_FORBIDDEN'::text, NULL::text;
    RETURN;
  END IF;

  -- 4. The narrow transition itself.
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
      'status', target_status, 'reason', reason,
      'refreshSessionsRevoked', target_status = 'SUSPENDED',
      'boundary', 'staff_set_member_status/v2', 'approvalNonce', approval_nonce,
      'approvalKeyId', approval_key_id, 'databaseLogin', session_user::text));
  RETURN QUERY SELECT 'OK'::text, pg_catalog.to_char(stamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END
$body$
$create$;

  REVOKE ALL ON TABLE staff_status_approval.keys, staff_status_approval.approvals FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.staff_set_member_status(text, text, text, text, text, integer, text, text, text, text),
    staff_status_approval.install_key(text, bytea), staff_status_approval.retire_key(text),
    staff_status_approval.approvals_append_only() FROM PUBLIC;

  -- Fail closed on anything in the private schema that is not the owner's
  -- alone: a planted object, or a grant made by hand since the last install.
  SELECT pg_catalog.string_agg(what, ', ' ORDER BY what) INTO stray FROM (
    SELECT 'schema staff_status_approval' AS what
    FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    WHERE n.oid = private_ns AND a.grantee <> users_owner
    UNION
    SELECT 'relation ' || c.oid::regclass::text FROM pg_catalog.pg_class c
    WHERE c.relnamespace = private_ns AND (c.relowner <> users_owner OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE a.grantee <> users_owner))
    UNION
    SELECT 'column ' || c.oid::regclass::text || '.' || att.attname FROM pg_catalog.pg_attribute att
    JOIN pg_catalog.pg_class c ON c.oid = att.attrelid, pg_catalog.aclexplode(att.attacl) a
    WHERE c.relnamespace = private_ns AND att.attacl IS NOT NULL AND a.grantee <> users_owner
    UNION
    SELECT 'function ' || p.oid::regprocedure::text FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = private_ns AND (p.proowner <> users_owner OR EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      WHERE a.grantee <> users_owner))
    UNION
    SELECT 'type ' || t.oid::regtype::text FROM pg_catalog.pg_type t
    WHERE t.typnamespace = private_ns AND t.typowner <> users_owner
  ) found;
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'staff_status_approval must be reachable by its owner only; found: %', stray;
  END IF;
END
$install$;
