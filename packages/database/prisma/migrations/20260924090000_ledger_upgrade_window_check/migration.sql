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
LOCK TABLE "wallets", "wallet_transactions", "withdrawal_holds", "withdrawals", "game_definitions"
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
SELECT 'wallet:' || w."userId", w."coinsBalance" || '/' || w."gamePointsBalance"
FROM "wallets" w
UNION ALL
SELECT 'wallet_transactions', count(*) || '/' || COALESCE(sum(hashtextextended(
         t."id" || ':' || t."userId" || ':' || t."amount" || ':' || t."currency" || ':' || t."ledgerType" || ':' || t."status", 0)), 0)
FROM "wallet_transactions" t
UNION ALL
SELECT 'withdrawal_holds', count(*) || '/' || COALESCE(sum(hashtextextended(
         h."id" || ':' || h."status" || ':' || h."coinAmount" || ':' || COALESCE(h."refundWalletTransactionId", '-'), 0)), 0)
FROM "withdrawal_holds" h
UNION ALL
SELECT 'withdrawals', count(*) || '/' || COALESCE(sum(hashtextextended(
         d."id" || ':' || d."status" || ':' || d."coinAmount", 0)), 0)
FROM "withdrawals" d
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
