BEGIN;
SET LOCAL lock_timeout = '20s';
-- Match the existing ledger's guard-function search-path invariant.
ALTER FUNCTION public.payment_protect_usd_snapshot() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.payment_protect_usd_rate() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.payment_protect_usd_activation() SET search_path = pg_catalog, pg_temp;
COMMIT;
