-- Slice A3: Repair the Session <-> User relation.

-- Sessions historically had no foreign key, so orphan rows may exist in
-- production. Remove any session whose userId does not reference an existing
-- user before adding the constraint.
DELETE FROM "sessions"
WHERE "userId" NOT IN (SELECT "id" FROM "users");

-- Add the foreign key with cascade delete (matches Profile/Notification
-- cascade convention and the schema @relation(onDelete: Cascade)).
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;