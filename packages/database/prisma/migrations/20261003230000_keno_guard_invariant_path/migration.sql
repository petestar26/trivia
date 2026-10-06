-- I3 pins non-cascade invoker functions to public, pg_temp. This guard does
-- not run through an owner-privileged FK cascade; preserve the invariant.
ALTER FUNCTION public.system_keno_practice_guard() SET search_path = public, pg_temp;
