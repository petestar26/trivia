-- CORRECTION 3: gift replay immutability.
-- Persist the exact success response returned at send time so an idempotent
-- replay can return it verbatim, without re-reading the (mutable) gift
-- catalog. Nullable and additive: existing rows keep responseSnapshot=NULL
-- and fall back to a safe legacy replay path in application code that never
-- fabricates a historical name from the current catalog.
ALTER TABLE "gift_transactions" ADD COLUMN "responseSnapshot" JSONB;
