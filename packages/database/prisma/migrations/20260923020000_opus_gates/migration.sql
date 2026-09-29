-- M3: fail-closed switches; the application takes each gate FOR SHARE inside
-- any transaction that can create casino or withdrawal economic value.
INSERT INTO "platform_gates" ("key", "enabled", "changedAt") VALUES
  ('CASINO_PLAY', false, CURRENT_TIMESTAMP),
  ('BONUS_GRANT', false, CURRENT_TIMESTAMP),
  ('WITHDRAWAL_CREATE', false, CURRENT_TIMESTAMP),
  ('COINS_COMPETITION_PRIZES', false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
