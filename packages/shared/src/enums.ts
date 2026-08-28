export enum UserRole {
  USER = 'user',
  MODERATOR = 'moderator',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
  BANNED = 'banned',
  PENDING_VERIFICATION = 'pending_verification',
}

export enum GroupType {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

export enum GroupMemberRole {
  MEMBER = 'member',
  MODERATOR = 'moderator',
  ADMIN = 'admin',
  OWNER = 'owner',
}

export enum GroupMemberStatus {
  ACTIVE = 'active',
  PENDING = 'pending',
  BANNED = 'banned',
  MUTED = 'muted',
  LEFT = 'left',
}

export enum MessageType {
  TEXT = 'text',
  VOICE = 'voice',
  SYSTEM = 'system',
  GIFT = 'gift',
}

export enum ReactionType {
  LIKE = 'like',
  LOVE = 'love',
  LAUGH = 'laugh',
  WOW = 'wow',
  SAD = 'sad',
  ANGRY = 'angry',
}

export enum GiftCategory {
  STANDARD = 'standard',
  PREMIUM = 'premium',
  LIMITED = 'limited',
  SEASONAL = 'seasonal',
}

export enum TransactionType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum TransactionCurrency {
  COINS = 'coins',
  GAME_POINTS = 'gamePoints',
}

export enum TransactionReferenceType {
  GIFT = 'gift',
  REWARD = 'reward',
  PURCHASE = 'purchase',
  GAME = 'game',
  ADMIN = 'admin',
  TRANSFER = 'transfer',
  DAILY_REWARD = 'daily_reward',
  TASK = 'task',
  ACHIEVEMENT = 'achievement',
  REFUND = 'refund',
}

export enum VipTier {
  SILVER = 'silver',
  GOLD = 'gold',
  PLATINUM = 'platinum',
}

export enum VipStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  PENDING = 'pending',
}

export enum GameType {
  LUCKY_SPIN = 'lucky_spin',
  DICE = 'dice',
  TRIVIA = 'trivia',
  NUMBER_CHALLENGE = 'number_challenge',
}

export enum GameSessionStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TaskType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  ONE_TIME = 'one_time',
  ACHIEVEMENT = 'achievement',
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CLAIMED = 'claimed',
  EXPIRED = 'expired',
}

export enum AchievementCategory {
  SOCIAL = 'social',
  CHAT = 'chat',
  ECONOMY = 'economy',
  GAME = 'game',
  ENGAGEMENT = 'engagement',
  MILESTONE = 'milestone',
}

export enum NotificationType {
  MESSAGE = 'message',
  MENTION = 'mention',
  REACTION = 'reaction',
  GIFT_RECEIVED = 'gift_received',
  GROUP_INVITE = 'group_invite',
  GROUP_JOIN_REQUEST = 'group_join_request',
  GROUP_APPROVED = 'group_approved',
  FRIEND_REQUEST = 'friend_request',
  FRIEND_ACCEPTED = 'friend_accepted',
  ACHIEVEMENT_UNLOCKED = 'achievement_unlocked',
  REWARD_CLAIMED = 'reward_claimed',
  LEADERBOARD_UPDATE = 'leaderboard_update',
  VIP_EXPIRING = 'vip_expiring',
  VIP_EXPIRED = 'vip_expired',
  SYSTEM = 'system',
  MODERATION = 'moderation',
}

export enum NotificationChannel {
  IN_APP = 'in_app',
  EMAIL = 'email',
  PUSH = 'push',
}

export enum StorageProvider {
  LOCAL = 'local',
  S3 = 's3',
  R2 = 'r2',
  MINIO = 'minio',
}

export enum FileType {
  IMAGE = 'image',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  OTHER = 'other',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export enum WebSocketEvent {
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',
  JOIN_ROOM = 'join_room',
  LEAVE_ROOM = 'leave_room',
  NEW_MESSAGE = 'new_message',
  MESSAGE_UPDATED = 'message_updated',
  MESSAGE_DELETED = 'message_deleted',
  REACTION_ADDED = 'reaction_added',
  REACTION_REMOVED = 'reaction_removed',
  TYPING_START = 'typing_start',
  TYPING_STOP = 'typing_stop',
  USER_PRESENCE = 'user_presence',
  NOTIFICATION = 'notification',
  GROUP_UPDATED = 'group_updated',
  GROUP_MEMBER_CHANGED = 'group_member_changed',
}

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  BAD_REQUEST = 'BAD_REQUEST',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  ITEM_NOT_AVAILABLE = 'ITEM_NOT_AVAILABLE',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
}