-- A withdrawable PURCHASE must be backed by the exact settled Agent order and
-- wallet credit. The settlement row is inserted after the lot entry within the
-- same transaction, so proof is checked at the end of that transaction.
CREATE OR REPLACE FUNCTION "purchase_settlement_proof_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."entryType" <> 'MINT' OR NOT EXISTS (
    SELECT 1 FROM "economic_operations" o
    WHERE o."id" = NEW."operationId" AND o."type" = 'PURCHASE'
  ) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "economic_operations" o
    JOIN "agent_orders" a ON a."id" = o."scopeId"
    JOIN "agent_reservations" r ON r."orderId" = a."id"
    JOIN "agent_order_settlements" s ON s."orderId" = a."id"
    JOIN "wallet_transactions" wt ON wt."id" = s."walletTransactionId"
    JOIN "coin_provenance" p ON p."id" = NEW."lotId"
    WHERE o."id" = NEW."operationId" AND o."type" = 'PURCHASE'
      AND o."scopeType" = 'AGENT_ORDER' AND o."userId" = NEW."userId"
      AND o."createdBy" = s."releasedBy"
      AND a."userId" = o."userId" AND a."status" = 'COMPLETED'
      AND a."coinAmount" = NEW."availableDelta"
      AND r."id" = s."reservationId" AND r."agentId" = a."agentId"
      AND r."status" = 'CONSUMED' AND r."amount" = a."coinAmount"
      AND s."coinAmount" = a."coinAmount"
      AND cardinality(o."walletTransactionIds") = 1
      AND o."walletTransactionIds"[1] = wt."id"
      AND wt."userId" = o."userId" AND wt."currency" = 'COINS'
      AND wt."type" = 'COIN_CREDIT' AND wt."ledgerType" = 'CREDIT'
      AND wt."status" = 'SUCCEEDED' AND wt."referenceType" = 'AGENT_ORDER'
      AND wt."referenceId" = a."id" AND wt."amount" = a."coinAmount"
      AND wt."balanceAfter" - wt."balanceBefore" = a."coinAmount"
      AND p."userId" = o."userId" AND p."lotClass" = 'WITHDRAWABLE'
      AND p."sourceOperationId" = o."id" AND p."walletTransactionId" = wt."id"
      AND (SELECT COUNT(*) FROM "coin_lot_entries" e
           WHERE e."operationId" = o."id" AND e."entryType" = 'MINT') = 1
  ) THEN
    RAISE EXCEPTION 'PURCHASE withdrawable mint lacks exact settled Agent order proof';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "purchase_settlement_proof_guard"
AFTER INSERT ON "coin_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "purchase_settlement_proof_guard"();
