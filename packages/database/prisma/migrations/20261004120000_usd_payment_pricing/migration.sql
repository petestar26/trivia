BEGIN;
SET LOCAL lock_timeout = '20s';
-- Additive, deliberately dormant: existing countries and prices remain legacy.
ALTER TABLE countries ADD COLUMN "usdPricingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE exchange_rate_configs ADD COLUMN "pricingPolicy" JSONB;
ALTER TABLE agent_orders ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE withdrawal_quotes ADD COLUMN "pricingSnapshot" JSONB;
ALTER TABLE withdrawals ADD COLUMN "pricingSnapshot" JSONB;

CREATE TABLE coin_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "coinAmount" INTEGER NOT NULL CHECK ("coinAmount" > 0 AND "coinAmount" <= 1000000000),
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  featured BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
INSERT INTO coin_packages (id,name,"coinAmount","isActive","displayOrder","updatedAt") VALUES
 ('usd-coins-30','30 Coins',30,true,1,CURRENT_TIMESTAMP),
 ('usd-coins-70','70 Coins',70,true,2,CURRENT_TIMESTAMP),
 ('usd-coins-350','350 Coins',350,true,3,CURRENT_TIMESTAMP),
 ('usd-coins-700','700 Coins',700,true,4,CURRENT_TIMESTAMP),
 ('usd-coins-1400','1,400 Coins',1400,true,5,CURRENT_TIMESTAMP),
 ('usd-coins-3500','3,500 Coins',3500,true,6,CURRENT_TIMESTAMP);

CREATE FUNCTION payment_protect_usd_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pricingSnapshot" IS DISTINCT FROM OLD."pricingSnapshot" THEN
    RAISE EXCEPTION 'USD payment snapshots are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER agent_order_usd_snapshot BEFORE UPDATE ON agent_orders FOR EACH ROW EXECUTE FUNCTION payment_protect_usd_snapshot();
CREATE TRIGGER withdrawal_quote_usd_snapshot BEFORE UPDATE ON withdrawal_quotes FOR EACH ROW EXECUTE FUNCTION payment_protect_usd_snapshot();
CREATE TRIGGER withdrawal_usd_snapshot BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION payment_protect_usd_snapshot();

CREATE FUNCTION payment_protect_usd_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pricingPolicy" IS DISTINCT FROM OLD."pricingPolicy" OR
    (OLD."pricingPolicy" IS NOT NULL AND
      (NEW."countryId", NEW."fiatCurrency", NEW."coinsPerUnit", NEW."effectiveAt", NEW."setBy") IS DISTINCT FROM
      (OLD."countryId", OLD."fiatCurrency", OLD."coinsPerUnit", OLD."effectiveAt", OLD."setBy")) THEN
    RAISE EXCEPTION 'USD pricing terms are immutable; publish a new rate';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER exchange_rate_usd_terms BEFORE UPDATE ON exchange_rate_configs FOR EACH ROW EXECUTE FUNCTION payment_protect_usd_rate();

CREATE FUNCTION payment_protect_usd_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."usdPricingEnabled" AND NOT NEW."usdPricingEnabled" THEN
    RAISE EXCEPTION 'USD pricing cannot revert to legacy pricing; disable payment availability instead';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER country_usd_activation BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION payment_protect_usd_activation();

REVOKE ALL ON FUNCTION payment_protect_usd_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_protect_usd_rate() FROM PUBLIC;
REVOKE ALL ON FUNCTION payment_protect_usd_activation() FROM PUBLIC;
COMMIT;
