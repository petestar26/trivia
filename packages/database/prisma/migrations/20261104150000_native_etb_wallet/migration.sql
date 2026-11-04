BEGIN;
SET LOCAL lock_timeout = '20s';
-- This is denomination initialization, never a conversion of existing assets.
-- Exclusive locks close the gap between checking the empty ledger and recording
-- the permanent denomination. A funded deployment must use a separate migration.
LOCK TABLE public.wallets, public.wallet_transactions, public.economic_operations,
 public.coin_provenance, public.agent_orders, public.withdrawals,
 public.crypto_deposits, public.crypto_withdrawals, public.agent_inventories,
 public.withdrawal_quotes, public.exchange_rate_configs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.wallets WHERE "coinsBalance"<>0)
 OR EXISTS(SELECT 1 FROM public.wallet_transactions WHERE currency='COINS')
 OR EXISTS(SELECT 1 FROM public.economic_operations)
 OR EXISTS(SELECT 1 FROM public.coin_provenance)
 OR EXISTS(SELECT 1 FROM public.agent_orders)
 OR EXISTS(SELECT 1 FROM public.withdrawals)
 OR EXISTS(SELECT 1 FROM public.crypto_deposits)
 OR EXISTS(SELECT 1 FROM public.crypto_withdrawals)
 OR EXISTS(SELECT 1 FROM public.agent_inventories)
 OR EXISTS(SELECT 1 FROM public.withdrawal_quotes)
 OR EXISTS(SELECT 1 FROM public.exchange_rate_configs) THEN
   RAISE EXCEPTION 'ETB initialization refused: existing financial records require an explicit migration';
 END IF;
END $$;

