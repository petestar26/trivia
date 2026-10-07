-- Prisma stores these timestamp-without-time-zone fields as UTC. Pin the
-- definer function clock conversion regardless of the caller session zone.
-- ALTER preserves the owner, restricted search path and existing grants.
ALTER FUNCTION public.activate_provisioned_agent(text,text,text) SET TimeZone = 'UTC';
