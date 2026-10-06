-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED', 'BANNED');

-- CreateEnum
CREATE TYPE "GroupMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MODERATOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "GroupMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'BANNED', 'MUTED', 'LEFT');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'VOICE', 'SYSTEM', 'GIFT');

-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('LIKE', 'LOVE', 'LAUGH', 'WOW', 'SAD', 'ANGRY');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('MESSAGE', 'MENTION', 'REACTION', 'GIFT_RECEIVED', 'GROUP_INVITE', 'GROUP_JOIN_REQUEST', 'GROUP_APPROVED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'ACHIEVEMENT_UNLOCKED', 'REWARD_CLAIMED', 'LEADERBOARD_UPDATE', 'VIP_EXPIRING', 'VIP_EXPIRED', 'SYSTEM', 'MODERATION', 'CHALLENGE_RECEIVED', 'CHALLENGE_ACCEPTED', 'CHALLENGE_DECLINED', 'CHALLENGE_COMPLETED', 'COMPETITION_CREATED', 'COMPETITION_STARTING', 'COMPETITION_ENDED', 'COMPETITION_RESULT');

-- CreateEnum
CREATE TYPE "CurrencyType" AS ENUM ('COINS', 'GAME_POINTS');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "EconomyTransactionType" AS ENUM ('COIN_CREDIT', 'COIN_DEBIT', 'GAME_POINT_CREDIT', 'GAME_POINT_DEBIT', 'GIFT_SEND', 'GIFT_RECEIVE');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TransactionReferenceType" AS ENUM ('GIFT', 'REWARD', 'PURCHASE', 'GAME', 'ADMIN', 'TRANSFER', 'DAILY_REWARD', 'TASK', 'ACHIEVEMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "VipTier" AS ENUM ('SILVER', 'GOLD', 'PLATINUM');

-- CreateEnum
CREATE TYPE "VipStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'PENDING');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ONE_TIME', 'ACHIEVEMENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CLAIMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AchievementCategory" AS ENUM ('SOCIAL', 'CHAT', 'ECONOMY', 'GAME', 'ENGAGEMENT', 'MILESTONE');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('LUCKY_SPIN', 'DICE', 'TRIVIA', 'NUMBER_CHALLENGE');

-- CreateEnum
CREATE TYPE "GameSessionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CompetitionStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CompetitionScoring" AS ENUM ('DICE_SUM', 'NUMBER_DISTANCE', 'TRIVIA_CORRECT', 'SPIN_MULTIPLIER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldData" JSONB,
    "newData" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "coverUrl" TEXT,
    "metadata" JSONB,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "coverUrl" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "GroupMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "GroupMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "replyToId" TEXT,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_messages" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'audio/ogg',
    "duration" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coinsBalance" INTEGER NOT NULL DEFAULT 0,
    "gamePointsBalance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "EconomyTransactionType" NOT NULL,
    "ledgerType" "LedgerType" NOT NULL,
    "currency" "CurrencyType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "referenceType" "TransactionReferenceType" NOT NULL,
    "referenceId" TEXT,
    "description" TEXT NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gifts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "coinPrice" INTEGER NOT NULL,
    "recipientPointValue" INTEGER NOT NULL,
    "isAnimated" BOOLEAN NOT NULL DEFAULT false,
    "isLimited" BOOLEAN NOT NULL DEFAULT false,
    "limitedQuantity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_transactions" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "giftId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "totalCoins" INTEGER NOT NULL,
    "totalGamePoints" INTEGER NOT NULL,
    "coinPriceAtTransaction" INTEGER NOT NULL,
    "pointValueAtTransaction" INTEGER NOT NULL,
    "senderWalletId" TEXT NOT NULL,
    "recipientWalletId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
    "responseKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "VipTier" NOT NULL,
    "status" "VipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vip_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_progress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_xp_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_xp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "target" INTEGER NOT NULL DEFAULT 1,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "coinReward" INTEGER NOT NULL DEFAULT 0,
    "gamePointReward" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" "TaskStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "periodKey" TEXT,
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_streaks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActivityDay" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_streaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_claims" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "coinReward" INTEGER NOT NULL DEFAULT 0,
    "gamePointReward" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" "AchievementCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "coinReward" INTEGER NOT NULL DEFAULT 0,
    "gamePointReward" INTEGER NOT NULL DEFAULT 0,
    "iconUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "GameType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "minBet" INTEGER NOT NULL DEFAULT 1,
    "maxBet" INTEGER NOT NULL DEFAULT 1000,
    "configuration" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "challengeId" TEXT,
    "status" "GameSessionStatus" NOT NULL DEFAULT 'PENDING',
    "betAmount" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "rewardAmount" INTEGER NOT NULL DEFAULT 0,
    "isWin" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trivia_questions" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "choices" JSONB NOT NULL,
    "correctIndex" INTEGER NOT NULL,
    "category" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trivia_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_trivia_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_trivia_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_trivia_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_trivia_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_challenges" (
    "id" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "challengedId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "entryAmount" INTEGER NOT NULL,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "winnerId" TEXT,
    "resultMeta" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "game_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_competitions" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "CompetitionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scoring" "CompetitionScoring" NOT NULL,
    "entryAmount" INTEGER NOT NULL DEFAULT 0,
    "maxParticipants" INTEGER,
    "participantCount" INTEGER NOT NULL DEFAULT 0,
    "rewardGamePoints" INTEGER NOT NULL DEFAULT 0,
    "rewardCoins" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "finalizerId" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_participants" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryPaid" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshToken_key" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_refreshToken_idx" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_userId_key" ON "profiles"("userId");

-- CreateIndex
CREATE INDEX "groups_ownerId_idx" ON "groups"("ownerId");

-- CreateIndex
CREATE INDEX "groups_status_idx" ON "groups"("status");

-- CreateIndex
CREATE INDEX "groups_createdAt_idx" ON "groups"("createdAt");

-- CreateIndex
CREATE INDEX "group_members_groupId_idx" ON "group_members"("groupId");

-- CreateIndex
CREATE INDEX "group_members_userId_idx" ON "group_members"("userId");

-- CreateIndex
CREATE INDEX "group_members_status_idx" ON "group_members"("status");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_groupId_userId_key" ON "group_members"("groupId", "userId");

-- CreateIndex
CREATE INDEX "messages_groupId_createdAt_idx" ON "messages"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_userId_idx" ON "messages"("userId");

-- CreateIndex
CREATE INDEX "messages_replyToId_idx" ON "messages"("replyToId");

-- CreateIndex
CREATE INDEX "message_reactions_messageId_idx" ON "message_reactions"("messageId");

-- CreateIndex
CREATE INDEX "message_reactions_userId_idx" ON "message_reactions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_messageId_userId_type_key" ON "message_reactions"("messageId", "userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "voice_messages_messageId_key" ON "voice_messages"("messageId");

-- CreateIndex
CREATE INDEX "voice_messages_messageId_idx" ON "voice_messages"("messageId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_userId_createdAt_idx" ON "wallet_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "gifts_isActive_idx" ON "gifts"("isActive");

-- CreateIndex
CREATE INDEX "gift_transactions_senderId_createdAt_idx" ON "gift_transactions"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_transactions_recipientId_createdAt_idx" ON "gift_transactions"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_transactions_giftId_idx" ON "gift_transactions"("giftId");

-- CreateIndex
CREATE INDEX "gift_transactions_createdAt_idx" ON "gift_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "idempotency_records_userId_idx" ON "idempotency_records"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_userId_key_key" ON "idempotency_records"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "vip_memberships_userId_key" ON "vip_memberships"("userId");

-- CreateIndex
CREATE INDEX "vip_memberships_expiresAt_idx" ON "vip_memberships"("expiresAt");

-- CreateIndex
CREATE INDEX "vip_memberships_status_idx" ON "vip_memberships"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_progress_userId_key" ON "user_progress"("userId");

-- CreateIndex
CREATE INDEX "user_xp_events_userId_createdAt_idx" ON "user_xp_events"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_xp_events_referenceType_referenceId_userId_key" ON "user_xp_events"("referenceType", "referenceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "task_definitions_key_key" ON "task_definitions"("key");

-- CreateIndex
CREATE INDEX "task_definitions_type_idx" ON "task_definitions"("type");

-- CreateIndex
CREATE INDEX "task_definitions_isActive_idx" ON "task_definitions"("isActive");

-- CreateIndex
CREATE INDEX "user_tasks_userId_status_idx" ON "user_tasks"("userId", "status");

-- CreateIndex
CREATE INDEX "user_tasks_taskId_idx" ON "user_tasks"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "user_tasks_userId_taskId_periodKey_key" ON "user_tasks"("userId", "taskId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "daily_streaks_userId_key" ON "daily_streaks"("userId");

-- CreateIndex
CREATE INDEX "reward_claims_userId_idx" ON "reward_claims"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_claims_userId_sourceType_sourceId_key" ON "reward_claims"("userId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "achievements_key_key" ON "achievements"("key");

-- CreateIndex
CREATE INDEX "achievements_category_idx" ON "achievements"("category");

-- CreateIndex
CREATE INDEX "achievements_isActive_idx" ON "achievements"("isActive");

-- CreateIndex
CREATE INDEX "user_achievements_userId_idx" ON "user_achievements"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_userId_achievementId_key" ON "user_achievements"("userId", "achievementId");

-- CreateIndex
CREATE UNIQUE INDEX "game_definitions_key_key" ON "game_definitions"("key");

-- CreateIndex
CREATE INDEX "game_definitions_isActive_idx" ON "game_definitions"("isActive");

-- CreateIndex
CREATE INDEX "game_definitions_key_idx" ON "game_definitions"("key");

-- CreateIndex
CREATE INDEX "game_sessions_userId_createdAt_idx" ON "game_sessions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "game_sessions_gameId_idx" ON "game_sessions"("gameId");

-- CreateIndex
CREATE INDEX "game_sessions_idempotencyKey_idx" ON "game_sessions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "game_sessions_challengeId_idx" ON "game_sessions"("challengeId");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_userId_idempotencyKey_key" ON "game_sessions"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_challengeId_userId_key" ON "game_sessions"("challengeId", "userId");

-- CreateIndex
CREATE INDEX "trivia_questions_isActive_idx" ON "trivia_questions"("isActive");

-- CreateIndex
CREATE INDEX "user_trivia_attempts_userId_answeredAt_idx" ON "user_trivia_attempts"("userId", "answeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_trivia_attempts_userId_questionId_key" ON "user_trivia_attempts"("userId", "questionId");

-- CreateIndex
CREATE INDEX "competition_trivia_attempts_userId_competitionId_idx" ON "competition_trivia_attempts"("userId", "competitionId");

-- CreateIndex
CREATE INDEX "competition_trivia_attempts_competitionId_questionId_idx" ON "competition_trivia_attempts"("competitionId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "competition_trivia_attempts_userId_competitionId_questionId_key" ON "competition_trivia_attempts"("userId", "competitionId", "questionId");

-- CreateIndex
CREATE INDEX "game_challenges_challengerId_createdAt_idx" ON "game_challenges"("challengerId", "createdAt");

-- CreateIndex
CREATE INDEX "game_challenges_challengedId_createdAt_idx" ON "game_challenges"("challengedId", "createdAt");

-- CreateIndex
CREATE INDEX "game_challenges_gameId_idx" ON "game_challenges"("gameId");

-- CreateIndex
CREATE INDEX "game_challenges_status_idx" ON "game_challenges"("status");

-- CreateIndex
CREATE INDEX "group_competitions_groupId_status_idx" ON "group_competitions"("groupId", "status");

-- CreateIndex
CREATE INDEX "group_competitions_gameId_idx" ON "group_competitions"("gameId");

-- CreateIndex
CREATE INDEX "group_competitions_status_startsAt_idx" ON "group_competitions"("status", "startsAt");

-- CreateIndex
CREATE INDEX "competition_participants_userId_idx" ON "competition_participants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "competition_participants_competitionId_userId_key" ON "competition_participants"("competitionId", "userId");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_messages" ADD CONSTRAINT "voice_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_senderWalletId_fkey" FOREIGN KEY ("senderWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_recipientWalletId_fkey" FOREIGN KEY ("recipientWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "gifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_memberships" ADD CONSTRAINT "vip_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_xp_events" ADD CONSTRAINT "user_xp_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tasks" ADD CONSTRAINT "user_tasks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "task_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_streaks" ADD CONSTRAINT "daily_streaks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "game_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_trivia_attempts" ADD CONSTRAINT "user_trivia_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_trivia_attempts" ADD CONSTRAINT "user_trivia_attempts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "trivia_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_trivia_attempts" ADD CONSTRAINT "competition_trivia_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_trivia_attempts" ADD CONSTRAINT "competition_trivia_attempts_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "group_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_trivia_attempts" ADD CONSTRAINT "competition_trivia_attempts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "trivia_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_challenges" ADD CONSTRAINT "game_challenges_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_challenges" ADD CONSTRAINT "game_challenges_challengedId_fkey" FOREIGN KEY ("challengedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_challenges" ADD CONSTRAINT "game_challenges_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_challenges" ADD CONSTRAINT "game_challenges_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_competitions" ADD CONSTRAINT "group_competitions_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_competitions" ADD CONSTRAINT "group_competitions_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "game_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_competitions" ADD CONSTRAINT "group_competitions_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_competitions" ADD CONSTRAINT "group_competitions_finalizerId_fkey" FOREIGN KEY ("finalizerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "group_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_participants" ADD CONSTRAINT "competition_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

