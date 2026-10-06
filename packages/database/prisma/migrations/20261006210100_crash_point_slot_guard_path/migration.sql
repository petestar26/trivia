-- Pin trigger resolution independently of caller settings.
ALTER FUNCTION public.crash_point_slot_guard() SET search_path = pg_catalog, pg_temp;
