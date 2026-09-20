export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
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
  email?: string;
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
  email: string;
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

export type GroupMembershipStatus = 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED' | 'LEFT';
export type GroupRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
export type GroupStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | 'BANNED';
export type GroupInviteStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface GroupOwnerInfo {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Fields present in every GET /groups/:id response, whichever shape it takes. */
interface GroupDetailCommon {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  coverUrl: string | null;
  status: GroupStatus;
  memberCount: number;
  /** The authenticated caller's own membership status in this group, when a
   *  membership row exists (including BANNED); null when there is no row. */
  viewerMembershipStatus: GroupMembershipStatus | null;
}

/**
 * GET /groups/:id for a PRIVATE group viewed by someone who is not an ACTIVE
 * member: a deliberately thin summary. No owner identity, no dates — a fact
 * the type states by declaring those fields `never`, so reading them from the
 * union is allowed and always undefined here.
 */
export interface GroupDetailSummary extends GroupDetailCommon {
  isPrivate: true;
  isMember: false;
  memberRole: null;
  /** The caller's own join-request state (their membership status), if any. */
  requestStatus: GroupMembershipStatus | null;
  owner: null;
  createdAt?: never;
  updatedAt?: never;
}

/** GET /groups/:id for everyone else: an ACTIVE member of any group, or anyone viewing a public one. */
export interface GroupDetailFull extends GroupDetailCommon {
  isPrivate: boolean;
  isMember: boolean;
  /** The caller's role — null unless they are an ACTIVE member. Never omitted,
   *  and never the role of a membership that is not ACTIVE. */
  memberRole: GroupRole | null;
  /** Null only if the owning account no longer exists. */
  owner: GroupOwnerInfo | null;
  requestStatus?: never;
  createdAt: string;
  updatedAt: string;
}

export type GroupDetailInfo = GroupDetailSummary | GroupDetailFull;

export interface GroupMemberInfo {
  id: string;
  groupId: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  role: GroupRole;
  status: GroupMembershipStatus;
  joinedAt: string;
}

/** A live pending invite as a manager (OWNER/ADMIN) sees it. The token is
 *  bearer-equivalent and is returned to managers only. */
export interface GroupInviteInfo {
  id: string;
  email: string;
  role: GroupRole;
  status: GroupInviteStatus;
  token: string;
  expiresAt: string;
  invitedBy: string;
  createdAt: string;
}

/** POST /groups/:id/invites — the created invite, including its token. */
export interface CreatedGroupInviteInfo extends GroupInviteInfo {
  groupId: string;
}

/** GET /groups/invites/:token — the redemption page's safe summary: no email, no token. */
export interface GroupInvitePreview {
  id: string;
  group: { id: string; name: string; isPrivate: boolean };
  /** What is true NOW: a PENDING invite past its expiry reads EXPIRED. */
  status: GroupInviteStatus;
  expiresAt: string;
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

/**
 * `meta` of GET /notifications. `unreadCount` is the caller's TOTAL unread
 * count across the whole inbox — not the number of unread rows on this page —
 * so it is safe to drive a badge from any single page of the response.
 */
export interface NotificationListMeta extends PaginationMeta {
  unreadCount: number;
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

export interface UserSearchResult {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}
