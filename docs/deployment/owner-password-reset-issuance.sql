-- Owner password-reset issuance records (dormant; operator-applied, never a
-- Prisma migration).
--
-- Run only as the owner of public.users, in an isolated owner maintenance
-- connection, after current migrations: psql -X -v ON_ERROR_STOP=1 -f <this file>.
-- One atomic statement. It grants EXECUTE to nobody.
--
-- Why: a reset link is an HMAC over its claims, keyed from JWT_ACCESS_SECRET.
-- Completion checked only that HMAC and the account's current tokenVersion, so
-- any holder of the secret could write a working link for any active account
-- without the database-owner authority that issuance requires
-- (docs/deployment/signing-authority.md, finding 1). With this installed:
--
--   * the owner CLI (scripts/owner-password-reset.ts, as the database owner)
--     records every link it issues: nonce, account, version, expiry;
--   * with PASSWORD_RESET_ISSUANCE=enforce, completion must consume a matching,
--     unexpired, unconsumed record through public.owner_password_reset_consume
--     in the same transaction that changes the password. A link nobody issued,
--     a replay, a different account or version, or an expired record is refused
--     like any invalid link. Without the function or its EXECUTE grant, resets
--     fail closed (503).
--
-- The records live in their own schema, owner_password_reset: the runtime
-- grant routine grants DML on every table in public. The installer refuses a
-- pre-existing schema of that name owned by anyone else, and any object there
-- owned by, or any privilege there held by, anyone but the owner.
--
-- Activation (operator): install, then
--   GRANT EXECUTE ON FUNCTION public.owner_password_reset_consume(text, text, integer) TO <credential login>;
-- then set PASSWORD_RESET_ISSUANCE=enforce on the API. Links issued before the
-- install have no record and stop working once enforced (they last 15 minutes).
-- Disable: unset PASSWORD_RESET_ISSUANCE (records are kept), or
--   DROP FUNCTION IF EXISTS public.owner_password_reset_consume(text, text, integer);
DO $install$
DECLARE
  users_owner oid;
  private_ns oid;
  stray text;
BEGIN
  SELECT c.relowner INTO users_owner FROM pg_catalog.pg_class c WHERE c.oid = 'public.users'::regclass;
  IF users_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'reset issuance records must be installed by the owner of public.users';
  END IF;

  SELECT n.oid INTO private_ns FROM pg_catalog.pg_namespace n WHERE n.nspname = 'owner_password_reset';
  IF private_ns IS NULL THEN
    CREATE SCHEMA owner_password_reset;
  ELSIF (SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.oid = private_ns) <> users_owner THEN
    RAISE EXCEPTION 'schema owner_password_reset exists and is not owned by the owner of public.users';
  END IF;
  private_ns := 'owner_password_reset'::regnamespace;
  REVOKE ALL ON SCHEMA owner_password_reset FROM PUBLIC;

  EXECUTE $issuances$
CREATE TABLE IF NOT EXISTS owner_password_reset.issuances (
  nonce uuid PRIMARY KEY,
  user_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_by text NOT NULL DEFAULT session_user,
  consumed_at timestamptz,
  consumed_by text
)$issuances$;
  -- Evidence: never deleted or truncated; only an unconsumed record may be
  -- marked consumed, once, and nothing else about it may change.
  EXECUTE $guard$
CREATE OR REPLACE FUNCTION owner_password_reset.issuances_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND NEW.nonce = OLD.nonce AND NEW.user_id = OLD.user_id AND NEW.version = OLD.version
     AND NEW.expires_at = OLD.expires_at AND NEW.issued_at = OLD.issued_at AND NEW.issued_by = OLD.issued_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'owner_password_reset.issuances records are only ever consumed, once';
END
$body$$guard$;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'owner_password_reset.issuances'::regclass
                 AND tgname = 'issuances_guard') THEN
    EXECUTE 'CREATE TRIGGER issuances_guard BEFORE UPDATE OR DELETE ON owner_password_reset.issuances
             FOR EACH ROW EXECUTE FUNCTION owner_password_reset.issuances_guard()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'owner_password_reset.issuances'::regclass
                 AND tgname = 'issuances_no_truncate') THEN
    EXECUTE 'CREATE TRIGGER issuances_no_truncate BEFORE TRUNCATE ON owner_password_reset.issuances
             FOR EACH STATEMENT EXECUTE FUNCTION owner_password_reset.issuances_guard()';
  END IF;

  -- Called by the owner CLI inside its issuance transaction (owner only).
  EXECUTE $record$
CREATE OR REPLACE FUNCTION owner_password_reset.record_issuance(
  p_nonce uuid, p_user_id text, p_version integer, p_expires_at timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_nonce IS NULL OR p_user_id IS NULL OR p_version IS NULL OR p_version < 0
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.clock_timestamp()
     OR p_expires_at > pg_catalog.clock_timestamp() + interval '16 minutes' THEN
    RAISE EXCEPTION 'invalid reset issuance';
  END IF;
  INSERT INTO owner_password_reset.issuances (nonce, user_id, version, expires_at)
  VALUES (p_nonce, p_user_id, p_version, p_expires_at);
END
$body$$record$;

  -- The only entry point for completion. Consumes the record or reports that
  -- there is none to consume; never says why (forged, replayed, expired,
  -- another account or version all read as NOT_ISSUED).
  EXECUTE $consume$
CREATE OR REPLACE FUNCTION public.owner_password_reset_consume(
  p_nonce text, p_user_id text, p_version integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  nonce_value uuid;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_user_id IS NULL OR p_version IS NULL THEN
    RETURN 'NOT_ISSUED';
  END IF;
  nonce_value := p_nonce::uuid;
  UPDATE owner_password_reset.issuances i
     SET consumed_at = pg_catalog.clock_timestamp(), consumed_by = session_user::text
   WHERE i.nonce = nonce_value AND i.user_id = p_user_id AND i.version = p_version
     AND i.consumed_at IS NULL AND i.expires_at > pg_catalog.clock_timestamp();
  IF FOUND THEN
    RETURN 'OK';
  END IF;
  RETURN 'NOT_ISSUED';
END
$body$$consume$;

  REVOKE ALL ON TABLE owner_password_reset.issuances FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.owner_password_reset_consume(text, text, integer),
    owner_password_reset.record_issuance(uuid, text, integer, timestamptz),
    owner_password_reset.issuances_guard() FROM PUBLIC;

  SELECT pg_catalog.string_agg(what, ', ' ORDER BY what) INTO stray FROM (
    SELECT 'schema owner_password_reset' AS what
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
    RAISE EXCEPTION 'owner_password_reset must be reachable by its owner only; found: %', stray;
  END IF;
END
$install$;
