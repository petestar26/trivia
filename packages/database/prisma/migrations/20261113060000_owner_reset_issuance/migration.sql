BEGIN;
-- Install only as the database owner. No runtime grants are implicit.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d
    JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
    WHERE d.datname = current_database() AND r.rolname = current_user) THEN
    RAISE EXCEPTION 'Database owner authorization required';
  END IF;
END $$;
CREATE SCHEMA password_reset_private;
REVOKE ALL ON SCHEMA password_reset_private FROM PUBLIC;
CREATE TABLE password_reset_private.issuances (
  nonce uuid PRIMARY KEY,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('USER','MODERATOR','ADMIN','SUPER_ADMIN')),
  token_version integer NOT NULL CHECK (token_version >= 0),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '16 minutes')
);
REVOKE ALL ON password_reset_private.issuances FROM PUBLIC;
CREATE FUNCTION public.consume_owner_password_reset(
  p_nonce uuid, p_user_id text, p_role text, p_version integer, p_expiry timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE n integer;
BEGIN
  UPDATE password_reset_private.issuances SET consumed_at = clock_timestamp()
    WHERE nonce = p_nonce AND user_id = p_user_id AND role = p_role
      AND token_version = p_version AND expires_at = p_expiry
      AND consumed_at IS NULL AND expires_at > clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION public.consume_owner_password_reset(uuid,text,text,integer,timestamptz) FROM PUBLIC;
-- Existing default ACLs may grant named roles, not just PUBLIC. Remove them too.
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_roles r
    JOIN (
      SELECT a.grantee FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(n.nspacl) a WHERE n.nspname='password_reset_private'
      UNION
      SELECT a.grantee FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace,
        LATERAL pg_catalog.aclexplode(c.relacl) a WHERE n.nspname='password_reset_private'
      UNION
      SELECT a.grantee FROM pg_catalog.pg_proc p,
        LATERAL pg_catalog.aclexplode(p.proacl) a
        WHERE p.oid='public.consume_owner_password_reset(uuid,text,text,integer,timestamptz)'::regprocedure
    ) grants ON grants.grantee=r.oid WHERE r.rolname <> current_user
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA password_reset_private FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON password_reset_private.issuances FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION public.consume_owner_password_reset(uuid,text,text,integer,timestamptz) FROM %I', role_name);
  END LOOP;
END $$;
COMMIT;
