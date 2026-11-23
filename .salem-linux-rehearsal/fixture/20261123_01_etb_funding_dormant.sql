-- Versioned supplemental owner migration; not auto-run by Prisma.
-- This file is not live approval. It binds to the existing 133 migration history,
-- assumes a restricted playqube_app, and preserves the existing global P2P switch.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL transaction_timeout = '2min';
SET LOCAL idle_in_transaction_session_timeout = '15s';

-- Section: sql/staff-storage-and-boundaries.review.sql (input SHA-256 0b324158bf3d3a9b5e5eb8c88eb3d9a249653448c422068b22b293f385a8e216)
-- Review candidate only: guarded owner install, not a portable Prisma migration.
-- No designation, staff enrollment, payment gate, or ordinary runtime grant changes.
SELECT pg_advisory_xact_lock(481516,2342);
DO $$
DECLARE runtime_oid oid; owner_oid oid; historical_count integer; historical_digest text;
BEGIN
 IF current_setting('server_version_num')::int / 10000 <> 18 OR current_user <> session_user THEN
   RAISE EXCEPTION 'Expected direct PostgreSQL 18 owner connection';
 END IF;
 SELECT oid INTO owner_oid FROM pg_roles WHERE rolname=current_user AND rolsuper;
 IF owner_oid IS NULL OR 4 <> (
   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND c.relowner=owner_oid
     AND c.relname IN ('_prisma_migrations','users','agents','agent_payment_accounts')
 ) THEN RAISE EXCEPTION 'Expected direct baseline table owner'; END IF;
 SELECT count(*), encode(sha256(convert_to(
   string_agg(migration_name || ':' || checksum, chr(10) ORDER BY migration_name COLLATE "C"), 'UTF8')), 'hex')
 INTO historical_count, historical_digest FROM public._prisma_migrations
 WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL;
 IF historical_count<>133 OR historical_digest IS DISTINCT FROM 'b53e162e3fa54d1f63a0e2b9f49bb0fae70de14dde16a863d89e1cc5aaf171c2' OR EXISTS (
   SELECT 1 FROM public._prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NULL
 ) THEN RAISE EXCEPTION 'Unexpected active migration history'; END IF;
 SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname='playqube_app' AND rolcanlogin
    AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
 IF runtime_oid IS NULL OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=runtime_oid)
   OR has_database_privilege(runtime_oid,current_database(),'CREATE')
   OR has_schema_privilege(runtime_oid,'public','CREATE')
   OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relowner=runtime_oid)
 THEN RAISE EXCEPTION 'Restricted playqube_app prerequisite not met'; END IF;
 IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('staff_access','staff_entrypoints'))
   OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('salem_direct_guard_owner','salem_manager_review_owner'))
 THEN RAISE EXCEPTION 'Staff namespaces and helper roles must not already exist'; END IF;
END $$;

