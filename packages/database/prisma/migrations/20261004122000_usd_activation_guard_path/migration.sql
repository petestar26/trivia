BEGIN;
-- Country has no inbound cascade to its own guard. Match the existing I3
-- non-privileged function policy; other USD guards remain pg_catalog-pinned.
ALTER FUNCTION public.payment_protect_usd_activation() SET search_path = public, pg_temp;
COMMIT;
