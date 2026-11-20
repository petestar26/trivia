-- P2P admission pause: a database-enforced, owner-only switch that stops NEW
-- agent deposit orders, withdrawal quotes and withdrawals from being inserted,
-- whatever API or worker version performs the insert. It is enforced by
-- BEFORE INSERT row triggers, so an API replica that predates this migration
-- honours it too. Ships unpaused: applying it changes no behaviour.
--
-- Not affected (INSERT-only gate on the three admission tables): settlement,
-- release, cancellation, refunds, expiry sweeps, appeals, held-deposit and
-- late-payment recovery, evidence and idempotent replays of already-accepted
-- orders (both services return the existing row before inserting). Crypto
-- deposits/withdrawals use their own tables and gates; commission and the
-- country/agent/rate controls are untouched.
--
-- Both functions keep the search path the existing invariant I3 expects of
-- them without being listed in it, so older and newer checkers both pass:
-- the SECURITY DEFINER guard is pinned to pg_catalog, pg_temp and names every
-- object by schema; the plain write guard is pinned to public, pg_temp.
-- ledger_apply_runtime_grants() is deliberately not wrapped.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.p2p_admission_control (
  id          smallint PRIMARY KEY CHECK (id = 1),
  paused      boolean NOT NULL DEFAULT false,
  reason      text,
  "changedBy" text,
  "changedAt" timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.p2p_admission_control (id, paused, reason, "changedBy")
VALUES (1, false, 'installed unpaused', 'migration');
REVOKE ALL ON public.p2p_admission_control FROM PUBLIC;

-- Runs as the owner so the runtime role needs no grant on the control row.
-- FOR SHARE makes the owner's pause UPDATE wait for every admission that has
-- already passed the guard; once the UPDATE commits, no later insert passes.
-- A missing row counts as paused (fail closed).
CREATE FUNCTION public.p2p_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE is_paused boolean;
BEGIN
  SELECT c.paused INTO is_paused FROM public.p2p_admission_control c WHERE c.id = 1 FOR SHARE;
  IF is_paused IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'P2P_ADMISSION_PAUSED: new P2P payment requests are paused (%)', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.p2p_admission_guard() FROM PUBLIC;

CREATE TRIGGER p2p_admission_guard BEFORE INSERT ON public.agent_orders
  FOR EACH ROW EXECUTE FUNCTION public.p2p_admission_guard();
CREATE TRIGGER p2p_admission_guard BEFORE INSERT ON public.withdrawal_quotes
  FOR EACH ROW EXECUTE FUNCTION public.p2p_admission_guard();
CREATE TRIGGER p2p_admission_guard BEFORE INSERT ON public.withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.p2p_admission_guard();

-- ledger_apply_runtime_grants() grants the runtime role DML on every table;
-- only the exact effective table-owner role may change the switch.
-- Membership alone is insufficient; an authorized operator must explicitly act as owner.
CREATE FUNCTION public.p2p_admission_control_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE table_owner oid; effective_role oid;
BEGIN
  SELECT c.relowner INTO table_owner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID;
  SELECT r.oid INTO effective_role FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
  IF table_owner IS NULL OR effective_role IS NULL OR table_owner IS DISTINCT FROM effective_role THEN
    RAISE EXCEPTION 'Only the effective table owner may change P2P admission' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The P2P admission control row cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW."changedAt" := pg_catalog.now(); END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.p2p_admission_control_guard() FROM PUBLIC;
CREATE TRIGGER p2p_admission_control_guard BEFORE INSERT OR UPDATE OR DELETE ON public.p2p_admission_control
  FOR EACH ROW EXECUTE FUNCTION public.p2p_admission_control_guard();

COMMIT;
