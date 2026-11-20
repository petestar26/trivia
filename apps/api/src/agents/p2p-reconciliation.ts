/**
 * P2P admission-pause operator SQL (docs/runbooks/p2p-admission-pause.md).
 *
 * P2P_RECONCILIATION_SQL is a single read-only SELECT: run it in a
 * READ ONLY transaction before the pause, after the drain, after resume and
 * after any rollback. Every returned row is a mismatch (rule name + id);
 * zero rows means the covered P2P consistency checks found no mismatch.
 * This is not a complete wallet reconciliation. Plain SELECT only.
 */
export const P2P_RECONCILIATION_SQL = `
WITH
active_res AS (
  SELECT "agentId", COALESCE(SUM(amount),0)::bigint AS amt FROM agent_reservations WHERE status='ACTIVE' GROUP BY 1),
active_liq AS (
  SELECT "agentId", "fiatCurrency", COALESCE(SUM(amount),0)::numeric AS amt
  FROM withdrawal_liquidity_reservations WHERE status='ACTIVE' GROUP BY 1,2)
-- Deposits: a COMPLETED order has exactly one settlement for its coin amount; nothing else has one.
SELECT 'deposit_settlement_count' AS rule, o.id FROM agent_orders o
  LEFT JOIN agent_order_settlements s ON s."orderId"=o.id
  WHERE (o.status='COMPLETED') <> (s.id IS NOT NULL) OR (s.id IS NOT NULL AND s."coinAmount"<>o."coinAmount")
UNION ALL
-- Deposits: the settlement's wallet credit exists, belongs to the buyer and equals the order.
SELECT 'deposit_credit_mismatch', s."orderId" FROM agent_order_settlements s
  JOIN agent_orders o ON o.id=s."orderId"
  LEFT JOIN wallet_transactions t ON t.id=s."walletTransactionId"
  WHERE t.id IS NULL OR t."userId"<>o."userId" OR t.amount<>o."coinAmount"
     OR t.type<>'COIN_CREDIT' OR t."ledgerType"<>'CREDIT' OR t.currency<>'COINS'
     OR t.status<>'SUCCEEDED' OR t."referenceType"<>'AGENT_ORDER' OR t."referenceId" IS DISTINCT FROM o.id
     OR t."balanceAfter"::bigint-t."balanceBefore"::bigint<>o."coinAmount"
UNION ALL
-- Deposits: reservation state follows order state (consumed iff completed, active iff open).
SELECT 'deposit_reservation_state', o.id FROM agent_orders o
  LEFT JOIN agent_reservations r ON r."orderId"=o.id
  WHERE r.id IS NULL OR r.amount<>o."coinAmount"
     OR (r.status='CONSUMED') <> (o.status='COMPLETED')
     OR (r.status='ACTIVE') <> (o.status IN ('CREATED','PAYMENT_SUBMITTED','AGENT_TIMEOUT','DISPUTE'))
UNION ALL
-- Agent coin inventory: reserved equals the sum of active reservations, within total.
SELECT 'agent_inventory_reserved', i."agentId" FROM agent_inventories i
  LEFT JOIN active_res a ON a."agentId"=i."agentId"
  WHERE i."reservedBalance"<>COALESCE(a.amt,0) OR i."reservedBalance"<0 OR i."reservedBalance">i."totalBalance"
UNION ALL
-- Withdrawals: every held-or-later withdrawal has one hold whose state follows it.
SELECT 'withdrawal_hold_state', w.id FROM withdrawals w
  LEFT JOIN withdrawal_holds h ON h."withdrawalId"=w.id
  WHERE w.status<>'CREATED' AND (h.id IS NULL OR h."coinAmount"<>w."coinAmount"
     OR (h.status='CONSUMED') <> (w.status='COMPLETED')
     OR (h.status='ACTIVE') <> (w.status IN ('HELD','PAYOUT_IN_PROGRESS','PAYMENT_SUBMITTED','DISPUTED'))
     OR (h.status='REFUNDED') <> (h."refundWalletTransactionId" IS NOT NULL))
UNION ALL
-- Withdrawals: the hold debit and any refund credit match the held amount (one each).
SELECT 'withdrawal_hold_ledger', h."withdrawalId" FROM withdrawal_holds h
  JOIN withdrawals w ON w.id=h."withdrawalId"
  LEFT JOIN wallet_transactions d ON d.id=h."debitWalletTransactionId"
  LEFT JOIN wallet_transactions c ON c.id=h."refundWalletTransactionId"
  WHERE d.id IS NULL OR d."userId"<>w."userId" OR d.amount<>h."coinAmount"
     OR d.type<>'COIN_DEBIT' OR d."ledgerType"<>'DEBIT' OR d.currency<>'COINS'
     OR d.status<>'SUCCEEDED' OR d."referenceType"<>'WITHDRAWAL' OR d."referenceId" IS DISTINCT FROM w.id
     OR d."balanceBefore"::bigint-d."balanceAfter"::bigint<>h."coinAmount"
     OR (h."refundWalletTransactionId" IS NOT NULL AND
       (c.id IS NULL OR c."userId"<>w."userId" OR c.amount<>h."coinAmount"
        OR c.type<>'COIN_CREDIT' OR c."ledgerType"<>'CREDIT' OR c.currency<>'COINS'
        OR c.status<>'SUCCEEDED' OR c."referenceType"<>'WITHDRAWAL' OR c."referenceId" IS DISTINCT FROM w.id
        OR c."balanceAfter"::bigint-c."balanceBefore"::bigint<>h."coinAmount"))
UNION ALL
-- Withdrawals: a COMPLETED withdrawal has exactly one settlement; a settlement's outcome
-- matches the withdrawal (dispute-resolved cancellations carry a CANCELLED one).
SELECT 'withdrawal_settlement_state', w.id FROM withdrawals w
  LEFT JOIN withdrawal_settlements s ON s."withdrawalId"=w.id
  WHERE (w.status='COMPLETED' AND s.id IS NULL)
     OR (s.id IS NOT NULL AND (s.outcome::text<>w.status::text OR s."coinAmount"<>w."coinAmount"))
UNION ALL
-- Agent fiat liquidity: reserved equals the sum of active withdrawal reservations, within total.
SELECT 'agent_liquidity_reserved', l."agentId" || ':' || l."fiatCurrency" FROM agent_fiat_liquidities l
  LEFT JOIN active_liq a ON a."agentId"=l."agentId" AND a."fiatCurrency"=l."fiatCurrency"
  WHERE l."reservedBalance"::numeric<>COALESCE(a.amt,0) OR l."reservedBalance"<0 OR l."reservedBalance">l."totalBalance"
UNION ALL
-- Wallets touched by P2P: the stored coin balance equals the latest coin ledger balanceAfter.
SELECT 'wallet_balance_vs_ledger', wl."userId" FROM wallets wl
  JOIN LATERAL (SELECT t."balanceAfter" FROM wallet_transactions t
    WHERE t."walletId"=wl.id AND t.currency='COINS' ORDER BY t."createdAt" DESC, t.id DESC LIMIT 1) last ON true
  WHERE wl."userId" IN (SELECT "userId" FROM agent_orders UNION SELECT "userId" FROM withdrawals)
    AND wl."coinsBalance"<>last."balanceAfter"
ORDER BY 1, 2`;
