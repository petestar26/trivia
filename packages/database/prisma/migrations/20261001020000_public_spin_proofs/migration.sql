-- Read-only public projection. Runtime keeps no SELECT grant on private seeds.
-- This exposes only immutable v2 terms and terminal reveal; it does not witness
-- external publication, create receipts, admit tickets, or enable wagering.
BEGIN;
CREATE FUNCTION public.house_public_spin_proof(rid TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE terms JSONB; revealed JSONB; state TEXT;
BEGIN
  IF rid IS NULL OR rid !~ '^[A-Za-z0-9_:-]{1,128}$' THEN RETURN NULL; END IF;
  SELECT pg_catalog.jsonb_build_object(
    'roundId',g.id,'rulesId',g.rules_id,'protocol',x.algorithm,'chainHash',p.chain_hash,
    'opensAtMs',g.opens_ms,'closesAtMs',g.closes_ms,
    'pinnedAtMs',pg_catalog.floor(EXTRACT(EPOCH FROM p.pinned_at)*1000)::BIGINT,
    'preparedAtMs',pg_catalog.floor(EXTRACT(EPOCH FROM x.prepared_at)*1000)::BIGINT,
    'seedCommitment',x.commitment_sha256,'beaconRound',p.beacon_round,'beaconTimeMs',p.beacon_time_ms),
    g.state,
    CASE WHEN g.state='DRAWN' AND x.revealed_at IS NOT NULL AND g.drawn_at IS NOT NULL
      AND x.cancelled_outcome IS NULL AND p.signature_hex IS NOT NULL THEN
      pg_catalog.jsonb_build_object('seedHex',x.seed_hex,'outcome',g.outcome,
        'drawnAtMs',pg_catalog.floor(EXTRACT(EPOCH FROM g.drawn_at)*1000)::BIGINT,
        'beacon',pg_catalog.jsonb_build_object('round',p.beacon_round,
          'signature',p.signature_hex,'randomness',p.randomness_hex))
      ELSE NULL END
    INTO terms,state,revealed
  FROM public.scheduled_game_rounds g
  JOIN public.house_round_randomness x ON x.round_id=g.id
  JOIN public.house_round_beacon_pins p ON p.round_id=g.id
  WHERE g.id=rid AND g.game_key='spin_win' AND g.rules_id='single-zero-rtp90-v2'
    AND g.mode='FINANCIAL' AND x.algorithm='sha256-quicknet-rejection-u32be-v2'
    AND g.state IN ('OPEN','DRAWN');
  IF terms IS NULL OR (state='DRAWN' AND revealed IS NULL) THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object('commitment',terms,'stage',
    CASE WHEN state='DRAWN' THEN 'DRAWN' ELSE 'PENDING' END,'reveal',revealed);
END $$;
REVOKE ALL ON FUNCTION public.house_public_spin_proof(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.house_public_spin_proof(TEXT) TO PUBLIC;
COMMIT;
