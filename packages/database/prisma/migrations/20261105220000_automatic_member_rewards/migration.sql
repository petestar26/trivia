-- Retry timing is operational metadata. Previously earned terms stay immutable.
ALTER TABLE member_reward_entitlements
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX member_reward_delivery_due ON member_reward_entitlements(next_attempt_at, created_at, id)
  WHERE claim_id IS NULL;

CREATE OR REPLACE FUNCTION protect_member_reward_entitlement() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Reward entitlements cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'claimed_at' - 'claim_id' - 'next_attempt_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'claimed_at' - 'claim_id' - 'next_attempt_at') OR OLD.claim_id IS NOT NULL THEN
    RAISE EXCEPTION 'Reward entitlement is immutable except for delivery and retry timing';
  END IF;
  IF NEW.claim_id IS NULL THEN
    IF NEW.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'Unfunded reward cannot be marked credited'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM reward_claims r WHERE r.id = NEW.claim_id AND r."userId" = NEW.user_id
    AND r."sourceType" = 'MEMBER_PROMOTION' AND r."sourceId" = NEW.id AND r."coinReward" = NEW.amount) THEN
    RAISE EXCEPTION 'Reward claim must match its funded entitlement';
  END IF;
  RETURN NEW;
END $$;
