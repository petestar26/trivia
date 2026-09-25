-- Ledger upgrade, last migration: the upgrade-window check.
--
-- The release is supported only with every application writer (API, worker,
-- scheduled jobs) stopped for the whole preflight and migration window; see
-- docs/deployment/ledger-upgrade-gate.md. The pre-upgrade gate
-- (20260917900000) recorded the legacy financial state it verified in
-- "ledger_upgrade_window". No migration of this release changes those
-- values, so any difference now means an application or worker was still
-- writing while the migrations ran: for example an old-version wallet credit
-- after the opening journal, which no later check would reconcile. The
-- upgrade stops here instead of completing around it.
--
-- One transaction: a stop changes nothing, and the snapshot stays for the
-- escalation. Only a passing check drops it.
-- With every writer stopped these locks are free. If a writer is still
-- running, the gate waits at most lock_timeout and then fails, changing
-- nothing, instead of hanging the deploy; a deadlock with such a writer ends
-- the same way for whichever side PostgreSQL aborts. See
-- docs/deployment/ledger-upgrade-gate.md ("If a migration fails").
SET LOCAL lock_timeout = '20s';
LOCK TABLE "wallets", "wallet_transactions", "withdrawal_holds", "withdrawals", "game_definitions",
  "agent_orders", "agent_order_settlements", "agent_reservations", "gift_transactions", "game_sessions"
  IN SHARE MODE;

DO $window$
DECLARE
  changed integer;
  sample text;
BEGIN
  IF to_regclass('ledger_upgrade_window') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE: the snapshot recorded by 20260917900000_ledger_preupgrade_gate is missing',
      DETAIL = 'Without it this release cannot prove that no application wrote during the upgrade.',
      HINT = 'Restore the pre-upgrade backup and deploy again with every writer stopped (docs/deployment/ledger-upgrade-gate.md). Never mark this migration as applied.';
  END IF;

  WITH current_window ("subject", "fingerprint") AS (
-- ledger-upgrade-window:begin
SELECT 'wallet:' || w."userId", md5(jsonb_build_array(
         w."id", w."userId", w."coinsBalance", w."gamePointsBalance", w."version", w."createdAt", w."updatedAt")::text)
FROM "wallets" w
UNION ALL
SELECT 'wallet_transactions', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         t."id", t."walletId", t."userId", t."type", t."ledgerType", t."currency", t."amount", t."balanceBefore",
         t."balanceAfter", t."referenceType", t."referenceId", t."description", t."status", t."createdAt")::text, 0)), 0)
FROM "wallet_transactions" t
UNION ALL
SELECT 'withdrawal_holds', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         h."id", h."withdrawalId", h."coinAmount", h."status", h."debitWalletTransactionId",
         h."refundWalletTransactionId", h."createdAt", h."consumedAt", h."releasedAt")::text, 0)), 0)
FROM "withdrawal_holds" h
UNION ALL
SELECT 'withdrawals', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         d."id", d."withdrawalNumber", d."userId", d."agentId", d."requestHash", d."idempotencyKey", d."countryId",
         d."paymentMethodDefId", d."paymentAccountId", d."paymentSnapshot", d."fiatAmount", d."fiatCurrency",
         d."exchangeRateConfigId", d."exchangeRateValue", d."coinAmount", d."status", d."quoteExpiresAt",
         d."confirmationDeadlineAt", d."paymentSubmittedAt", d."completedAt", d."cancelledAt", d."expiredAt",
         d."disputedAt", d."createdAt", d."updatedAt", d."quoteId", d."paymentSubmissionDeadlineAt")::text, 0)), 0)
FROM "withdrawals" d
UNION ALL
SELECT 'agent_orders', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         o."id", o."orderNumber", o."userId", o."agentId", o."countryId", o."paymentMethodDefId", o."paymentAccountId",
         o."paymentSnapshot", o."fiatAmount", o."fiatCurrency", o."exchangeRateConfigId", o."exchangeRateValue",
         o."coinAmount", o."status", o."idempotencyKey", o."paymentInstructionsShownAt", o."paymentSubmittedAt",
         o."releaseDeadlineAt", o."agentTimeoutAt", o."completedAt", o."cancelledAt", o."expiredAt", o."createdAt",
         o."updatedAt")::text, 0)), 0)
FROM "agent_orders" o
UNION ALL
SELECT 'agent_order_settlements', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         s."id", s."orderId", s."reservationId", s."coinAmount", s."walletTransactionId", s."resolvedVia",
         s."releasedBy", s."settledAt")::text, 0)), 0)
FROM "agent_order_settlements" s
UNION ALL
SELECT 'agent_reservations', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         r."id", r."orderId", r."agentId", r."amount", r."status", r."createdAt", r."releasedAt",
         r."consumedAt")::text, 0)), 0)
FROM "agent_reservations" r
UNION ALL
SELECT 'gift_transactions', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         x."id", x."senderId", x."recipientId", x."giftId", x."quantity", x."totalCoins", x."totalGamePoints",
         x."coinPriceAtTransaction", x."pointValueAtTransaction", x."senderWalletId", x."recipientWalletId",
         x."createdAt")::text, 0)), 0)
FROM "gift_transactions" x
UNION ALL
SELECT 'game_sessions', count(*) || '/' || COALESCE(sum(hashtextextended(jsonb_build_array(
         e."id", e."userId", e."gameId", e."challengeId", e."status", e."betAmount", e."result", e."rewardAmount",
         e."isWin", e."idempotencyKey", e."createdAt", e."completedAt")::text, 0)), 0)
FROM "game_sessions" e
UNION ALL
SELECT 'game:' || g."key", COALESCE(g."configuration"::text, 'NULL')
FROM "game_definitions" g
WHERE g."key" IN ('lucky_spin', 'dice', 'number_challenge', 'trivia')
-- ledger-upgrade-window:end
  ), differences AS (
    SELECT COALESCE(c."subject", s."subject") AS subject
    FROM current_window c
    FULL OUTER JOIN "ledger_upgrade_window" s ON s."subject" = c."subject"
    WHERE c."fingerprint" IS DISTINCT FROM s."fingerprint"
      -- A legacy game row that did not exist at the snapshot is the seed's
      -- own insert (a fresh install); its rules are verified by
      -- 20260922060000. Every other new row is an application write.
      AND NOT (s."subject" IS NULL AND c."subject" LIKE 'game:%')
  )
  SELECT count(*)::integer, array_to_string((array_agg(d.subject ORDER BY d.subject))[1:10], ', ')
    INTO changed, sample
  FROM differences d;

  IF changed > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE: %s legacy financial record(s) changed while the release migrations ran: %s', changed, sample),
      DETAIL = 'An application or worker was still writing during the upgrade. Every earlier migration of this release is applied; this one changed nothing.',
      HINT = 'Stop every writer, restore the pre-upgrade backup and deploy again (docs/deployment/ledger-upgrade-gate.md). Never mark this migration as applied.';
  END IF;
END
$window$;

DROP TABLE "ledger_upgrade_window";
