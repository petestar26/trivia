import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';

/**
 * Fixtures shared by the group admission suites (invite acceptance, join
 * approval, lock order). Each suite gives its own `emailPrefix`, so cleanup only
 * ever touches the rows that suite created.
 */

export function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

/** A unique client address per request: the API's global rate limit is keyed by IP. */
export function ipAllocator(octet: number): () => string {
  let counter = 0;
  return () => `10.${octet}.${(counter >> 8) & 255}.${(counter++ & 255) || 1}`;
}

export type FixtureUserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'BANNED' | 'PENDING_VERIFICATION';

export interface FixtureUserOptions {
  status?: FixtureUserStatus;
  isVerified?: boolean;
  /** Pass null for an account with no email at all. */
  email?: string | null;
}

export async function createUser(emailPrefix: string, tag: string, opts: FixtureUserOptions = {}) {
  const suffix = uniqueSuffix();
  return prisma.user.create({
    data: {
      email: opts.email === undefined ? `${emailPrefix}${tag}-${suffix}@test.local` : opts.email,
      // Suffix FIRST: usernames are capped at 30 chars, and the longer tags would
      // otherwise have the unique part truncated away.
      username: `gf_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Admission ${tag}`.slice(0, 100),
      status: opts.status ?? 'ACTIVE',
      isVerified: opts.isVerified ?? true,
    },
  });
}

/**
 * Remove every user whose email starts with `emailPrefix` — and, for accounts
 * that have no email, every user in `extraUserIds` — with everything hanging
 * off them. A successful admission fires safeRecordActivity (GROUP_JOIN)
 * without awaiting it, so reward/achievement/wallet rows may still be arriving
 * while teardown runs: repeat the whole block until it stops colliding with
 * those late writes, then drop the users.
 */
export async function cleanFixtures(emailPrefix: string, extraUserIds: () => string[] = () => []): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const byEmail = await prisma.user.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } });
    const extra = extraUserIds();
    const users = await prisma.user.findMany({
      where: { id: { in: [...byEmail.map((u) => u.id), ...extra] } },
      select: { id: true },
    });
    if (!users.length) return;
    const userIds = users.map((u) => u.id);

    const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
    }
    await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userAchievement.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTask.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userXpEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userProgress.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dailyStreak.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.vipMembership.deleteMany({ where: { userId: { in: userIds } } });

    const wallets = await prisma.wallet.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const walletIds = wallets.map((w) => w.id);
    if (walletIds.length) {
      for (let i = 0; i < 10; i++) {
        await prisma.walletTransaction.deleteMany({ where: { walletId: { in: walletIds } } });
        try {
          await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }

    try {
      const res = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (res.count === users.length) return;
    } catch {
      // A late async reward write still references these users; wait and retry.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A membership row exactly as stored, plus xmin — which changes on ANY write to the row. */
export async function membershipSnapshot(groupId: string, userId: string) {
  const rows = await prisma.$queryRaw<
    { id: string; status: string; role: string; updatedAt: Date; xmin: string }[]
  >`
    SELECT id, status::text AS status, role::text AS role, "updatedAt", xmin::text AS xmin
    FROM group_members
    WHERE "groupId" = ${groupId} AND "userId" = ${userId}
  `;
  return rows[0] ?? null;
}

/** An invite row exactly as stored, plus xmin. */
export async function inviteSnapshot(inviteId: string) {
  const rows = await prisma.$queryRaw<
    { id: string; status: string; acceptedBy: string | null; updatedAt: Date; xmin: string }[]
  >`
    SELECT id, status::text AS status, "acceptedBy", "updatedAt", xmin::text AS xmin
    FROM group_invites
    WHERE id = ${inviteId}
  `;
  return rows[0] ?? null;
}
