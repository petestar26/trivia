-- Existing table triggers continue to execute without caller EXECUTE privileges.
-- PUBLIC EXECUTE also allowed attaching these SECURITY DEFINER guards to TEMP
-- tables; financial validation errors can disclose private owner-table data.
-- Do not permit arbitrary runtime invocation through attacker-owned triggers.
BEGIN;
REVOKE EXECUTE ON FUNCTION public.game_rules_validate_parent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.game_rules_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.game_sessions_validate_rules_snapshot() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.game_definitions_prevent_metadata_drift() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.coin_allocations_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.coin_provenance_guard() FROM PUBLIC;
COMMIT;
