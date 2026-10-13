-- Runtime audit projection never exposes the unrevealed seed or a mutation.
CREATE FUNCTION public.house_beacon_audit_page(after_id TEXT)
RETURNS TABLE(id TEXT,"cutoffMs" BIGINT,"chainHash" TEXT,"beaconRound" BIGINT,"beaconTimeMs" BIGINT,"signatureHex" TEXT,"randomnessHex" TEXT,"timingValid" BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
      SELECT p.round_id AS id, g.closes_ms AS "cutoffMs", p.chain_hash AS "chainHash",
        p.beacon_round AS "beaconRound", p.beacon_time_ms AS "beaconTimeMs",
        p.signature_hex AS "signatureHex", p.randomness_hex AS "randomnessHex",
        COALESCE(g.mode='FINANCIAL' AND g.game_key='spin_win'
          AND x.algorithm='sha256-quicknet-rejection-u32be-v2'
          AND EXTRACT(EPOCH FROM p.pinned_at)*1000>=g.opens_ms
          AND EXTRACT(EPOCH FROM p.pinned_at)*1000<g.closes_ms
          AND x.prepared_at>=p.pinned_at
          AND EXTRACT(EPOCH FROM x.prepared_at)*1000<g.closes_ms
          AND EXTRACT(EPOCH FROM p.received_at)*1000>=p.beacon_time_ms,
          FALSE) AS "timingValid"
      FROM public.house_round_beacon_pins p
      LEFT JOIN public.scheduled_game_rounds g ON g.id=p.round_id
      LEFT JOIN public.house_round_randomness x ON x.round_id=p.round_id
      WHERE p.signature_hex IS NOT NULL
        AND (after_id IS NULL OR p.round_id COLLATE "C">after_id COLLATE "C")
      ORDER BY p.round_id COLLATE "C" LIMIT 100;
$$;
