import type { Prisma, PrismaClient } from '@socialplay/database';
import { ApiError } from '../middleware/api-error.js';

export async function lockSocialGroup(tx: Prisma.TransactionClient, groupId: string, userId: string, writing = true) {
  const [user] = await tx.$queryRaw<{status:string}[]>`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
  if (user?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
  const [group] = await tx.$queryRaw<{id:string;name:string;status:string;expiresAt:Date;now:Date}[]>`
    SELECT id,name,status::text,"expiresAt",clock_timestamp() AS now FROM groups WHERE id=${groupId} FOR SHARE`;
  if (!group) throw ApiError.notFound('Group not found');
  const [member] = await tx.$queryRaw<{id:string;status:string;role:string;archivedAt:Date|null}[]>`
    SELECT id,status::text,role::text,"archivedAt" FROM group_members WHERE "groupId"=${groupId} AND "userId"=${userId} FOR SHARE`;
  if (member?.status !== 'ACTIVE') throw ApiError.forbidden('Join this group to view its conversation');
  if (writing && (group.status !== 'ACTIVE' || group.now >= group.expiresAt)) throw ApiError.conflict('This group has closed. Its conversation and results are read-only.');
  return {group,member};
}

export async function expireSocialGroups(db: PrismaClient) {
  // No membership/wallet locks. A started round settles
  // independently and retains every member's access to its result.
  return db.$executeRaw`UPDATE groups SET status='ARCHIVED',"updatedAt"=clock_timestamp()
    WHERE status='ACTIVE' AND "expiresAt"<=clock_timestamp()`;
}
