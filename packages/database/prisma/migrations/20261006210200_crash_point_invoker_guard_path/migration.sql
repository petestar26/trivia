-- Match the invoker-function path required by the platform invariant.
ALTER FUNCTION public.crash_point_slot_guard() SET search_path = public, pg_temp;
