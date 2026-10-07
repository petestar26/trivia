-- Dormant TRON USDT payments. No migration enables a financial service.
CREATE TABLE public.crypto_addresses (
  address TEXT PRIMARY KEY CHECK (address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  "addedBy" TEXT NOT NULL REFERENCES public.users(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE public.crypto_deposits (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES public.users(id),
  "countryId" TEXT NOT NULL REFERENCES public.countries(id),
  address TEXT NOT NULL UNIQUE REFERENCES public.crypto_addresses(address),
  "amountMicro" BIGINT NOT NULL CHECK ("amountMicro" > 0),
  "coinAmount" INTEGER NOT NULL CHECK ("coinAmount" BETWEEN 1 AND 1000000000),
  "pricingSnapshot" JSONB NOT NULL,
  "requestKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','EXPIRED','REVIEW','CREDITED')),
  "lastCheckedAt" TIMESTAMPTZ,
  "checkError" TEXT,
  "reviewReason" TEXT,
  UNIQUE ("userId","requestKey"),
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '15 minutes'),
  CHECK ("coinAmount" = floor("amountMicro"::numeric * 96 / 1000000))
);
CREATE UNIQUE INDEX crypto_one_waiting_deposit ON public.crypto_deposits("userId") WHERE status='WAITING';
CREATE INDEX crypto_deposit_scan ON public.crypto_deposits("lastCheckedAt" NULLS FIRST, id) WHERE status<>'CREDITED';
CREATE TABLE public.crypto_receipts (
  id TEXT PRIMARY KEY,
  "depositId" TEXT NOT NULL REFERENCES public.crypto_deposits(id),
  "txHash" TEXT NOT NULL CHECK ("txHash" ~ '^[0-9a-f]{64}$'),
  "logIndex" INTEGER NOT NULL CHECK ("logIndex">=0),
  contract TEXT NOT NULL CHECK (contract='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  address TEXT NOT NULL,
  "amountMicro" BIGINT NOT NULL CHECK ("amountMicro">0),
  "blockNumber" BIGINT NOT NULL CHECK ("blockNumber">0),
  "blockTime" TIMESTAMPTZ NOT NULL,
  "verifiedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("txHash","logIndex")
);
CREATE TABLE public.crypto_deposit_settlements (
  id TEXT PRIMARY KEY,
  "depositId" TEXT NOT NULL UNIQUE REFERENCES public.crypto_deposits(id),
  "receiptId" TEXT NOT NULL UNIQUE REFERENCES public.crypto_receipts(id),
  "walletTransactionId" TEXT NOT NULL UNIQUE REFERENCES public.wallet_transactions(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.crypto_withdrawals (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES public.users(id),
  "countryId" TEXT NOT NULL REFERENCES public.countries(id),
  address TEXT NOT NULL CHECK (address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  "amountMicro" BIGINT NOT NULL CHECK ("amountMicro">0),
  "coinAmount" INTEGER NOT NULL CHECK ("coinAmount" BETWEEN 1 AND 1000000000),
  "pricingSnapshot" JSONB NOT NULL,
  "requestKey" TEXT NOT NULL,
  "holdOperationId" TEXT NOT NULL UNIQUE REFERENCES public.economic_operations(id),
  "terminalOperationId" TEXT UNIQUE REFERENCES public.economic_operations(id),
  status TEXT NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','PAYOUT_IN_PROGRESS','COMPLETED','CANCELLED')),
  "assignedAdminId" TEXT REFERENCES public.users(id),
  "txHash" TEXT UNIQUE CHECK ("txHash" ~ '^[0-9a-f]{64}$'),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt" TIMESTAMPTZ,
  UNIQUE ("userId","requestKey"),
  CHECK ("amountMicro" = floor("coinAmount"::numeric * 1000000 / 96)),
  CHECK ("assignedAdminId" IS NULL OR "assignedAdminId" <> "userId"),
  CHECK ((status IN ('COMPLETED','CANCELLED')) = ("terminalOperationId" IS NOT NULL)),
  CHECK ((status='COMPLETED') = ("txHash" IS NOT NULL AND "completedAt" IS NOT NULL)),
  CHECK (status NOT IN ('PAYOUT_IN_PROGRESS','COMPLETED') OR "assignedAdminId" IS NOT NULL)
);
CREATE UNIQUE INDEX crypto_one_live_withdrawal ON public.crypto_withdrawals("userId") WHERE status IN ('HELD','PAYOUT_IN_PROGRESS');
INSERT INTO public.platform_gates(key,enabled,"changedAt") VALUES
 ('CRYPTO_DEPOSIT_CREATE',false,now()),('CRYPTO_WITHDRAWAL_CREATE',false,now()),('CRYPTO_DEPOSIT_CREDIT',false,now()) ON CONFLICT DO NOTHING;

CREATE FUNCTION public.crypto_immutable_terms() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Crypto payment history is permanent'; END IF;
 IF TG_TABLE_NAME='crypto_addresses' THEN
   IF (to_jsonb(NEW)-'retired') IS DISTINCT FROM (to_jsonb(OLD)-'retired') OR OLD.retired THEN RAISE EXCEPTION 'Address history is immutable'; END IF;
 ELSIF TG_TABLE_NAME='crypto_deposits' THEN
   IF (to_jsonb(NEW)-ARRAY['status','lastCheckedAt','checkError','reviewReason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','lastCheckedAt','checkError','reviewReason'])
     OR (OLD.status='CREDITED' AND NEW.status<>'CREDITED') OR (OLD.status='REVIEW' AND NEW.status<>'REVIEW')
     OR (OLD.status='EXPIRED' AND NEW.status='WAITING') THEN RAISE EXCEPTION 'Deposit terms or terminal status are immutable'; END IF;
 ELSE
   IF (to_jsonb(NEW)-ARRAY['status','assignedAdminId','txHash','completedAt','terminalOperationId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','assignedAdminId','txHash','completedAt','terminalOperationId'])
     OR (OLD.status IN ('COMPLETED','CANCELLED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
     OR (OLD.status='PAYOUT_IN_PROGRESS' AND NEW.status NOT IN ('PAYOUT_IN_PROGRESS','COMPLETED'))
     OR (OLD.status='HELD' AND NEW.status NOT IN ('HELD','PAYOUT_IN_PROGRESS','CANCELLED'))
     OR (OLD."assignedAdminId" IS NOT NULL AND NEW."assignedAdminId" IS DISTINCT FROM OLD."assignedAdminId") THEN RAISE EXCEPTION 'Withdrawal terms or transition are invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crypto_addresses_immutable BEFORE UPDATE OR DELETE ON public.crypto_addresses FOR EACH ROW EXECUTE FUNCTION public.crypto_immutable_terms();
CREATE TRIGGER crypto_deposits_immutable BEFORE UPDATE OR DELETE ON public.crypto_deposits FOR EACH ROW EXECUTE FUNCTION public.crypto_immutable_terms();
CREATE TRIGGER crypto_withdrawals_immutable BEFORE UPDATE OR DELETE ON public.crypto_withdrawals FOR EACH ROW EXECUTE FUNCTION public.crypto_immutable_terms();
CREATE TRIGGER crypto_receipts_append_only BEFORE UPDATE OR DELETE ON public.crypto_receipts FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();
CREATE TRIGGER crypto_settlements_append_only BEFORE UPDATE OR DELETE ON public.crypto_deposit_settlements FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();

-- Check the witness in both directions: a credited status cannot exist without
-- its ledger mint, and a ledger mint cannot exist without the verified receipt.
CREATE FUNCTION public.crypto_payment_proof_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.crypto_deposits; w public.crypto_withdrawals;
BEGIN
 IF TG_TABLE_NAME='crypto_withdrawals' THEN
  SELECT * INTO w FROM public.crypto_withdrawals WHERE id=NEW.id;
  IF NOT EXISTS (SELECT 1 FROM public.economic_operations o JOIN public.wallet_transactions t ON t.id=o."walletTransactionIds"[1]
    WHERE o.id=w."holdOperationId" AND o.type='WITHDRAWAL_HOLD' AND o."scopeType"='WITHDRAWAL' AND o."scopeId"=w.id AND o."userId"=w."userId"
      AND cardinality(o."walletTransactionIds")=1 AND t."userId"=w."userId" AND t.currency='COINS' AND t.type='COIN_DEBIT' AND t.status='SUCCEEDED' AND t."ledgerType"='DEBIT'
      AND t."referenceType"='WITHDRAWAL' AND t."referenceId"=w.id AND t.amount=w."coinAmount" AND t."balanceBefore"-t."balanceAfter"=w."coinAmount"
      AND (SELECT coalesce(sum(e."reservedDelta"),0) FROM public.coin_lot_entries e WHERE e."operationId"=o.id AND e."entryType"='RESERVE')=w."coinAmount") THEN
    RAISE EXCEPTION 'Crypto withdrawal lacks exact hold'; END IF;
  IF w."terminalOperationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.economic_operations o
    WHERE o.id=w."terminalOperationId" AND o."userId"=w."userId" AND o."scopeType"='WITHDRAWAL' AND o."scopeId"=w.id AND o."reversesOperationId"=w."holdOperationId"
    AND o.type::text=CASE WHEN w.status='COMPLETED' THEN 'WITHDRAWAL_FINALIZE' ELSE 'WITHDRAWAL_RELEASE' END
    AND (SELECT coalesce(sum(e."reservedDelta"),0) FROM public.coin_lot_entries e WHERE e."operationId"=o.id)=-w."coinAmount") THEN
    RAISE EXCEPTION 'Crypto withdrawal lacks exact finalization or refund'; END IF;
 ELSE
  IF TG_TABLE_NAME='crypto_deposits' THEN SELECT * INTO d FROM public.crypto_deposits WHERE id=NEW.id;
  ELSE SELECT * INTO d FROM public.crypto_deposits WHERE id=NEW."depositId"; END IF;
  IF d.status='CREDITED' OR TG_TABLE_NAME='crypto_deposit_settlements' THEN
   IF d.status<>'CREDITED' OR NOT EXISTS (SELECT 1 FROM public.crypto_deposit_settlements s
    JOIN public.crypto_receipts r ON r.id=s."receiptId"
    JOIN public.wallet_transactions wt ON wt.id=s."walletTransactionId"
    JOIN public.economic_operations o ON o."walletTransactionIds"=ARRAY[wt.id]
    JOIN public.coin_lot_entries e ON e."operationId"=o.id AND e."entryType"='MINT'
    JOIN public.coin_provenance p ON p.id=e."lotId"
    WHERE s."depositId"=d.id AND r."depositId"=d.id AND r.address=d.address AND r."amountMicro"=d."amountMicro"
      AND r."blockTime">=d."createdAt" AND r."blockTime"<=d."expiresAt"
      AND o.type='PURCHASE' AND o."scopeType"='CRYPTO_DEPOSIT' AND o."scopeId"=d.id AND o."userId"=d."userId"
      AND wt."userId"=d."userId" AND wt.currency='COINS' AND wt.type='COIN_CREDIT' AND wt."ledgerType"='CREDIT' AND wt.status='SUCCEEDED'
      AND wt."referenceType"='PURCHASE' AND wt."referenceId"=d.id AND wt.amount=d."coinAmount" AND wt."balanceAfter"-wt."balanceBefore"=d."coinAmount"
      AND e."userId"=d."userId" AND e."availableDelta"=d."coinAmount" AND p."userId"=d."userId" AND p."lotClass"='WITHDRAWABLE'
      AND p."sourceOperationId"=o.id AND p."walletTransactionId"=wt.id
      AND (SELECT count(*) FROM public.coin_lot_entries x WHERE x."operationId"=o.id AND x."entryType"='MINT')=1) THEN
    RAISE EXCEPTION 'Crypto deposit lacks exact solidified receipt and ledger proof'; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crypto_deposit_proof AFTER INSERT OR UPDATE ON public.crypto_deposits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crypto_payment_proof_guard();
CREATE CONSTRAINT TRIGGER crypto_settlement_proof AFTER INSERT ON public.crypto_deposit_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crypto_payment_proof_guard();
CREATE CONSTRAINT TRIGGER crypto_withdrawal_proof AFTER INSERT OR UPDATE ON public.crypto_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crypto_payment_proof_guard();

-- A withdrawable PURCHASE must be backed by the exact settled Agent order and
-- wallet credit. The settlement row is inserted after the lot entry within the
-- same transaction, so proof is checked at the end of that transaction.
CREATE OR REPLACE FUNCTION "purchase_settlement_proof_guard"()
RETURNS trigger SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW."entryType" <> 'MINT' OR NOT EXISTS (
    SELECT 1 FROM public."economic_operations" o
    WHERE o."id" = NEW."operationId" AND o."type" = 'PURCHASE'
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.economic_operations o WHERE o.id=NEW."operationId" AND o."scopeType"='CRYPTO_DEPOSIT') THEN
    IF NOT EXISTS (SELECT 1 FROM public.economic_operations o JOIN public.crypto_deposit_settlements s ON s."depositId"=o."scopeId"
      WHERE o.id=NEW."operationId" AND o."walletTransactionIds"=ARRAY[s."walletTransactionId"]) THEN
      RAISE EXCEPTION 'Crypto purchase lacks settlement witness';
    END IF;
    -- The settlement constraint separately validates the complete receipt/mint graph.
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public."economic_operations" o
    JOIN public."agent_orders" a ON a."id" = o."scopeId"
    JOIN public."agent_reservations" r ON r."orderId" = a."id"
    JOIN public."agent_order_settlements" s ON s."orderId" = a."id"
    JOIN public."wallet_transactions" wt ON wt."id" = s."walletTransactionId"
    JOIN public."coin_provenance" p ON p."id" = NEW."lotId"
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
      AND (SELECT COUNT(*) FROM public."coin_lot_entries" e
           WHERE e."operationId" = o."id" AND e."entryType" = 'MINT') = 1
  ) THEN
    RAISE EXCEPTION 'PURCHASE withdrawable mint lacks exact settled Agent order proof';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.ledger_apply_runtime_grants(text) RENAME TO ledger_apply_runtime_grants_pre_crypto;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants_pre_crypto(text) FROM PUBLIC;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role TEXT) RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tab TEXT; cols TEXT; holders TEXT; subjects OID[];
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_crypto(runtime_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.crypto_addresses,public.crypto_deposits,public.crypto_withdrawals TO %I',runtime_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.crypto_deposit_settlements TO %I',runtime_role);
 EXECUTE format('GRANT SELECT ON public.crypto_receipts TO %I',runtime_role);
 subjects:=ARRAY(SELECT x.role_id FROM public.ledger_role_reach((SELECT oid FROM pg_roles WHERE rolname=runtime_role)) x);
 FOREACH tab IN ARRAY ARRAY['crypto_receipts','crypto_deposit_settlements','crypto_addresses','crypto_deposits','crypto_withdrawals'] LOOP
  EXECUTE format('REVOKE DELETE,TRUNCATE,TRIGGER ON public.%I FROM %I',tab,runtime_role);
  IF tab='crypto_deposit_settlements' THEN
   EXECUTE format('REVOKE UPDATE ON public.%I FROM %I',tab,runtime_role);
   SELECT string_agg(quote_ident(attname),',') INTO cols FROM pg_attribute WHERE attrelid=to_regclass('public.'||tab) AND attnum>0 AND NOT attisdropped;
   EXECUTE format('REVOKE UPDATE (%s) ON public.%I FROM %I',cols,tab,runtime_role);
  END IF;
  IF tab='crypto_receipts' THEN
   EXECUTE format('REVOKE INSERT,UPDATE ON public.%I FROM %I',tab,runtime_role);
   SELECT string_agg(quote_ident(attname),',') INTO cols FROM pg_attribute WHERE attrelid=to_regclass('public.'||tab) AND attnum>0 AND NOT attisdropped;
   EXECUTE format('REVOKE INSERT (%s),UPDATE (%s) ON public.%I FROM %I',cols,cols,tab,runtime_role);
   SELECT string_agg(rolname,',') INTO holders FROM pg_roles WHERE oid=ANY(subjects) AND (has_table_privilege(oid,'public.crypto_receipts','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(oid,'public.crypto_receipts','INSERT,UPDATE'));
   IF holders IS NOT NULL THEN RAISE EXCEPTION 'API runtime can forge crypto receipt through %',holders; END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text) FROM PUBLIC;
-- Owner calls this only for a separate verifier identity, never the API identity.
CREATE FUNCTION public.crypto_apply_verifier_grants(verifier_role TEXT) RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM public.ledger_apply_runtime_grants(verifier_role);
 EXECUTE format('GRANT INSERT ON public.crypto_receipts TO %I',verifier_role);
END $$;
REVOKE ALL ON FUNCTION public.crypto_apply_verifier_grants(text) FROM PUBLIC;

-- Both payout channels use WITHDRAWAL ledger scopes. A scope may belong to only
-- one channel, even if a runtime client attempts to reuse an existing hold ID.
CREATE FUNCTION public.crypto_withdrawal_namespace_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('withdrawal-namespace:'||NEW.id,0));
 IF TG_TABLE_NAME='crypto_withdrawals' THEN
  IF EXISTS(SELECT 1 FROM public.withdrawals WHERE id=NEW.id) THEN RAISE EXCEPTION 'Withdrawal scope already belongs to another payment channel'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.crypto_withdrawals WHERE id=NEW.id) THEN RAISE EXCEPTION 'Withdrawal scope already belongs to another payment channel'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crypto_withdrawal_namespace BEFORE INSERT ON public.crypto_withdrawals FOR EACH ROW EXECUTE FUNCTION public.crypto_withdrawal_namespace_guard();
CREATE TRIGGER withdrawal_crypto_namespace BEFORE INSERT ON public.withdrawals FOR EACH ROW EXECUTE FUNCTION public.crypto_withdrawal_namespace_guard();
