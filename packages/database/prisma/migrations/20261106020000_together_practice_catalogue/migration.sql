BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.play_together_policies IN SHARE ROW EXCLUSIVE MODE;

-- Expand only the original practice rollout. Never overwrite a later policy
-- selected by an administrator or alter the terms pinned to existing rounds.
INSERT INTO public.play_together_policies
 (version,fee_bps,min_entry,max_entry,enabled_games,practice_enabled,cash_enabled,public_rooms_enabled,changed_by)
SELECT version+1,fee_bps,min_entry,max_entry,
 ARRAY['spin_win','turbo_keno','dice','number_challenge','roulette_keno','lucky_six',
       'thunder_derby_3d','neon_hounds_3d','virtual_football_3d','blackjack','sky_crash','crash_point'],
 practice_enabled,false,public_rooms_enabled,NULL
FROM public.play_together_policies
WHERE version=(SELECT max(version) FROM public.play_together_policies)
 AND version=1 AND practice_enabled AND NOT cash_enabled
 AND enabled_games @> ARRAY['spin_win','turbo_keno','dice','number_challenge']
 AND cardinality(enabled_games)=4;

COMMIT;
