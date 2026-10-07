-- Practice release only: financial admission remains disabled.
INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES(gen_random_uuid()::text,'crash_point','Crash Point','Follow the ruby curve. Cash out before the crash. Free practice credits only.','CRASH_POINT','WAGER','INSTANT','COMING_SOON',false,10,500,'COINS','COINS','{"practiceRulesId":"crash-point-practice90-v1"}',now()) ON CONFLICT(key) DO NOTHING;
