CREATE TABLE "agent_account_setups" (
  "userId" TEXT PRIMARY KEY REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdBy" TEXT NOT NULL,
  "credentialHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_setup_consumption" CHECK (("consumedAt" IS NULL AND "credentialHash" IS NOT NULL) OR ("consumedAt" IS NOT NULL AND "credentialHash" IS NULL))
);

-- Narrow owner-authorized transition; normal role/status guards remain unchanged.
CREATE FUNCTION public.activate_provisioned_agent(account_id text, expected_hash text, private_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE claimed integer;
BEGIN
  IF private_hash IS NULL OR private_hash !~ '^\$2[aby]\$12\$[./A-Za-z0-9]{53}$' THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.users WHERE id=account_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.users u JOIN public.agents a ON a."userId"=u.id
    WHERE u.id=account_id AND u.role::text='USER' AND u.status::text='PENDING_VERIFICATION'
      AND u."passwordHash" IS NULL AND a.status::text='ACTIVE') THEN RETURN false; END IF;
  UPDATE public.agent_account_setups SET "consumedAt"=clock_timestamp(), "credentialHash"=NULL
    WHERE "userId"=account_id AND "consumedAt" IS NULL AND "credentialHash"=expected_hash AND "expiresAt">clock_timestamp();
  GET DIAGNOSTICS claimed = ROW_COUNT;
  IF claimed <> 1 THEN RETURN false; END IF;
  UPDATE public.users SET status='ACTIVE', "passwordHash"=private_hash, "tokenVersion"="tokenVersion"+1, "updatedAt"=clock_timestamp() WHERE id=account_id;
  DELETE FROM public.sessions WHERE "userId"=account_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.activate_provisioned_agent(text,text,text) FROM PUBLIC;
