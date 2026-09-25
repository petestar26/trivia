-- Migration F: Phase G0 corrective — disable the unconfirmed Ethiopia
-- casino jurisdiction.
--
-- Migration C seeded an ENABLED policy row with hardcoded Ethiopia withdrawal
-- thresholds. Those thresholds are unconfirmed, so the row is replaced with a
-- DISABLED/null configuration: all withdrawal/loyalty thresholds are zeroed
-- and the policy is marked DISABLED (the table exists for future gating only).
--
-- Forward-only and idempotent: safe to run on databases where Migration C's
-- row was already inserted (including after the edited Migration C seed).
UPDATE "country_casino_policies"
SET "status"                  = 'DISABLED',
    "enabledAt"               = NULL,
    "disabledAt"              = COALESCE("disabledAt", now()),
    "minWithdrawal"           = 0,
    "maxWithdrawal"           = 0,
    "dailyWithdrawalLimit"    = 0,
    "monthlyWithdrawalLimit"  = 0,
    "playthroughMultiplier"   = 1.0,
    "qualifyingGames"         = '[]',
    "maxQualifyingStake"      = 0,
    "holdingPeriodHours"      = 0,
    "giftDailyLimit"          = 0,
    "kycTierRequired"         = 0,
    "supportedPaymentMethods" = '[]',
    "withdrawalFeePercent"    = 0,
    "manualReviewThreshold"   = 0,
    "updatedAt"               = now()
WHERE "countryCode" = 'ET' AND "version" = 1;