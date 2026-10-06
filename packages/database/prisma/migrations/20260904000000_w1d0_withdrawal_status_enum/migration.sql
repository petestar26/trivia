-- W-1D0: Add PAYOUT_IN_PROGRESS to WithdrawalStatus
--
-- Own migration file, committed before any migration that references
-- the new value — same precedent as 20260903000000_w1a_withdrawal_enum:
-- PostgreSQL forbids using a newly-added enum value within the same
-- transaction that ADD VALUEs it, and Prisma runs each migration file
-- inside its own transaction. Nothing in this hardening slice actually
-- references 'PAYOUT_IN_PROGRESS' (no default, no index predicate, no
-- CHECK expression), but the split is kept anyway so this migration
-- never has to be revisited if a later migration file needs to.
--
-- No transition logic consumes this value yet. W-1D1 lifecycle routes
-- (submit-payment, cancel, confirm-receipt, dispute) are explicitly out
-- of scope for this slice.

ALTER TYPE "WithdrawalStatus" ADD VALUE 'PAYOUT_IN_PROGRESS';
