-- Separate transaction: enum values must commit before a later migration uses them.
ALTER TYPE public.operation_type ADD VALUE 'SCHEDULED_STAKE_HOLD';
ALTER TYPE public.operation_type ADD VALUE 'SCHEDULED_STAKE_REFUND';
