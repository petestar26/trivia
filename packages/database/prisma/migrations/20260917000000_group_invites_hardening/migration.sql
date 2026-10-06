-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_INVITE_ACCEPTED';

-- Atomic partial unique constraint for PENDING invites: no two pending
-- invites for the same (groupId, email), while accepted/revoked/expired
-- invites coexist so a manager can re-invite after the prior one resolves.
-- Matching a PENDING invite for the same email case-insensitively is
-- guaranteed by the API layer, which normalizes invite emails to lowercase.
CREATE UNIQUE INDEX "group_invites_groupId_email_pending_key"
  ON "group_invites"("groupId", "email")
  WHERE "status" = 'PENDING';