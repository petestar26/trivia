-- Practice release only: the catalog row stays inactive and Coin wagering remains paused in
-- application code regardless of this row. Enabling practice is a separate, flag-only step.
INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES(gen_random_uuid()::text,'virtual_football_3d','Virtual Football 3D','Twenty fictional clubs, ten fixtures every five minutes. Free practice credits only.','VIRTUAL_FOOTBALL_3D','WAGER','SCHEDULED_RACE','COMING_SOON',false,5,500,'COINS','COINS','{"practiceRulesId":"virtual-football-3d-practice-v1"}',now())
ON CONFLICT(key) DO NOTHING;
