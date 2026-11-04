-- Independent, immutable practice tickets for the existing shared Spin draw.
-- Historical receipts and old clients use Bet 1. No wallet or payout changes.
BEGIN;
SET LOCAL lock_timeout = '20s';
ALTER TABLE public.scheduled_practice_tickets
  ADD COLUMN slot INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT scheduled_practice_ticket_slot CHECK (slot BETWEEN 1 AND 10);
ALTER TABLE public.scheduled_practice_tickets
  DROP CONSTRAINT scheduled_practice_tickets_pkey,
  ADD PRIMARY KEY (round_id, user_id, slot);
-- The existing invoker guard still checks active identity, schedule, cutoff,
-- market syntax, 40-ETB increments and 480-ETB total per ticket. It rejects
-- every UPDATE/DELETE/TRUNCATE, so the new slot is immutable as well.
COMMIT;
