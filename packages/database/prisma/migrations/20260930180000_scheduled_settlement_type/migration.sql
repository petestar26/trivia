-- Reject prototype financial tickets before changing even the enum schema.
-- Those tickets predate committed randomness and cannot be safely assigned a
-- retroactive outcome. The following migration repeats this check under its
-- table locks in case a legacy writer races this migration boundary.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.scheduled_stake_holds h
    JOIN public.economic_operations o ON o.id=h.hold_operation_id
    WHERE o.snapshot ? 'financialTicket'
  ) THEN
    RAISE EXCEPTION 'existing prototype financial holds require owner-reviewed resolution before upgrading';
  END IF;
END $$;

-- Enum extension commits separately before its first use on PostgreSQL 13.
ALTER TYPE public.operation_type ADD VALUE 'SCHEDULED_STAKE_SETTLE';
