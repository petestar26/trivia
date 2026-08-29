import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

export type VipTier = 'SILVER' | 'GOLD' | 'PLATINUM';
export type VipStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

export interface VipSnapshot {
  userId: string;
  tier: VipTier | null;
  status: VipStatus | null;
  isActive: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
}

const TIER_RANK: Record<VipTier, number> = { SILVER: 1, GOLD: 2, PLATINUM: 3 };

/**
 * Authoritative VIP service.
 *
 * VIP status, tier, and expiry are computed server-side. The client can never
 * provide a tier, status, or expiration — these are derived from the stored
 * membership and the server clock. An expired membership automatically behaves
 * as inactive.
 */
export async function getVip(userId: string): Promise<VipSnapshot> {
  const membership = await prisma.vipMembership.findUnique({
    where: { userId },
  });

  if (!membership) {
    return {
      userId,
      tier: null,
      status: null,
      isActive: false,
      startedAt: null,
      expiresAt: null,
    };
  }

  const now = new Date();
  const expired = membership.status === 'ACTIVE' && membership.expiresAt <= now;

  return {
    userId,
    tier: membership.tier,
    status: expired ? 'EXPIRED' : membership.status,
    isActive: membership.status === 'ACTIVE' && !expired,
    startedAt: membership.startedAt,
    expiresAt: membership.expiresAt,
  };
}

/**
 * Server-side VIP activation (used by admin/fulfillment, NOT exposed to normal
 * users). Ensures a user has at most one membership and that expiry is valid.
 */
export async function activateVip(
  userId: string,
  tier: VipTier,
  durationDays: number
): Promise<VipSnapshot> {
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw ApiError.badRequest('VIP duration must be a positive integer (days)');
  }
  if (!TIER_RANK[tier]) {
    throw ApiError.badRequest('Unknown VIP tier');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await prisma.vipMembership.upsert({
    where: { userId },
    update: {
      tier,
      status: 'ACTIVE',
      startedAt: now,
      expiresAt,
    },
    create: {
      userId,
      tier,
      status: 'ACTIVE',
      startedAt: now,
      expiresAt,
    },
  });

  return getVip(userId);
}

/** Whether a user currently has an active (non-expired) VIP membership. */
export function hasVipAccess(snapshot: { isActive: boolean }): boolean {
  return snapshot.isActive;
}

export function tierRank(tier: VipTier | null): number {
  return tier ? TIER_RANK[tier] : 0;
}