CREATE TABLE public.wallet_denomination (
 id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
 currency TEXT NOT NULL CHECK(currency='ETB'),
 "minorDigits" INTEGER NOT NULL CHECK("minorDigits"=2),
 "initializedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.wallet_denomination(id,currency,"minorDigits") VALUES(true,'ETB',2);
CREATE TRIGGER wallet_denomination_permanent BEFORE UPDATE OR DELETE ON public.wallet_denomination
 FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();
COMMENT ON COLUMN public.wallets."coinsBalance" IS 'Legacy column name; ETB santim after wallet_denomination initialization. 100 units = 1 Birr.';

CREATE TABLE public.etb_reference_refresh (
 id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
 "lastAttemptAt" TIMESTAMPTZ,
 "lastSuccessAt" TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','READY','UNAVAILABLE'))
);
INSERT INTO public.etb_reference_refresh(id) VALUES(true);
-- Old token bundles have no meaning in a native Birr wallet; no balances changed.
UPDATE public.coin_packages SET "isActive"=false,"updatedAt"=now();

CREATE FUNCTION public.etb_rate_terms_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW."fiatCurrency"<>'ETB' OR (NEW."pricingPolicy"->>'version') IS DISTINCT FROM 'ETB_V1'
 OR (NEW."pricingPolicy"->>'walletCurrency') IS DISTINCT FROM 'ETB'
 OR (NEW."pricingPolicy"->>'minorDigits') IS DISTINCT FROM '2' OR NEW."coinsPerUnit"<>1 THEN
   RAISE EXCEPTION 'Native ETB wallet requires ETB pricing terms';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER etb_rate_terms BEFORE INSERT ON public.exchange_rate_configs
 FOR EACH ROW EXECUTE FUNCTION public.etb_rate_terms_guard();
CREATE TRIGGER etb_rate_history BEFORE DELETE ON public.exchange_rate_configs
 FOR EACH ROW EXECUTE FUNCTION public.financial_history_append_only();

-- Keep every receipt/hold/settlement proof trigger. Replace only the obsolete
-- 96-units/USD arithmetic constraint with the locked ETB conversion formula.
DO $$ DECLARE c RECORD; n INTEGER:=0; BEGIN
 FOR c IN SELECT conname,conrelid::regclass AS tab FROM pg_constraint
 WHERE conrelid IN ('public.crypto_deposits'::regclass,'public.crypto_withdrawals'::regclass)
 AND contype='c' AND pg_get_constraintdef(oid) LIKE '%floor%' AND pg_get_constraintdef(oid) LIKE '%96%'
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tab,c.conname); n:=n+1; END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'Expected exactly two legacy crypto pricing constraints'; END IF;
END $$;
CREATE FUNCTION public.etb_crypto_amount_valid(direction TEXT,micro BIGINT,minor INTEGER,snapshot JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE rate NUMERIC; source JSONB;
BEGIN
 IF snapshot->>'version' IS DISTINCT FROM 'ETB_V1' OR snapshot->>'walletCurrency' IS DISTINCT FROM 'ETB'
 OR snapshot->>'minorDigits' IS DISTINCT FROM '2' OR snapshot->>'usdtPerUsd' IS DISTINCT FROM '1'
 OR coalesce(snapshot->>'localPerUsd','') !~ '^[0-9]+([.][0-9]{1,8})?$' THEN RETURN false; END IF;
 rate:=(snapshot->>'localPerUsd')::numeric;
 IF rate<=0 OR rate>100000 THEN RETURN false; END IF;
 SELECT "pricingPolicy" INTO source FROM public.exchange_rate_configs WHERE id=snapshot->>'rateId';
 IF source IS NULL OR NOT snapshot @> source THEN RETURN false; END IF;
 IF direction='deposit' THEN RETURN minor=floor(micro::numeric*rate*100/1000000); END IF;
 IF direction='withdrawal' THEN RETURN micro=floor(minor::numeric*1000000/(rate*100)); END IF;
 RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE public.crypto_deposits ADD CONSTRAINT crypto_deposit_etb_amount
 CHECK(public.etb_crypto_amount_valid('deposit',"amountMicro","coinAmount","pricingSnapshot"));
ALTER TABLE public.crypto_withdrawals ADD CONSTRAINT crypto_withdrawal_etb_amount
 CHECK(public.etb_crypto_amount_valid('withdrawal',"amountMicro","coinAmount","pricingSnapshot"));
ALTER TABLE public.crypto_deposits ADD CONSTRAINT crypto_deposit_etb_window CHECK(coalesce(
 ("pricingSnapshot"->>'observedAt')::timestamptz<="createdAt"
 AND "createdAt"<("pricingSnapshot"->>'expiresAt')::timestamptz
 AND "expiresAt"<=("pricingSnapshot"->>'expiresAt')::timestamptz,false));
ALTER TABLE public.crypto_withdrawals ADD CONSTRAINT crypto_withdrawal_etb_window CHECK(coalesce(
 ("pricingSnapshot"->>'observedAt')::timestamptz<="createdAt"
 AND "createdAt"<("pricingSnapshot"->>'expiresAt')::timestamptz,false));
-- Persist the rate relation as well as its snapshot, including dump/restore order.
ALTER TABLE public.crypto_deposits ADD COLUMN "etbRateId" TEXT NOT NULL
 REFERENCES public.exchange_rate_configs(id) ON DELETE RESTRICT;
ALTER TABLE public.crypto_withdrawals ADD COLUMN "etbRateId" TEXT NOT NULL
 REFERENCES public.exchange_rate_configs(id) ON DELETE RESTRICT;
CREATE FUNCTION public.etb_link_payment_rate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 NEW."etbRateId":=NEW."pricingSnapshot"->>'rateId';
 RETURN NEW;
END $$;
CREATE TRIGGER crypto_deposit_rate_relation BEFORE INSERT ON public.crypto_deposits
 FOR EACH ROW EXECUTE FUNCTION public.etb_link_payment_rate();
CREATE TRIGGER crypto_withdrawal_rate_relation BEFORE INSERT ON public.crypto_withdrawals
 FOR EACH ROW EXECUTE FUNCTION public.etb_link_payment_rate();
REVOKE ALL ON FUNCTION public.etb_link_payment_rate() FROM PUBLIC;
REVOKE ALL ON public.wallet_denomination FROM PUBLIC;
REVOKE ALL ON public.etb_reference_refresh FROM PUBLIC;
REVOKE ALL ON FUNCTION public.etb_rate_terms_guard() FROM PUBLIC;
COMMIT;
