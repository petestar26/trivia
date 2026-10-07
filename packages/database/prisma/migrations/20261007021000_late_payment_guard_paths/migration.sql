-- Match the canonical invoker guard policy without changing applied migration history.
ALTER FUNCTION public.guard_late_payment_case() SET search_path = public, pg_temp;
ALTER FUNCTION public.guard_late_payment_reference() SET search_path = public, pg_temp;
