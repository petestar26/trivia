-- Practice release only: financial admission remains disabled.
INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES(gen_random_uuid()::text,'sky_crash','Sky Crash','Fly above the alpine dawn. Cash out before the crash. Free practice credits only.','SKY_CRASH','WAGER','INSTANT','COMING_SOON',false,10,500,'COINS','COINS','{"practiceRulesId":"sky-crash-practice90-v1"}',now()) ON CONFLICT(key) DO NOTHING;
