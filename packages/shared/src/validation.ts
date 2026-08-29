import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const idParamSchema = z.object({
  id: z.string().uuid({ message: 'Invalid ID format' }),
});

export const usernameSchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores');

export const emailSchema = z.string().email('Invalid email format').max(255);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
});

export const createGroupSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().default(false),
  imageUrl: z.string().url().optional(),
  coverUrl: z.string().url().optional(),
});

export const updateGroupSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  isPrivate: z.boolean().optional(),
  imageUrl: z.string().url().optional(),
  coverUrl: z.string().url().optional(),
});

export const groupParamsSchema = z.object({
  id: z.string().uuid(),
});

export const groupListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  query: z.string().max(100).optional(),
});

export const groupMemberParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

export const changeMemberRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MODERATOR', 'MEMBER']),
});

export const createMessageSchema = z.object({
  groupId: z.string().uuid(),
  content: z.string().min(1).max(5000),
  type: z.enum(['text', 'voice']).default('text'),
  replyToId: z.string().uuid().optional(),
});

export const updateMessageSchema = z.object({
  content: z.string().min(1).max(5000),
});

export const reactionSchema = z.object({
  messageId: z.string().uuid(),
  type: z.enum(['like', 'love', 'laugh', 'wow', 'sad', 'angry']),
});

export const sendGiftSchema = z.object({
  groupId: z.string().uuid(),
  recipientId: z.string().uuid(),
  giftId: z.string().uuid(),
  message: z.string().max(200).optional(),
});

export const createGiftSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  imageUrl: z.string().url(),
  coinPrice: z.number().int().positive(),
  isAnimated: z.boolean().default(false),
  isLimited: z.boolean().default(false),
  limitedQuantity: z.number().int().positive().optional(),
  category: z.enum(['standard', 'premium', 'limited', 'seasonal']).default('standard'),
});

export const walletTransactionSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(['credit', 'debit']),
  amount: z.number().int().positive(),
  currency: z.enum(['coins', 'gamePoints']),
  referenceType: z.enum([
    'gift',
    'reward',
    'purchase',
    'game',
    'admin',
    'transfer',
    'daily_reward',
    'task',
    'achievement',
    'refund',
  ]),
  referenceId: z.string().uuid(),
  description: z.string().min(1).max(500),
});

export const createTaskSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000),
  type: z.enum(['daily', 'weekly', 'monthly', 'one_time', 'achievement']),
  requirement: z.record(z.unknown()),
  reward: z.object({
    type: z.enum(['coins', 'gamePoints', 'vip_days', 'gift']),
    value: z.number().int().positive(),
  }),
  expiresAt: z.string().datetime().optional(),
});

export const createAchievementSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  iconUrl: z.string().url(),
  category: z.enum([
    'social',
    'chat',
    'economy',
    'game',
    'engagement',
    'milestone',
  ]),
  requirement: z.record(z.unknown()),
  reward: z
    .object({
      type: z.enum(['coins', 'gamePoints', 'vip_days', 'gift']),
      value: z.number().int().positive(),
    })
    .optional(),
});

export const notificationSchema = z.object({
  userId: z.string().uuid(),
  type: z.string(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  data: z.record(z.unknown()).optional(),
  channels: z.array(z.enum(['in_app', 'email', 'push'])).default(['in_app']),
});

export const vipPurchaseSchema = z.object({
  tier: z.enum(['silver', 'gold', 'platinum']),
  durationDays: z.number().int().positive().default(30),
  autoRenew: z.boolean().default(false),
});

export const gameSessionSchema = z.object({
  gameType: z.enum(['lucky_spin', 'dice', 'trivia', 'number_challenge']),
  groupId: z.string().uuid().optional(),
  betAmount: z.number().int().nonnegative().default(0),
  currency: z.enum(['coins', 'gamePoints']).default('gamePoints'),
});

export const fileUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileType: z.string(),
  fileSize: z.number().int().positive(),
  bucket: z.string().min(1),
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type IdParam = z.infer<typeof idParamSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type GroupParams = z.infer<typeof groupParamsSchema>;
export type GroupListQuery = z.infer<typeof groupListQuerySchema>;
export type GroupMemberParams = z.infer<typeof groupMemberParamsSchema>;
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;
export type ReactionInput = z.infer<typeof reactionSchema>;
export type SendGiftInput = z.infer<typeof sendGiftSchema>;
export type CreateGiftInput = z.infer<typeof createGiftSchema>;
export type WalletTransactionInput = z.infer<typeof walletTransactionSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CreateAchievementInput = z.infer<typeof createAchievementSchema>;
export type NotificationInput = z.infer<typeof notificationSchema>;
export type VipPurchaseInput = z.infer<typeof vipPurchaseSchema>;
export type GameSessionInput = z.infer<typeof gameSessionSchema>;
export type FileUploadInput = z.infer<typeof fileUploadSchema>;