CREATE SCHEMA staff_access;
REVOKE ALL ON SCHEMA staff_access FROM PUBLIC;
CREATE TABLE staff_access.main_admin (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT
);
-- Epoch history is permanent: restoration never reuses an earlier generation.
CREATE TABLE staff_access.issuer_epoch_audit (
  issuer_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL CHECK (epoch > 0),
  previous_epoch bigint,
  reason text NOT NULL CHECK (reason IN ('INITIAL','AUTHORITY_LOST','OWNER_REMOVED','OWNER_CHANGED')),
  old_role text, new_role text, old_status text, new_status text,
  replacement_owner_id text REFERENCES public.users(id) ON DELETE RESTRICT,
  database_principal text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(issuer_id,epoch),
  FOREIGN KEY(issuer_id,previous_epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT,
  CHECK ((epoch=1 AND previous_epoch IS NULL AND reason='INITIAL')
    OR (epoch>1 AND previous_epoch IS NOT NULL AND previous_epoch=epoch-1 AND reason<>'INITIAL'))
);
CREATE TABLE staff_access.issuer_state (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL,
  FOREIGN KEY(user_id,epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT
);
CREATE FUNCTION staff_access.validate_issuer_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Issuer epochs cannot be removed'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.epoch<>1 OR EXISTS(SELECT 1 FROM staff_access.issuer_epoch_audit WHERE issuer_id=NEW.user_id AND epoch>1) THEN
      RAISE EXCEPTION 'Issuer epoch cannot be reset';
    END IF;
  ELSE
    IF NEW.user_id<>OLD.user_id OR NEW.epoch<>OLD.epoch+1 OR NOT EXISTS(
      SELECT 1 FROM staff_access.issuer_epoch_audit WHERE issuer_id=NEW.user_id
        AND epoch=NEW.epoch AND previous_epoch=OLD.epoch) THEN
      RAISE EXCEPTION 'Issuer epoch requires a new immutable loss event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_issuer_state BEFORE INSERT OR UPDATE OR DELETE ON staff_access.issuer_state
  FOR EACH ROW EXECUTE FUNCTION staff_access.validate_issuer_state();
CREATE FUNCTION staff_access.ensure_issuer(p_user text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM staff_access.issuer_state WHERE user_id=p_user) THEN RETURN; END IF;
  INSERT INTO staff_access.issuer_epoch_audit(issuer_id,epoch,reason) VALUES(p_user,1,'INITIAL');
  INSERT INTO staff_access.issuer_state(user_id,epoch) VALUES(p_user,1);
END;
$$;
CREATE FUNCTION staff_access.invalidate_issuer(p_user text,p_reason text,p_old_role text,p_new_role text,
  p_old_status text,p_new_status text,p_replacement text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prior bigint;
BEGIN
  SELECT epoch INTO prior FROM staff_access.issuer_state WHERE user_id=p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO staff_access.issuer_epoch_audit(issuer_id,epoch,previous_epoch,reason,old_role,new_role,
    old_status,new_status,replacement_owner_id)
    VALUES(p_user,prior+1,prior,p_reason,p_old_role,p_new_role,p_old_status,p_new_status,p_replacement);
  UPDATE staff_access.issuer_state SET epoch=prior+1 WHERE user_id=p_user;
END;
$$;
-- These triggers intentionally do NOT take the staff advisory lock. Existing
-- status/role writers already hold a User row lock; reversing gate->User order
-- would deadlock. Authorized operations hold User SHARE before epoch SHARE.
CREATE FUNCTION staff_access.on_issuer_authority_loss() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path=pg_catalog,staff_access AS $$
BEGIN
  IF (OLD.status::text='ACTIVE' AND NEW.status::text<>'ACTIVE')
    OR (OLD.role::text IN ('ADMIN','SUPER_ADMIN') AND NEW.role::text NOT IN ('ADMIN','SUPER_ADMIN'))
    OR (OLD.role::text='SUPER_ADMIN' AND NEW.role::text='ADMIN') THEN
    PERFORM staff_access.invalidate_issuer(OLD.id,'AUTHORITY_LOST',OLD.role::text,NEW.role::text,
      OLD.status::text,NEW.status::text,NULL);
  END IF;
  RETURN NEW;
END;
$$;
-- Public User authority-loss trigger belongs to a separate activation review.
CREATE FUNCTION staff_access.on_owner_designation() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path=pg_catalog,staff_access AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM staff_access.invalidate_issuer(OLD.user_id,'OWNER_REMOVED',NULL,NULL,NULL,NULL,NULL);
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    PERFORM staff_access.invalidate_issuer(OLD.user_id,'OWNER_CHANGED',NULL,NULL,NULL,NULL,NEW.user_id);
  END IF;
  PERFORM staff_access.ensure_issuer(NEW.user_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER staff_owner_designation BEFORE INSERT OR UPDATE OR DELETE ON staff_access.main_admin
  FOR EACH ROW EXECUTE FUNCTION staff_access.on_owner_designation();
REVOKE ALL ON FUNCTION staff_access.ensure_issuer(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_access.invalidate_issuer(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_access.on_issuer_authority_loss() FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_access.on_owner_designation() FROM PUBLIC;
CREATE TABLE staff_access.owner_transfer_audit (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issuer_epoch bigint NOT NULL,
  next_admin_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_key text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (actor_id<>next_admin_id),
  UNIQUE(actor_id,request_key),
  FOREIGN KEY(actor_id,issuer_epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT
);
CREATE TABLE staff_access.managers (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT false
);
CREATE TABLE staff_access.permission_audit (
  id text PRIMARY KEY,
  issuer_epoch bigint NOT NULL,
  actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  manager_id text NOT NULL REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (permission IN ('agent:invite','agent:directory:read','agent:payment-account:recommend')),
  active boolean NOT NULL,
  expires_at timestamptz,
  previous_revision_id text,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128 AND btrim(request_key) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE(actor_id,request_key),
  FOREIGN KEY(actor_id,issuer_epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT,
  UNIQUE(id,manager_id,permission),
  UNIQUE(id,manager_id,permission,actor_id,active),
  CHECK (previous_revision_id IS NULL OR previous_revision_id<>id),
  CHECK (active OR expires_at IS NULL),
  FOREIGN KEY(previous_revision_id,manager_id,permission)
    REFERENCES staff_access.permission_audit(id,manager_id,permission) ON DELETE RESTRICT
);
-- Deliberate storage version boundary: never recreate legacy grants/invitations
-- aliases. Older staff binaries must fail closed on application rollback.
CREATE TABLE staff_access.grant_records (
  manager_id text NOT NULL REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  permission text NOT NULL CHECK (permission IN ('agent:invite', 'agent:directory:read', 'agent:payment-account:recommend')),
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  issuer_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  revision_id text NOT NULL UNIQUE,
  PRIMARY KEY (manager_id, permission),
  FOREIGN KEY(revision_id,manager_id,permission,issuer_id,active)
    REFERENCES staff_access.permission_audit(id,manager_id,permission,actor_id,active) ON DELETE RESTRICT
);
CREATE FUNCTION staff_access.validate_grant_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event staff_access.permission_audit;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Revoke permissions instead of deleting history'; END IF;
  SELECT * INTO event FROM staff_access.permission_audit WHERE id=NEW.revision_id;
  IF NOT FOUND OR event.expires_at IS DISTINCT FROM NEW.expires_at
    OR event.manager_id<>NEW.manager_id OR event.permission<>NEW.permission
    OR event.actor_id<>NEW.issuer_id OR event.active<>NEW.active THEN
    RAISE EXCEPTION 'Grant requires exact audited revision';
  END IF;
  IF TG_OP='INSERT' AND event.previous_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'Initial revision cannot name a predecessor';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.manager_id<>OLD.manager_id OR NEW.permission<>OLD.permission
    OR event.previous_revision_id IS DISTINCT FROM OLD.revision_id) THEN
    RAISE EXCEPTION 'Grant revision must extend current history';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_grant_revision BEFORE INSERT OR UPDATE OR DELETE ON staff_access.grant_records
  FOR EACH ROW EXECUTE FUNCTION staff_access.validate_grant_revision();
CREATE TABLE staff_access.invitation_records (
  id text PRIMARY KEY,
  issuer_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issuer_epoch bigint NOT NULL,
  FOREIGN KEY(issuer_id,issuer_epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  manager_id text NOT NULL REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  recipient_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz,
  accepted_at timestamptz,
  assignment_id text UNIQUE,
  CHECK ((accepted_at IS NULL) = (assignment_id IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  UNIQUE (id, agent_id, manager_id)
);
CREATE TABLE staff_access.assignments (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  manager_id text NOT NULL REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  invitation_id text UNIQUE REFERENCES staff_access.invitation_records(id) ON DELETE RESTRICT,
  previous_assignment_id text UNIQUE REFERENCES staff_access.assignments(id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((invitation_id IS NULL) <> (previous_assignment_id IS NULL)),
  UNIQUE (id, agent_id),
  UNIQUE (id, invitation_id),
  UNIQUE (id, previous_assignment_id),
  CHECK (previous_assignment_id IS NULL OR previous_assignment_id <> id),
  UNIQUE (id, agent_id, manager_id),
  FOREIGN KEY (invitation_id, agent_id, manager_id)
    REFERENCES staff_access.invitation_records(id, agent_id, manager_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_assignment_id, agent_id)
    REFERENCES staff_access.assignments(id, agent_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX one_active_manager_per_agent
  ON staff_access.assignments(agent_id) WHERE ended_at IS NULL;
ALTER TABLE staff_access.invitation_records ADD CONSTRAINT accepted_assignment_fk
  FOREIGN KEY (assignment_id, id) REFERENCES staff_access.assignments(id, invitation_id) ON DELETE RESTRICT;
CREATE TABLE staff_access.audit (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('INVITE_CREATED', 'INVITE_REVOKED', 'INVITE_ACCEPTED', 'AGENT_REASSIGNED')),
  agent_id text NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  manager_id text NOT NULL REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  invitation_id text REFERENCES staff_access.invitation_records(id) ON DELETE RESTRICT,
  assignment_id text REFERENCES staff_access.assignments(id) ON DELETE RESTRICT,
  previous_assignment_id text REFERENCES staff_access.assignments(id) ON DELETE RESTRICT,
  request_key text,
  created_at timestamptz NOT NULL,
  UNIQUE (actor_id, action, request_key),
  FOREIGN KEY (assignment_id, agent_id, manager_id)
    REFERENCES staff_access.assignments(id, agent_id, manager_id) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id, invitation_id)
    REFERENCES staff_access.assignments(id, invitation_id) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id, previous_assignment_id)
    REFERENCES staff_access.assignments(id, previous_assignment_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_assignment_id, agent_id)
    REFERENCES staff_access.assignments(id, agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (invitation_id, agent_id, manager_id)
    REFERENCES staff_access.invitation_records(id, agent_id, manager_id) ON DELETE RESTRICT,
  CHECK (
    (action IN ('INVITE_CREATED','INVITE_REVOKED') AND invitation_id IS NOT NULL
      AND assignment_id IS NULL AND previous_assignment_id IS NULL AND request_key IS NULL)
    OR (action = 'INVITE_ACCEPTED' AND invitation_id IS NOT NULL AND assignment_id IS NOT NULL
      AND previous_assignment_id IS NULL AND request_key IS NULL)
    OR (action = 'AGENT_REASSIGNED' AND invitation_id IS NULL AND assignment_id IS NOT NULL
      AND previous_assignment_id IS NOT NULL AND request_key IS NOT NULL)
  )
);
CREATE FUNCTION staff_access.preserve_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Staff history cannot be deleted'; END IF;
  -- Resolve assignment-only fields only for that relation. Boolean AND does
  -- not protect record-field resolution on audit rows lacking ended_at.
  IF TG_TABLE_NAME = 'assignments' THEN
    IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
       AND (to_jsonb(OLD) - 'ended_at') = (to_jsonb(NEW) - 'ended_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Staff history cannot be rewritten';
END;
$$;
CREATE TRIGGER preserve_assignment_history BEFORE UPDATE OR DELETE ON staff_access.assignments
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
CREATE TRIGGER preserve_permission_audit BEFORE UPDATE OR DELETE ON staff_access.permission_audit
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
CREATE TRIGGER preserve_staff_audit BEFORE UPDATE OR DELETE ON staff_access.audit
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
-- Invitation identity/recipient/secret never changes; only consume or revoke.
CREATE FUNCTION staff_access.preserve_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invitation history cannot be deleted'; END IF;
  IF (to_jsonb(OLD) - ARRAY['revoked_at','accepted_at','assignment_id']) <>
     (to_jsonb(NEW) - ARRAY['revoked_at','accepted_at','assignment_id'])
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
         OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id)) THEN
    RAISE EXCEPTION 'Invitation identity/history cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_invitation_history BEFORE UPDATE OR DELETE ON staff_access.invitation_records
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_invitation();

CREATE TRIGGER preserve_issuer_epoch_audit BEFORE UPDATE OR DELETE ON staff_access.issuer_epoch_audit
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
CREATE TRIGGER preserve_owner_transfer_audit BEFORE UPDATE OR DELETE ON staff_access.owner_transfer_audit
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
CREATE FUNCTION staff_access.prevent_authority_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Authority history cannot be truncated'; END;
$$;
CREATE TRIGGER no_owner_truncate BEFORE TRUNCATE ON staff_access.main_admin
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();
CREATE TRIGGER no_issuer_state_truncate BEFORE TRUNCATE ON staff_access.issuer_state
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();
CREATE TRIGGER no_issuer_history_truncate BEFORE TRUNCATE ON staff_access.issuer_epoch_audit
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();
CREATE TRIGGER no_permission_history_truncate BEFORE TRUNCATE ON staff_access.permission_audit
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();
CREATE TRIGGER no_transfer_history_truncate BEFORE TRUNCATE ON staff_access.owner_transfer_audit
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();

-- Enrollment source SHA256: 324f573f255595215b0a734a7c6fe32ff1520dfaed22fa3150323bdfdfbcf3b3
-- DORMANT additive schema. Disposable tests only; not a registered migration.
-- Apply after the reviewed staff storage schema. Existing profiles are not adopted.
CREATE TABLE staff_access.enrollment_audit (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  issuer_epoch bigint NOT NULL,
  manager_id text NOT NULL UNIQUE REFERENCES staff_access.managers(user_id) ON DELETE RESTRICT,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128 AND btrim(request_key) <> ''),
  created_at timestamptz NOT NULL,
  CHECK (actor_id <> manager_id),
  UNIQUE (actor_id, request_key),
  FOREIGN KEY (actor_id,issuer_epoch) REFERENCES staff_access.issuer_epoch_audit(issuer_id,epoch) ON DELETE RESTRICT
);
REVOKE ALL ON staff_access.enrollment_audit FROM PUBLIC;
CREATE TRIGGER preserve_enrollment_audit BEFORE UPDATE OR DELETE ON staff_access.enrollment_audit
  FOR EACH ROW EXECUTE FUNCTION staff_access.preserve_history();
CREATE TRIGGER no_enrollment_truncate BEFORE TRUNCATE ON staff_access.enrollment_audit
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.prevent_authority_truncate();

-- Only newly created staff objects. Existing public consumers/ACLs unchanged.
REVOKE ALL ON ALL TABLES IN SCHEMA staff_access FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staff_access FROM PUBLIC;
DO $$ DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='staff_access' LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, staff_access',f.signature);
 END LOOP;
END;
$$;

CREATE TABLE staff_access.payment_account_recommendations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES public.agent_payment_accounts(id) ON DELETE RESTRICT,
  account_version timestamp(3) NOT NULL,
  agent_id text NOT NULL,
  manager_id text NOT NULL,
  assignment_id text NOT NULL,
  grant_revision_id text NOT NULL,
  permission text NOT NULL DEFAULT 'agent:payment-account:recommend'
    CHECK (permission = 'agent:payment-account:recommend'),
  decision text NOT NULL CHECK (decision IN ('RECOMMEND_APPROVAL', 'REQUEST_CHANGES')),
  recorded_at timestamptz NOT NULL,
  UNIQUE (account_id, account_version, assignment_id, grant_revision_id),
  FOREIGN KEY (assignment_id, agent_id, manager_id)
    REFERENCES staff_access.assignments(id, agent_id, manager_id) ON DELETE RESTRICT,
  FOREIGN KEY (grant_revision_id, manager_id, permission)
    REFERENCES staff_access.permission_audit(id, manager_id, permission) ON DELETE RESTRICT
);
REVOKE ALL ON staff_access.payment_account_recommendations FROM PUBLIC;
CREATE FUNCTION staff_access.refuse_recommendation_change()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Payment account recommendations are append-only';
END $$;
REVOKE ALL ON FUNCTION staff_access.refuse_recommendation_change() FROM PUBLIC;
CREATE TRIGGER preserve_recommendations
  BEFORE UPDATE OR DELETE OR TRUNCATE ON staff_access.payment_account_recommendations
  FOR EACH STATEMENT EXECUTE FUNCTION staff_access.refuse_recommendation_change();

-- Defense in depth for the new schema only. No owner row, staff identities,
-- routes, public trigger, runtime grants, credential change or backfill here.
REVOKE ALL ON SCHEMA staff_access FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA staff_access FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staff_access FROM PUBLIC;

CREATE ROLE salem_direct_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA staff_entrypoints;
REVOKE ALL ON SCHEMA staff_entrypoints FROM PUBLIC;
GRANT USAGE ON SCHEMA staff_entrypoints TO playqube_app;
GRANT USAGE ON SCHEMA staff_access,public TO salem_direct_guard_owner;

-- PostgreSQL row locks require UPDATE on at least one column. The non-login
-- function owner alone receives that right, not the request principal.
GRANT SELECT (id,status,role,"tokenVersion"), UPDATE (id) ON public.users TO salem_direct_guard_owner;
GRANT SELECT (singleton,user_id), UPDATE (singleton) ON staff_access.main_admin TO salem_direct_guard_owner;
GRANT SELECT (user_id,epoch), UPDATE (epoch) ON staff_access.issuer_state TO salem_direct_guard_owner;

CREATE FUNCTION staff_entrypoints.can_directly_approve(p_actor pg_catalog.text,p_version pg_catalog.int4)
RETURNS pg_catalog.bool
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,pg_temp
AS $$
DECLARE matching boolean;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 OR p_actor<>btrim(p_actor)
    OR p_version IS NULL OR p_version<0 THEN RETURN false; END IF;
  -- Match the current staff write lock order. Only the app's verified access
  -- token supplies the actor/version; the function emits no user data.
  PERFORM pg_catalog.pg_advisory_xact_lock(481516,2342);
  SELECT true INTO matching
    FROM staff_access.main_admin d JOIN public.users u ON u.id=d.user_id
    WHERE d.singleton AND d.user_id=p_actor AND u.status::text='ACTIVE'
      AND u.role::text IN ('ADMIN','SUPER_ADMIN') AND u."tokenVersion"=p_version
    FOR SHARE OF d,u;
  IF NOT COALESCE(matching,false) THEN RETURN false; END IF;
  PERFORM 1 FROM staff_access.issuer_state e WHERE e.user_id=p_actor FOR SHARE OF e;
  RETURN FOUND;
END
$$;
ALTER FUNCTION staff_entrypoints.can_directly_approve(pg_catalog.text,pg_catalog.int4) OWNER TO salem_direct_guard_owner;
REVOKE ALL ON FUNCTION staff_entrypoints.can_directly_approve(pg_catalog.text,pg_catalog.int4) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_entrypoints.can_directly_approve(pg_catalog.text,pg_catalog.int4) TO playqube_app;

CREATE ROLE salem_manager_review_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public,staff_access,staff_entrypoints TO salem_manager_review_owner;
GRANT SELECT (id,status,role,"tokenVersion"), UPDATE (id) ON public.users TO salem_manager_review_owner;
GRANT SELECT (id,status,"userId","displayName","countryId"), UPDATE (id) ON public.agents TO salem_manager_review_owner;
GRANT SELECT (id,"agentId","methodDefId",status,"safetyHold","updatedAt","countryId","accountDetails"), UPDATE (id)
  ON public.agent_payment_accounts TO salem_manager_review_owner;
GRANT SELECT (id,name,"countryId","isActive"), UPDATE(id) ON public.payment_method_definitions TO salem_manager_review_owner;
GRANT SELECT (singleton,user_id), UPDATE (singleton) ON staff_access.main_admin TO salem_manager_review_owner;
GRANT SELECT (user_id,epoch), UPDATE (epoch) ON staff_access.issuer_state TO salem_manager_review_owner;
GRANT SELECT (user_id,active), UPDATE (user_id) ON staff_access.managers TO salem_manager_review_owner;
GRANT SELECT (id,agent_id,manager_id,ended_at), UPDATE (id) ON staff_access.assignments TO salem_manager_review_owner;
GRANT SELECT (manager_id,permission,active,expires_at,issuer_id,revision_id), UPDATE (manager_id)
  ON staff_access.grant_records TO salem_manager_review_owner;
GRANT SELECT (id,manager_id,permission,active,expires_at,actor_id,issuer_epoch), UPDATE (id)
  ON staff_access.permission_audit TO salem_manager_review_owner;
GRANT SELECT (id,account_id,account_version,agent_id,manager_id,assignment_id,grant_revision_id,decision),
  INSERT (id,account_id,account_version,agent_id,manager_id,assignment_id,grant_revision_id,decision,recorded_at)
  ON staff_access.payment_account_recommendations TO salem_manager_review_owner;

-- Private helper. Only fixed entrypoints call it as the NOLOGIN owner.
-- SELECT FOR SHARE locks authority, application rows and method until commit.
CREATE FUNCTION staff_access.lock_payment_account_review(p_actor text,p_token integer,p_account text,p_action text)
RETURNS TABLE(admin_id text,account_version timestamp(3),agent_id text,manager_id text,
   assignment_id text,grant_id text,expires_at timestamptz,review_id text,
   agent_name text,method_name text,last_four text)
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE agent_user text;
DECLARE d record;
BEGIN
 IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 OR p_actor<>btrim(p_actor)
    OR p_account IS NULL OR length(p_account) NOT BETWEEN 1 AND 128 OR p_account<>btrim(p_account)
    OR p_token IS NULL OR p_token<0 OR p_action NOT IN ('READ','RECORD','FINALIZE') THEN RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(481516,2342);
 SELECT u.id INTO admin_id FROM staff_access.main_admin o JOIN public.users u ON u.id=o.user_id
  WHERE o.singleton=true AND u.status::text='ACTIVE' AND u.role::text IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF o,u;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM 1 FROM staff_access.issuer_state e WHERE e.user_id=admin_id FOR SHARE OF e;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM 1 FROM public.users u WHERE u.id=p_actor AND u.status::text='ACTIVE' AND u."tokenVersion"=p_token FOR SHARE OF u;
 IF NOT FOUND OR (p_action='RECORD' AND p_actor=admin_id) OR (p_action='FINALIZE' AND p_actor<>admin_id) THEN RETURN; END IF;

 SELECT p."updatedAt" AS version,a.id AS aid,a."userId" AS uid,
   left(a."displayName",120) AS aname,left(m.name,100) AS mname,
   CASE WHEN jsonb_typeof(p."accountDetails"->'accountNumber')='string'
    AND p."accountDetails"->>'accountNumber' ~ '^[0-9]{5,64}$'
    THEN right(p."accountDetails"->>'accountNumber',4) ELSE NULL END AS lastfour
 INTO d
 FROM public.agent_payment_accounts p
 JOIN public.agents a ON a.id=p."agentId"
 JOIN public.users u ON u.id=a."userId"
 JOIN public.payment_method_definitions m ON m.id=p."methodDefId"
 WHERE p.id=p_account AND p.status::text='PENDING_APPROVAL' AND NOT p."safetyHold"
   AND a.status::text='ACTIVE' AND u.status::text='ACTIVE' AND m."isActive"
   AND p."countryId"=m."countryId" AND p."countryId"=a."countryId"
 FOR SHARE OF p,a,u,m;
 IF NOT FOUND OR d.uid=p_actor OR d.aname='' OR d.mname='' THEN RETURN; END IF;
 account_version:=d.version; agent_id:=d.aid; agent_user:=d.uid;
 agent_name:=d.aname; method_name:=d.mname; last_four:=d.lastfour;
 SELECT a.id,a.manager_id INTO assignment_id,manager_id FROM staff_access.assignments a
   WHERE a.agent_id=d.aid AND a.ended_at IS NULL FOR SHARE OF a;
 IF NOT FOUND OR manager_id=admin_id OR manager_id=agent_user
   OR (p_actor<>admin_id AND p_actor<>manager_id) THEN RETURN; END IF;
 PERFORM 1 FROM public.users u JOIN staff_access.managers m ON m.user_id=u.id
   WHERE u.id=manager_id AND u.status::text='ACTIVE' AND m.active FOR SHARE OF u,m;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT g.revision_id,g.expires_at INTO grant_id,expires_at FROM staff_access.grant_records g
  JOIN staff_access.permission_audit q ON q.id=g.revision_id AND q.manager_id=g.manager_id
    AND q.permission=g.permission AND q.actor_id=g.issuer_id AND q.active=g.active
    AND q.expires_at IS NOT DISTINCT FROM g.expires_at
  JOIN staff_access.issuer_state e ON e.user_id=q.actor_id AND e.epoch=q.issuer_epoch
  WHERE g.manager_id=lock_payment_account_review.manager_id AND g.issuer_id=admin_id AND g.active
    AND g.permission='agent:payment-account:recommend' FOR SHARE OF g,q,e;
 IF NOT FOUND OR (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) THEN RETURN; END IF;
 IF p_actor=admin_id THEN
   SELECT r.id INTO review_id FROM staff_access.payment_account_recommendations r
   WHERE r.account_id=p_account AND r.account_version=d.version AND r.agent_id=d.aid
     AND r.manager_id=lock_payment_account_review.manager_id AND r.assignment_id=lock_payment_account_review.assignment_id
     AND r.grant_revision_id=grant_id AND r.decision='RECOMMEND_APPROVAL';
   IF NOT FOUND THEN RETURN; END IF;
 END IF;
 IF expires_at IS NOT NULL AND expires_at<=clock_timestamp() THEN RETURN; END IF;
 RETURN NEXT;
END;
$$;

CREATE FUNCTION staff_entrypoints.read_payment_account_review(p_actor text,p_token integer,p_account text)
RETURNS TABLE("expectedUpdatedAt" timestamp(3), authority text,"agentName" text,"methodName" text,"proposedLastFour" text,"reviewId" text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT a.account_version,CASE WHEN a.admin_id=p_actor THEN 'main-admin' ELSE 'manager' END,
   a.agent_name,a.method_name,a.last_four,a.review_id
 FROM staff_access.lock_payment_account_review(p_actor,p_token,p_account,'READ') a;
$$;
CREATE FUNCTION staff_entrypoints.record_payment_account_review(
 p_actor text,p_token integer,p_account text,p_version timestamp(3),p_id text,p_decision text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE scope record; kept text; existing record; instant timestamptz;
BEGIN
 IF p_id IS NULL OR p_id !~ '^[0-9a-f-]{36}$' OR p_decision IS NULL
  OR p_decision NOT IN ('RECOMMEND_APPROVAL','REQUEST_CHANGES') THEN RETURN NULL; END IF;
 SELECT * INTO scope FROM staff_access.lock_payment_account_review(p_actor,p_token,p_account,'RECORD');
 IF NOT FOUND OR p_version IS DISTINCT FROM scope.account_version THEN RETURN NULL; END IF;
 instant:=clock_timestamp();
 IF scope.expires_at IS NOT NULL AND scope.expires_at<=instant THEN RETURN NULL; END IF;
 INSERT INTO staff_access.payment_account_recommendations
  (id,account_id,account_version,agent_id,manager_id,assignment_id,grant_revision_id,decision,recorded_at)
 VALUES(p_id,p_account,p_version,scope.agent_id,p_actor,scope.assignment_id,scope.grant_id,p_decision,instant)
 ON CONFLICT(account_id,account_version,assignment_id,grant_revision_id) DO NOTHING RETURNING id INTO kept;
 IF FOUND THEN RETURN kept; END IF;
 SELECT r.id,r.decision INTO existing FROM staff_access.payment_account_recommendations r
 WHERE r.account_id=p_account AND r.account_version=p_version AND r.assignment_id=scope.assignment_id
   AND r.grant_revision_id=scope.grant_id AND r.manager_id=p_actor;
 IF NOT FOUND OR existing.decision<>p_decision THEN RETURN NULL; END IF;
 RETURN existing.id;
END;
$$;
CREATE FUNCTION staff_entrypoints.lock_payment_account_finalization(
 p_actor text,p_token integer,p_account text,p_version timestamp(3),p_review text)
RETURNS TABLE("expiresAt" timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT a.expires_at FROM staff_access.lock_payment_account_review(p_actor,p_token,p_account,'FINALIZE') a
 WHERE a.account_version=p_version AND a.review_id=p_review;
$$;
ALTER FUNCTION staff_access.lock_payment_account_review(text,integer,text,text) OWNER TO salem_manager_review_owner;
ALTER FUNCTION staff_entrypoints.read_payment_account_review(text,integer,text) OWNER TO salem_manager_review_owner;
ALTER FUNCTION staff_entrypoints.record_payment_account_review(text,integer,text,timestamp,text,text) OWNER TO salem_manager_review_owner;
ALTER FUNCTION staff_entrypoints.lock_payment_account_finalization(text,integer,text,timestamp,text) OWNER TO salem_manager_review_owner;
REVOKE ALL ON FUNCTION staff_access.lock_payment_account_review(text,integer,text,text),
 staff_entrypoints.read_payment_account_review(text,integer,text),
 staff_entrypoints.record_payment_account_review(text,integer,text,timestamp,text,text),
 staff_entrypoints.lock_payment_account_finalization(text,integer,text,timestamp,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_entrypoints.read_payment_account_review(text,integer,text),
 staff_entrypoints.record_payment_account_review(text,integer,text,timestamp,text,text),
 staff_entrypoints.lock_payment_account_finalization(text,integer,text,timestamp,text) TO playqube_app;

-- Section: sql/capacity.review.sql (input SHA-256 1a8acf9a709ac1020997b4e695346e4cc7d37a261a9d3c4ebb3b1a39cbb88d83)
-- Review-only schema, not a migration and not granted to any application.
CREATE SCHEMA deposit_capacity_review;
REVOKE ALL ON SCHEMA deposit_capacity_review FROM PUBLIC;
CREATE TABLE deposit_capacity_review.account (
  agent_id text PRIMARY KEY,
  remaining bigint NOT NULL CHECK (remaining >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0 AND held <= remaining)
);
CREATE TABLE deposit_capacity_review.hold (
  order_id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES deposit_capacity_review.account(agent_id),
  amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 2147483647),
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','CONSUMED','RELEASED'))
);

-- Call only inside the order transaction, with the immutable ETB order amount.
-- A false return means no new hold exists; the caller must abort order creation.
CREATE FUNCTION deposit_capacity_review.reserve(p_order text, p_agent text, p_amount bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE prior deposit_capacity_review.hold%ROWTYPE;
BEGIN
  IF p_order IS NULL OR p_agent IS NULL OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION 'Invalid deposit capacity request';
  END IF;
  PERFORM 1 FROM deposit_capacity_review.account WHERE agent_id=p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO prior FROM deposit_capacity_review.hold WHERE order_id=p_order;
  IF FOUND THEN
    IF prior.agent_id IS DISTINCT FROM p_agent OR prior.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'Order capacity binding mismatch';
    END IF;
    RETURN prior.state='HELD';
  END IF;
  UPDATE deposit_capacity_review.account SET held=held+p_amount
    WHERE agent_id=p_agent AND remaining-held>=p_amount;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO deposit_capacity_review.hold(order_id,agent_id,amount) VALUES(p_order,p_agent,p_amount);
  RETURN true;
END $$;

-- Lock order mirrors reserve (account, then hold). Call in the same transaction
-- as the single-winner settlement or cancellation and the member wallet write.
CREATE FUNCTION deposit_capacity_review.finish(p_order text, p_state text)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE h deposit_capacity_review.hold%ROWTYPE;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('CONSUMED','RELEASED') THEN RAISE EXCEPTION 'Invalid final state'; END IF;
  SELECT * INTO h FROM deposit_capacity_review.hold WHERE order_id=p_order;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM deposit_capacity_review.account WHERE agent_id=h.agent_id FOR UPDATE;
  SELECT * INTO STRICT h FROM deposit_capacity_review.hold WHERE order_id=p_order FOR UPDATE;
  IF h.state <> 'HELD' THEN RETURN false; END IF;
  UPDATE deposit_capacity_review.account
    SET held=held-h.amount, remaining=remaining-CASE WHEN p_state='CONSUMED' THEN h.amount ELSE 0 END
    WHERE agent_id=h.agent_id;
  UPDATE deposit_capacity_review.hold SET state=p_state WHERE order_id=p_order;
  RETURN true;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA deposit_capacity_review FROM PUBLIC;

-- Section: sql/funding.review.sql (input SHA-256 a3a46654752ff85b9f9f8af60cd4e2f4c0aef822180d5a0a5b6851e65b36afd6)
-- Local review only. No role grants, live references or seeded funds.
CREATE TABLE deposit_capacity_review.manager (
  manager_id text PRIMARY KEY,
  available bigint NOT NULL DEFAULT 0 CHECK (available>=0)
);
CREATE TABLE deposit_capacity_review.assignment (
  agent_id text PRIMARY KEY,
  manager_id text NOT NULL REFERENCES deposit_capacity_review.manager
);
CREATE TABLE deposit_capacity_review.movement (
  request_id text PRIMARY KEY,
  manager_id text NOT NULL REFERENCES deposit_capacity_review.manager,
  agent_id text,
  amount bigint NOT NULL CHECK (amount > 0),
  receipt_ref text UNIQUE,
  CHECK ((agent_id IS NULL) <> (receipt_ref IS NULL))
);
CREATE FUNCTION deposit_capacity_review.record_receipt(p_id text, p_manager text, p_amount bigint, p_receipt text)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp AS $$
DECLARE prior deposit_capacity_review.movement%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount<=0 OR NULLIF(btrim(p_receipt),'') IS NULL THEN
    RAISE EXCEPTION 'Valid amount and bank receipt required';
  END IF;
  PERFORM 1 FROM deposit_capacity_review.manager WHERE manager_id=p_manager FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO prior FROM deposit_capacity_review.movement WHERE request_id=p_id;
  IF FOUND THEN
    IF prior.manager_id=p_manager AND prior.agent_id IS NULL AND prior.amount=p_amount AND prior.receipt_ref=p_receipt THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Receipt request data mismatch';
  END IF;
  INSERT INTO deposit_capacity_review.movement VALUES(p_id,p_manager,NULL,p_amount,p_receipt);
  UPDATE deposit_capacity_review.manager SET available=available+p_amount WHERE manager_id=p_manager;
  RETURN true;
END $$;
CREATE FUNCTION deposit_capacity_review.allocate(p_id text, p_manager text, p_agent text, p_amount bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp AS $$
DECLARE prior deposit_capacity_review.movement%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'Valid amount required'; END IF;
  PERFORM 1 FROM deposit_capacity_review.manager WHERE manager_id=p_manager FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO prior FROM deposit_capacity_review.movement WHERE request_id=p_id;
  IF FOUND THEN
    IF prior.manager_id=p_manager AND prior.agent_id=p_agent AND prior.amount=p_amount AND prior.receipt_ref IS NULL THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'Allocation request data mismatch';
  END IF;
  PERFORM 1 FROM deposit_capacity_review.assignment WHERE agent_id=p_agent AND manager_id=p_manager FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE deposit_capacity_review.manager SET available=available-p_amount
    WHERE manager_id=p_manager AND available>=p_amount;
  IF NOT FOUND THEN RETURN false; END IF;
  -- ETB only. Production integration must also prove backed Coin capacity
  -- without treating ETB as Coins or funding the same obligation twice.
  INSERT INTO deposit_capacity_review.account(agent_id,remaining) VALUES(p_agent,p_amount)
    ON CONFLICT(agent_id) DO UPDATE SET remaining=deposit_capacity_review.account.remaining+excluded.remaining;
  INSERT INTO deposit_capacity_review.movement VALUES(p_id,p_manager,p_agent,p_amount,NULL);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION deposit_capacity_review.record_receipt(text,text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deposit_capacity_review.allocate(text,text,text,bigint) FROM PUBLIC;

-- Section: sql/backing.review.sql (input SHA-256 f95388afb8dbdde5c46ba487e0687d0dd328ee8599cd5c972b8b196a8aebab93)
-- The new enum value is referenced only in a function body; never executed during install.
ALTER TYPE public."InventoryLedgerType" ADD VALUE 'MANAGER_DEPOSIT_ALLOCATION';
CREATE FUNCTION deposit_capacity_review.establish_backing()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, pg_temp AS $$
DECLARE a deposit_capacity_review.account%ROWTYPE;
        i public.agent_inventories%ROWTYPE;
        prior bigint;
BEGIN
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT a FROM deposit_capacity_review.account WHERE agent_id=NEW.agent_id FOR UPDATE;
  prior := a.remaining - NEW.amount;
  IF prior<0 OR a.remaining>2147483647 THEN RAISE EXCEPTION 'Backing outside inventory bounds'; END IF;
  SELECT * INTO i FROM public.agent_inventories WHERE "agentId"=a.agent_id FOR UPDATE;
  IF NOT FOUND THEN
    IF prior<>0 OR a.held<>0 THEN RAISE EXCEPTION 'Missing backing inventory'; END IF;
    i."totalBalance":=0; i."reservedBalance":=0;
    INSERT INTO public.agent_inventories(id,"agentId","totalBalance","updatedAt")
      VALUES(gen_random_uuid()::text,a.agent_id,a.remaining::int,now());
  ELSE
    IF i."totalBalance"<>prior OR i."reservedBalance"<>a.held THEN
      RAISE EXCEPTION 'Legacy or non-reconciled backing; do not merge balances automatically';
    END IF;
    UPDATE public.agent_inventories SET "totalBalance"=a.remaining::int, version=version+1,"updatedAt"=now()
      WHERE id=i.id;
  END IF;
  INSERT INTO public.agent_inventory_ledger
    (id,"agentId",type,amount,"totalBefore","totalAfter","reservedBefore","reservedAfter",reason,"idempotencyKey")
    VALUES(gen_random_uuid()::text,a.agent_id,'MANAGER_DEPOSIT_ALLOCATION',NEW.amount::int,
      prior::int,a.remaining::int,i."reservedBalance",i."reservedBalance",'Manager operating-funds allocation','funding:'||NEW.request_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION deposit_capacity_review.establish_backing() FROM PUBLIC;
CREATE TRIGGER p2p_review_establish_backing AFTER INSERT ON deposit_capacity_review.movement
  FOR EACH ROW EXECUTE FUNCTION deposit_capacity_review.establish_backing();

-- Section: sql/reservation-integration.review.sql (input SHA-256 7b66eef63cc1151eab3dbd4eefb7326b2b5adad41ab241b85d6728bcc517c2b5)
-- Candidate adapter. Requires the capacity schema and a separate review of grants.
-- No account creation or funding here. Existing orders without a hold stay legacy.
CREATE TABLE deposit_capacity_review.release_switch (
  singleton boolean PRIMARY KEY CHECK(singleton),
  managed_admission_open boolean NOT NULL,
  funding_open boolean NOT NULL
);
INSERT INTO deposit_capacity_review.release_switch VALUES(true,false,false);
CREATE FUNCTION deposit_capacity_review.sync_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o record;
DECLARE admitted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'ACTIVE' THEN RETURN NEW; END IF;
    SELECT id, "agentId", "fiatCurrency", "fiatAmount" INTO STRICT o
      FROM public.agent_orders WHERE id=NEW."orderId";
    IF o."agentId" IS DISTINCT FROM NEW."agentId" THEN RAISE EXCEPTION 'Deposit agent mismatch'; END IF;
    IF o."fiatCurrency" <> 'ETB' OR NOT EXISTS (
      SELECT FROM deposit_capacity_review.account WHERE agent_id=o."agentId"
    ) THEN RETURN NEW; END IF;
    SELECT managed_admission_open INTO admitted FROM deposit_capacity_review.release_switch WHERE singleton FOR SHARE;
    IF admitted IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='P2P_MANAGED_DEPOSIT_ADMISSION_PAUSED';
    END IF;
    IF NOT deposit_capacity_review.reserve(o.id, o."agentId", o."fiatAmount"::bigint) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='P2P_DEPOSIT_CAPACITY_UNAVAILABLE';
    END IF;
  ELSIF OLD.status IS DISTINCT FROM NEW.status AND OLD.status::text='ACTIVE' AND
        NEW.status::text IN ('CONSUMED','RELEASED') THEN
    IF EXISTS (SELECT FROM deposit_capacity_review.hold WHERE order_id=OLD."orderId") AND
       NOT deposit_capacity_review.finish(OLD."orderId",NEW.status::text) THEN
      RAISE EXCEPTION 'Deposit capacity hold does not match reservation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION deposit_capacity_review.sync_reservation() FROM PUBLIC;
CREATE TRIGGER p2p_deposit_capacity_sync
  AFTER INSERT OR UPDATE OF status ON public.agent_reservations
  FOR EACH ROW EXECUTE FUNCTION deposit_capacity_review.sync_reservation();

-- Section: sql/staff-funding-boundary.review.sql (input SHA-256 fdbf31fe744ef3982020f2cac40c6bf4c3f5f6d58f91c20bcdd68a59af81e371)
-- Staging review only. Assumes staff_access's existing authority tables.
CREATE ROLE salem_funding_review_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
 NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA deposit_funding_entry;
REVOKE ALL ON SCHEMA deposit_funding_entry FROM PUBLIC;
GRANT USAGE ON SCHEMA deposit_funding_entry TO playqube_app;
GRANT USAGE ON SCHEMA public,staff_access,deposit_capacity_review,deposit_funding_entry TO salem_funding_review_owner;
GRANT SELECT (id,status,role,"tokenVersion"), UPDATE(id) ON public.users TO salem_funding_review_owner;
GRANT SELECT (id,status,"userId"), UPDATE(id) ON public.agents TO salem_funding_review_owner;
GRANT SELECT (singleton,user_id), UPDATE(singleton) ON staff_access.main_admin TO salem_funding_review_owner;
GRANT SELECT (user_id,active), UPDATE(user_id) ON staff_access.managers TO salem_funding_review_owner;
GRANT SELECT (agent_id,manager_id,ended_at), UPDATE(agent_id) ON staff_access.assignments TO salem_funding_review_owner;

GRANT SELECT,UPDATE(singleton) ON deposit_capacity_review.release_switch TO salem_funding_review_owner;

-- Keep financial tables inaccessible to the API role. The backing trigger uses
-- a trusted atomic operation, not a separately callable inventory top-up.
GRANT SELECT,INSERT,UPDATE ON deposit_capacity_review.manager,deposit_capacity_review.assignment,deposit_capacity_review.account
 TO salem_funding_review_owner;
GRANT SELECT,INSERT ON deposit_capacity_review.movement TO salem_funding_review_owner;
GRANT SELECT,INSERT,UPDATE ON public.agent_inventories TO salem_funding_review_owner;
GRANT INSERT ON public.agent_inventory_ledger TO salem_funding_review_owner;
GRANT EXECUTE ON FUNCTION deposit_capacity_review.record_receipt(text,text,bigint,text),
 deposit_capacity_review.allocate(text,text,text,bigint) TO salem_funding_review_owner;

-- Actor/version must come from a verified session, never from body parameters.
CREATE FUNCTION deposit_funding_entry.record_receipt(p_actor text,p_token int,p_manager text,p_amount bigint,p_request text,p_ref text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE writes_open boolean;
BEGIN
  IF p_actor IS NULL OR p_token IS NULL OR p_manager IS NULL OR p_manager=p_actor OR
     p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 128 OR
     p_ref IS NULL OR length(p_ref) NOT BETWEEN 4 AND 128 OR p_ref<>btrim(p_ref)
     THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(481516,2342);
  SELECT funding_open INTO writes_open FROM deposit_capacity_review.release_switch WHERE singleton FOR SHARE;
  IF writes_open IS DISTINCT FROM true THEN RETURN false; END IF;
  PERFORM 1 FROM staff_access.main_admin m JOIN public.users u ON u.id=m.user_id
   WHERE m.singleton AND m.user_id=p_actor AND u."tokenVersion"=p_token
     AND u.status::text='ACTIVE' AND u.role::text IN ('ADMIN','SUPER_ADMIN') FOR SHARE OF m,u;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM staff_access.managers m JOIN public.users u ON u.id=m.user_id
   WHERE m.user_id=p_manager AND m.active AND u.status::text='ACTIVE' FOR SHARE OF m,u;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO deposit_capacity_review.manager(manager_id) VALUES(p_manager) ON CONFLICT DO NOTHING;
  RETURN deposit_capacity_review.record_receipt('receipt:'||p_actor||':'||p_request,p_manager,p_amount,p_ref);
END $$;

CREATE FUNCTION deposit_funding_entry.allocate(p_actor text,p_token int,p_agent text,p_amount bigint,p_request text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE writes_open boolean;
BEGIN
  IF p_actor IS NULL OR p_token IS NULL OR p_agent IS NULL OR
     p_request IS NULL OR length(p_request) NOT BETWEEN 8 AND 128 THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(481516,2342);
  SELECT funding_open INTO writes_open FROM deposit_capacity_review.release_switch WHERE singleton FOR SHARE;
  IF writes_open IS DISTINCT FROM true THEN RETURN false; END IF;
  PERFORM 1 FROM staff_access.managers m JOIN public.users u ON u.id=m.user_id
   WHERE m.user_id=p_actor AND m.active AND u."tokenVersion"=p_token AND u.status::text='ACTIVE' FOR SHARE OF m,u;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM staff_access.assignments a
   JOIN public.agents g ON g.id=a.agent_id JOIN public.users u ON u.id=g."userId"
   WHERE a.ended_at IS NULL AND a.agent_id=p_agent AND a.manager_id=p_actor
     AND g.status::text='ACTIVE' AND u.status::text='ACTIVE' AND u.id<>p_actor FOR SHARE OF a,g,u;
  IF NOT FOUND OR NOT EXISTS (SELECT FROM deposit_capacity_review.manager WHERE manager_id=p_actor) THEN RETURN false; END IF;
  -- Materialize only after checking and locking the authoritative assignment;
  -- raw callers cannot call the inner function or alter this data.
  INSERT INTO deposit_capacity_review.assignment(agent_id,manager_id) VALUES(p_agent,p_actor)
     ON CONFLICT(agent_id) DO UPDATE SET manager_id=excluded.manager_id;
  RETURN deposit_capacity_review.allocate('allocation:'||p_actor||':'||p_request,p_actor,p_agent,p_amount);
END $$;
ALTER FUNCTION deposit_funding_entry.record_receipt(text,int,text,bigint,text,text) OWNER TO salem_funding_review_owner;
ALTER FUNCTION deposit_funding_entry.allocate(text,int,text,bigint,text) OWNER TO salem_funding_review_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA deposit_funding_entry FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA deposit_funding_entry TO playqube_app;

-- Section: sql/legacy-topup-fence.review.sql (input SHA-256 a8bb9eae2d15f27baa7fd2c82c085ba845324e7dcc3467b24c18735ec745b439)
-- Install with the backing changes, before any Manager allocation.
-- Legacy entrypoints always write a ledger entry in the same transaction;
-- refusing that entry rolls back their balance write even on older binaries.
CREATE FUNCTION deposit_capacity_review.fence_legacy_topup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.type::text IN ('INITIAL_ALLOCATION','ADMIN_ADJUSTMENT')
     AND EXISTS (SELECT FROM deposit_capacity_review.account WHERE agent_id=NEW."agentId") THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='P2P_MANAGER_BACKING_REQUIRES_ALLOCATION';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION deposit_capacity_review.fence_legacy_topup() FROM PUBLIC;
CREATE TRIGGER p2p_review_fence_legacy_topup BEFORE INSERT ON public.agent_inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION deposit_capacity_review.fence_legacy_topup();

-- Section: sql/eligibility.review.sql (input SHA-256 7cad0bd13a300acb6016b4e3834f684e8a852e4bbc53d6ab397d577ea933e811)
-- Owner installs only in disposable staging while the whole release is reviewed.
-- Explicit EXECUTE grant to the verified app role is a separate step.
CREATE FUNCTION public.p2p_etb_agent_can_cover(p_agent text, p_amount bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_amount BETWEEN 1 AND 2147483647 AND NOT EXISTS(
    SELECT 1 FROM deposit_capacity_review.account WHERE agent_id=p_agent AND remaining-held<p_amount
 )
$$;
REVOKE ALL ON FUNCTION public.p2p_etb_agent_can_cover(text,bigint) FROM PUBLIC;

-- Section: sql/staff-funding-targets.review.sql (input SHA-256 18577d08499fc761b2afb7cc0310c308a27aadbd04d88b1f34165f21069ff33c)
GRANT SELECT ("displayName",username) ON public.users TO salem_funding_review_owner;
GRANT SELECT ("displayName") ON public.agents TO salem_funding_review_owner;
CREATE FUNCTION deposit_funding_entry.targets(p_actor text,p_token int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE out_json jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM public.users u WHERE u.id=p_actor AND u."tokenVersion"=p_token AND u.status::text='ACTIVE') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT FROM staff_access.main_admin m JOIN public.users u ON m.user_id=u.id
     WHERE m.singleton AND m.user_id=p_actor AND u.role::text IN ('ADMIN','SUPER_ADMIN')) THEN
    SELECT jsonb_build_object('role','main-admin','targets',COALESCE(jsonb_agg(t ORDER BY t.label,t.id),'[]'::jsonb))
    INTO out_json FROM (SELECT u.id,COALESCE(NULLIF(u."displayName",''),u.username) AS label
      FROM staff_access.managers m JOIN public.users u ON m.user_id=u.id
      WHERE m.active AND u.status::text='ACTIVE' AND m.user_id<>p_actor ORDER BY 2,1 LIMIT 100) t;
    RETURN out_json;
  END IF;
  IF NOT EXISTS (SELECT FROM staff_access.managers m WHERE m.user_id=p_actor AND m.active) THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('role','manager','targets',COALESCE(jsonb_agg(t ORDER BY t.label,t.id),'[]'::jsonb))
  INTO out_json FROM (SELECT g.id,g."displayName" AS label FROM staff_access.assignments a
    JOIN public.agents g ON g.id=a.agent_id JOIN public.users u ON u.id=g."userId"
    WHERE a.ended_at IS NULL AND a.manager_id=p_actor AND g.status::text='ACTIVE'
      AND u.status::text='ACTIVE' AND u.id<>p_actor ORDER BY 2,1 LIMIT 100) t;
  RETURN out_json;
END $$;
ALTER FUNCTION deposit_funding_entry.targets(text,int) OWNER TO salem_funding_review_owner;
REVOKE ALL ON FUNCTION deposit_funding_entry.targets(text,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deposit_funding_entry.targets(text,int) TO playqube_app;
GRANT EXECUTE ON FUNCTION public.p2p_etb_agent_can_cover(text,bigint) TO playqube_app;

DO $$
BEGIN
 IF NOT EXISTS (SELECT FROM deposit_capacity_review.release_switch
   WHERE singleton AND NOT funding_open AND NOT managed_admission_open)
   OR EXISTS (SELECT FROM deposit_capacity_review.account)
   OR EXISTS (SELECT FROM deposit_capacity_review.manager)
   OR EXISTS (SELECT FROM staff_access.main_admin)
 THEN RAISE EXCEPTION 'Dormant boundaries not satisfied'; END IF;
 IF has_schema_privilege('playqube_app','deposit_capacity_review','USAGE')
   OR has_schema_privilege('playqube_app','staff_access','USAGE')
 THEN RAISE EXCEPTION 'Runtime private schema must remain inaccessible'; END IF;
END $$;
CREATE TABLE deposit_capacity_review.install_receipt (
  version text PRIMARY KEY CHECK (version = '20261123_01_etb_funding_dormant'),
  reviewed_bundle_sha256 text NOT NULL CHECK (reviewed_bundle_sha256 = '993217d502db6c40657d3c05ef5c98cbd625c4c63cdaf6da06db4076e4d20d76'),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON deposit_capacity_review.install_receipt FROM PUBLIC;
INSERT INTO deposit_capacity_review.install_receipt (version, reviewed_bundle_sha256)
VALUES ('20261123_01_etb_funding_dormant', '993217d502db6c40657d3c05ef5c98cbd625c4c63cdaf6da06db4076e4d20d76');
COMMIT;
