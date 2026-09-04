-- W-1D2: forward-only lifecycle coherence backstops.
--
-- W-1D2A introduced the required columns and exact-once unique indexes. This
-- follow-up adds the status/metadata and arithmetic matrices used by the
-- W-1D2 services. Existing W-1D2A constraints are deliberately retained;
-- never edit an already-applied migration.
--
-- Each CHECK is added NOT VALID first so PostgreSQL immediately enforces it
-- for new/changed rows. VALIDATE then audits existing rows without the
-- stronger ACCESS EXCLUSIVE lock of adding a validated CHECK directly. A
-- production rollout may split ADD and VALIDATE into separate windows if the
-- tables are large; it must not enable the W-1D2 routes before ADD completes.

ALTER TABLE "withdrawal_settlements"
  ADD CONSTRAINT "withdrawal_settlements_outcome_refund_coherence_check"
  CHECK (
    ("outcome" = 'COMPLETED' AND "refundWalletTransactionId" IS NULL)
    OR
    ("outcome" = 'CANCELLED'
      AND "refundWalletTransactionId" IS NOT NULL
      AND "resolvedVia" = 'ADMIN_DISPUTE_RESOLUTION'
      AND "disputeId" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "withdrawal_holds"
  ADD CONSTRAINT "withdrawal_holds_status_metadata_coherence_check"
  CHECK (
    ("status" = 'ACTIVE'
      AND "consumedAt" IS NULL
      AND "releasedAt" IS NULL
      AND "refundWalletTransactionId" IS NULL)
    OR
    ("status" = 'CONSUMED'
      AND "consumedAt" IS NOT NULL
      AND "releasedAt" IS NULL
      AND "refundWalletTransactionId" IS NULL)
    OR
    ("status" = 'REFUNDED'
      AND "consumedAt" IS NULL
      AND "releasedAt" IS NOT NULL
      AND "refundWalletTransactionId" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "withdrawal_liquidity_reservations"
  ADD CONSTRAINT "withdrawal_reservations_status_metadata_coherence_check"
  CHECK (
    ("status" = 'ACTIVE' AND "releasedAt" IS NULL AND "consumedAt" IS NULL)
    OR
    ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "consumedAt" IS NULL)
    OR
    ("status" = 'CONSUMED' AND "releasedAt" IS NULL AND "consumedAt" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "withdrawal_disputes"
  ADD CONSTRAINT "withdrawal_disputes_status_metadata_coherence_check"
  CHECK (
    ("status" = 'OPEN'
      AND "assignedAdminId" IS NULL
      AND "assignedAt" IS NULL
      AND "resolution" IS NULL
      AND "resolutionNote" IS NULL
      AND "resolvedBy" IS NULL
      AND "resolvedAt" IS NULL)
    OR
    ("status" = 'ASSIGNED'
      AND "assignedAdminId" IS NOT NULL
      AND "assignedAt" IS NOT NULL
      AND "resolution" IS NULL
      AND "resolutionNote" IS NULL
      AND "resolvedBy" IS NULL
      AND "resolvedAt" IS NULL)
    OR
    ("status" = 'RESOLVED'
      AND "assignedAdminId" IS NOT NULL
      AND "assignedAt" IS NOT NULL
      AND "resolution" IS NOT NULL
      AND "resolutionNote" IS NOT NULL
      AND "resolvedBy" IS NOT NULL
      AND "resolvedBy" = "assignedAdminId"
      AND "resolvedAt" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "withdrawal_disputes"
  ADD CONSTRAINT "withdrawal_disputes_chronology_check"
  CHECK (
    ("assignedAt" IS NULL OR "assignedAt" >= "openedAt")
    AND
    ("resolvedAt" IS NULL
      OR ("assignedAt" IS NOT NULL AND "resolvedAt" >= "assignedAt"))
  ) NOT VALID;

ALTER TABLE "withdrawal_payment_submissions"
  ADD CONSTRAINT "withdrawal_submissions_admin_verified_timestamp_check"
  CHECK ("source" <> 'ADMIN_VERIFIED' OR "paymentOccurredAt" IS NOT NULL)
  NOT VALID;

ALTER TABLE "withdrawal_settlements"
  ADD CONSTRAINT "withdrawal_settlements_positive_amounts_check"
  CHECK ("coinAmount" > 0 AND "fiatAmount" > 0)
  NOT VALID;

-- The wallet refund ceiling proof depends on one live withdrawal and a
-- maximum hold liability of one billion coins. Backstop the application cap
-- on every durable copy of that amount.
ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_coin_amount_upper_bound_check"
  CHECK ("coinAmount" <= 1000000000)
  NOT VALID;

ALTER TABLE "withdrawal_holds"
  ADD CONSTRAINT "withdrawal_holds_coin_amount_upper_bound_check"
  CHECK ("coinAmount" <= 1000000000)
  NOT VALID;

ALTER TABLE "withdrawal_settlements"
  ADD CONSTRAINT "withdrawal_settlements_coin_amount_upper_bound_check"
  CHECK ("coinAmount" <= 1000000000)
  NOT VALID;

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_terminal_timestamp_coherence_check"
  CHECK (
    ("status" <> 'DISPUTED' OR "disputedAt" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "agent_fiat_liquidity_ledger"
  ADD CONSTRAINT "agent_fiat_liquidity_ledger_terminal_arithmetic_check"
  CHECK (
    "type" NOT IN ('RELEASE', 'CONSUME')
    OR (
      "amount" > 0
      AND "reservationId" IS NOT NULL
      AND "withdrawalId" IS NOT NULL
      AND "totalBefore" >= 0
      AND "totalAfter" >= 0
      AND "reservedBefore" >= 0
      AND "reservedAfter" >= 0
      AND "reservedBefore" <= "totalBefore"
      AND "reservedAfter" <= "totalAfter"
      AND "reservedAfter" = "reservedBefore" - "amount"
      AND (
        ("type" = 'RELEASE' AND "totalAfter" = "totalBefore")
        OR
        ("type" = 'CONSUME' AND "totalAfter" = "totalBefore" - "amount")
      )
    )
  ) NOT VALID;

ALTER TABLE "withdrawal_settlements"
  VALIDATE CONSTRAINT "withdrawal_settlements_outcome_refund_coherence_check";
ALTER TABLE "withdrawal_holds"
  VALIDATE CONSTRAINT "withdrawal_holds_status_metadata_coherence_check";
ALTER TABLE "withdrawal_liquidity_reservations"
  VALIDATE CONSTRAINT "withdrawal_reservations_status_metadata_coherence_check";
ALTER TABLE "withdrawal_disputes"
  VALIDATE CONSTRAINT "withdrawal_disputes_status_metadata_coherence_check";
ALTER TABLE "withdrawal_disputes"
  VALIDATE CONSTRAINT "withdrawal_disputes_chronology_check";
ALTER TABLE "withdrawal_payment_submissions"
  VALIDATE CONSTRAINT "withdrawal_submissions_admin_verified_timestamp_check";
ALTER TABLE "withdrawal_settlements"
  VALIDATE CONSTRAINT "withdrawal_settlements_positive_amounts_check";
ALTER TABLE "withdrawals"
  VALIDATE CONSTRAINT "withdrawals_coin_amount_upper_bound_check";
ALTER TABLE "withdrawal_holds"
  VALIDATE CONSTRAINT "withdrawal_holds_coin_amount_upper_bound_check";
ALTER TABLE "withdrawal_settlements"
  VALIDATE CONSTRAINT "withdrawal_settlements_coin_amount_upper_bound_check";
ALTER TABLE "withdrawals"
  VALIDATE CONSTRAINT "withdrawals_terminal_timestamp_coherence_check";
ALTER TABLE "agent_fiat_liquidity_ledger"
  VALIDATE CONSTRAINT "agent_fiat_liquidity_ledger_terminal_arithmetic_check";
