-- Amounts are ETB minor units (100 santim = 1 Birr). No promotion starts enabled.
CREATE TABLE member_reward_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  daily_enabled BOOLEAN NOT NULL DEFAULT false,
  daily_amount INTEGER NOT NULL DEFAULT 0 CHECK (daily_amount BETWEEN 0 AND 100000000),
  gift_enabled BOOLEAN NOT NULL DEFAULT false,
  gift_amount INTEGER NOT NULL DEFAULT 0 CHECK (gift_amount BETWEEN 0 AND 100000000),
  gift_daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (gift_daily_limit BETWEEN 0 AND 100000000),
  referral_enabled BOOLEAN NOT NULL DEFAULT false,
  referral_amount INTEGER NOT NULL DEFAULT 0 CHECK (referral_amount BETWEEN 0 AND 100000000),
  gift_minimum INTEGER NOT NULL DEFAULT 0 CHECK (gift_minimum BETWEEN 0 AND 100000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (NOT daily_enabled OR daily_amount > 0),
  CHECK (NOT gift_enabled OR (gift_amount > 0 AND gift_daily_limit >= gift_amount)),
  CHECK (NOT referral_enabled OR referral_amount > 0),
  CHECK (NOT (gift_enabled OR referral_enabled) OR gift_minimum > 0)
);
INSERT INTO member_reward_config(id) VALUES ('default');

-- Entitlements survive a temporarily unavailable bonus wallet. A claim and its
-- monetary ledger grant commit together; configuration changes are not retroactive.
CREATE TABLE member_reward_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('DAILY', 'GIFT', 'REFERRAL')),
  source_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  reward_day DATE NOT NULL,
  gift_transaction_id TEXT REFERENCES gift_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  claim_id TEXT UNIQUE REFERENCES reward_claims(id) ON DELETE RESTRICT,
  UNIQUE(user_id, kind, source_key),
  CHECK ((claimed_at IS NULL) = (claim_id IS NULL)),
  CHECK ((kind = 'DAILY' AND gift_transaction_id IS NULL) OR (kind <> 'DAILY' AND gift_transaction_id IS NOT NULL))
);
CREATE INDEX member_reward_entitlements_owner ON member_reward_entitlements(user_id, created_at DESC, id);
CREATE INDEX member_reward_entitlements_day ON member_reward_entitlements(user_id, kind, reward_day);
CREATE UNIQUE INDEX member_reward_referral_once ON member_reward_entitlements(source_key) WHERE kind = 'REFERRAL';

CREATE FUNCTION protect_member_reward_entitlement() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Reward entitlements cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'claimed_at' - 'claim_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'claimed_at' - 'claim_id') OR OLD.claim_id IS NOT NULL OR NEW.claim_id IS NULL THEN
    RAISE EXCEPTION 'Reward entitlement is immutable except for its first claim';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM reward_claims r WHERE r.id = NEW.claim_id AND r."userId" = NEW.user_id
    AND r."sourceType" = 'MEMBER_PROMOTION' AND r."sourceId" = NEW.id AND r."coinReward" = NEW.amount) THEN
    RAISE EXCEPTION 'Reward claim must match its funded entitlement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_reward_entitlement_guard BEFORE UPDATE OR DELETE ON member_reward_entitlements
FOR EACH ROW EXECUTE FUNCTION protect_member_reward_entitlement();
