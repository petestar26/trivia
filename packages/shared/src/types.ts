export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export interface ApiResponse<T = null> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
}

export interface RequestContext {
  requestId: string;
  timestamp: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  roles: string[];
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface RefreshTokenPayload {
  sub: string;
  tokenVersion: number;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UserPublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  isVerified: boolean;
  createdAt: string;
}

export interface GroupBasicInfo {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  isPrivate: boolean;
  memberCount: number;
  createdAt: string;
}

export interface GroupDetailInfo extends GroupBasicInfo {
  owner: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  } | null;
  coverUrl?: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'BANNED';
  isMember: boolean;
  memberRole?: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
  updatedAt: string;
}

export interface GroupMemberInfo {
  id: string;
  groupId: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
  role: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
  status: 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED' | 'LEFT';
  joinedAt: string;
}

export interface MessageBasicInfo {
  id: string;
  groupId: string;
  userId: string;
  content: string;
  type: 'text' | 'voice' | 'system' | 'gift';
  createdAt: string;
}

export interface MessageDetailInfo extends MessageBasicInfo {
  sender: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
  replyTo?: MessageDetailInfo | null;
  isEdited: boolean;
  isDeleted: boolean;
  reactions: Array<{
    type: string;
    userId: string;
  }>;
  voiceMessage?: {
    id: string;
    storageKey: string;
    mimeType: string;
    duration: number;
    size: number;
  } | null;
  updatedAt: string;
}

export interface VoiceMessageInfo {
  id: string;
  messageId: string;
  audioUrl: string;
  duration: number;
  waveform?: number[];
  createdAt: string;
}

export interface GiftInfo {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  coinPrice: number;
  isAnimated: boolean;
  isLimited: boolean;
  limitedQuantity?: number;
}

export interface WalletBalance {
  userId: string;
  coins: number;
  gamePoints: number;
  updatedAt: string;
}

export interface TransactionRecord {
  id: string;
  userId: string;
  type: 'credit' | 'debit';
  amount: number;
  currency: 'coins' | 'gamePoints';
  referenceType: 'gift' | 'reward' | 'purchase' | 'game' | 'admin' | 'transfer';
  referenceId: string;
  description: string;
  balanceAfter: number;
  createdAt: string;
}

export interface VipMembershipInfo {
  id: string;
  userId: string;
  tier: 'silver' | 'gold' | 'platinum';
  startedAt: string;
  expiresAt: string;
  isActive: boolean;
  autoRenew: boolean;
}

export interface NotificationInfo {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl?: string;
  score: number;
  metric: string;
}

export interface AchievementInfo {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  category: string;
  requirement: Record<string, unknown>;
  reward?: {
    type: 'coins' | 'gamePoints' | 'vip_days' | 'gift';
    value: number;
  };
}