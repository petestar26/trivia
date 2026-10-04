-- Existing grants keep their pinned rollover terms. Newly issued reward
-- grants use NET_WINNINGS_V1; free principal can never become spendable.
ALTER TABLE coin_provenance ADD COLUMN "bonusRule" text CHECK ("bonusRule" IS NULL OR "bonusRule"='NET_WINNINGS_V1');
CREATE UNIQUE INDEX bonus_net_win_once ON economic_operations("userId",("snapshot"->>'sourceLotId'),("snapshot"->>'sessionId'))
  WHERE type='BONUS_CONVERSION' AND "scopeType"='BONUS_NET_WIN';

CREATE FUNCTION bonus_reward_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE op record; lot record; stake bigint; payout bigint; total_stake bigint; total_payout bigint; converted bigint;
BEGIN
  IF TG_TABLE_NAME='coin_provenance' THEN
    IF TG_OP='UPDATE' AND NEW."bonusRule" IS DISTINCT FROM OLD."bonusRule" THEN RAISE EXCEPTION 'Reward rule is immutable'; END IF;
    IF TG_OP='INSERT' AND NEW."bonusRule" IS NOT NULL AND (NEW."lotClass"<>'RESTRICTED' OR NOT EXISTS(
      SELECT 1 FROM public.economic_operations WHERE id=NEW."sourceOperationId" AND type='BONUS_GRANT' AND "userId"=NEW."userId"
    )) THEN RAISE EXCEPTION 'Net winnings rule requires a restricted bonus grant'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO op FROM public.economic_operations WHERE id=NEW."operationId";
  SELECT * INTO lot FROM public.coin_provenance WHERE id=NEW."lotId";
  IF op.type='GIFT_SPEND' AND lot."lotClass" IS DISTINCT FROM 'WITHDRAWABLE' THEN
    RAISE EXCEPTION 'Reward and unclassified Coins cannot buy gifts';
  END IF;
  IF lot."bonusRule"='NET_WINNINGS_V1' THEN
    IF NEW."entryType"='PROGRESS' THEN RAISE EXCEPTION 'Free principal cannot unlock through rollover'; END IF;
    IF NEW."entryType"='CONVERT_OUT' AND op."scopeType"<>'BONUS_NET_WIN' THEN RAISE EXCEPTION 'Free principal cannot be converted'; END IF;
  END IF;
  IF op.type='BONUS_CONVERSION' AND op."scopeType"='BONUS_NET_WIN' THEN
    IF op."snapshot"->>'rule' IS DISTINCT FROM 'NET_WINNINGS_V1' OR NEW."entryType" NOT IN ('CONVERT_OUT','CONVERT_IN') THEN
      RAISE EXCEPTION 'Invalid net winnings conversion';
    END IF;
    IF NEW."entryType"='CONVERT_OUT' THEN
      IF lot."bonusRule" IS DISTINCT FROM 'NET_WINNINGS_V1' OR op."snapshot"->>'sourceLotId' IS DISTINCT FROM lot.id
         OR op."userId" IS DISTINCT FROM lot."userId" OR op."countryPolicyId" IS DISTINCT FROM lot."countryPolicyId"
         OR op."countryPolicyVersion" IS DISTINCT FROM lot."countryPolicyVersion" THEN RAISE EXCEPTION 'Net winnings source mismatch'; END IF;
      IF op."snapshot"->>'sourceKind'='GAME_SESSION' THEN
        SELECT COALESCE(sum(-e."availableDelta") FILTER(WHERE e."lotId"=lot.id),0),COALESCE(sum(-e."availableDelta"),0) INTO stake,total_stake
          FROM public.coin_lot_entries e JOIN public.economic_operations w ON w.id=e."operationId"
          WHERE w.type='WAGER' AND w."userId"=lot."userId" AND w."scopeType"='GAME_SESSION' AND w."scopeId"=op."snapshot"->>'sessionId' AND e."entryType"='CONSUME';
        SELECT COALESCE(sum(e."availableDelta") FILTER(WHERE e."lotId"=lot.id),0),COALESCE(sum(e."availableDelta"),0) INTO payout,total_payout
          FROM public.coin_lot_entries e JOIN public.economic_operations w ON w.id=e."operationId"
          WHERE w.type='PAYOUT' AND w."userId"=lot."userId" AND w."scopeType"='GAME_SESSION' AND w."scopeId"=op."snapshot"->>'sessionId' AND e."entryType"='RETURN';
      ELSIF op."snapshot"->>'sourceKind'='SCHEDULED_STAKE' THEN
        SELECT COALESCE(sum(e."reservedDelta") FILTER(WHERE e."lotId"=lot.id),0),COALESCE(sum(e."reservedDelta"),0) INTO stake,total_stake
          FROM public.coin_lot_entries e JOIN public.economic_operations w ON w.id=e."operationId"
          WHERE w.type='SCHEDULED_STAKE_HOLD' AND w."userId"=lot."userId" AND w."scopeType"='SCHEDULED_STAKE' AND w."scopeId"=op."snapshot"->>'sessionId' AND e."entryType"='RESERVE';
        SELECT COALESCE(sum(e."availableDelta") FILTER(WHERE e."lotId"=lot.id),0),COALESCE(sum(e."availableDelta"),0) INTO payout,total_payout
          FROM public.coin_lot_entries e JOIN public.economic_operations w ON w.id=e."operationId"
          WHERE w.type='SCHEDULED_STAKE_SETTLE' AND w."userId"=lot."userId" AND w."scopeType"='SCHEDULED_STAKE' AND w."scopeId"=op."snapshot"->>'sessionId' AND e."entryType"='RETURN';
      ELSE RAISE EXCEPTION 'Unknown net winnings source'; END IF;
      SELECT COALESCE(sum(-e."availableDelta"),0) INTO converted FROM public.coin_lot_entries e WHERE e."operationId"=op.id AND e."entryType"='CONVERT_OUT';
      IF stake<=0 OR total_stake<=0 OR payout<=stake OR total_payout<=total_stake
         OR converted-NEW."availableDelta">least(payout-stake,((total_payout-total_stake)*stake)/NULLIF(total_stake,0)) THEN RAISE EXCEPTION 'Only proven net winnings may convert'; END IF;
    ELSE
      IF lot."parentLotId" IS DISTINCT FROM op."snapshot"->>'sourceLotId' OR lot."sourceOperationId" IS DISTINCT FROM op.id
        OR lot."userId" IS DISTINCT FROM op."userId" THEN RAISE EXCEPTION 'Net winnings successor mismatch'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bonus_rule_pin BEFORE INSERT OR UPDATE ON coin_provenance FOR EACH ROW EXECUTE FUNCTION bonus_reward_rule_guard();
CREATE TRIGGER bonus_spend_guard BEFORE INSERT ON coin_lot_entries FOR EACH ROW EXECUTE FUNCTION bonus_reward_rule_guard();
REVOKE ALL ON FUNCTION bonus_reward_rule_guard() FROM PUBLIC;
