import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, type Prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';
import { ErrorCode } from '@socialplay/shared';
import { safeRecordActivity } from '../rewards/activity-service';

type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
type GroupMemberStatus = 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED' | 'LEFT';

const MANAGER_ROLES: GroupMemberRole[] = ['OWNER', 'ADMIN'];

function hasRole(role: GroupMemberRole, allowed: GroupMemberRole[]): boolean {
  return allowed.includes(role);
}

async function getGroupOrThrow(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
  });

  if (!group) {
    throw ApiError.notFound('Group not found');
  }

  return group;
}

async function getGroupMembership(groupId: string, userId: string) {
  return prisma.groupMember.findUnique({
    where: {
      groupId_userId: {
        groupId,
        userId,
      },
    },
  });
}

async function assertManager(
  groupId: string,
  userId: string,
  allowedRoles: GroupMemberRole[] = MANAGER_ROLES
): Promise<GroupMemberRole> {
  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }

  const role = membership.role as GroupMemberRole;

  if (!hasRole(role, allowedRoles)) {
    throw ApiError.forbidden('Insufficient permissions');
  }

  return role;
}

export async function groupRoutes(server: FastifyInstance): Promise<void> {
  // Create group
  server.post<{ Body: { name: string; description?: string; isPrivate?: boolean; imageUrl?: string; coverUrl?: string } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
            isPrivate: { type: 'boolean' },
            imageUrl: { type: 'string', format: 'uri' },
            coverUrl: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, description, isPrivate, imageUrl, coverUrl } = request.body;

      const group = await prisma.$transaction(async (tx) => {
        const createdGroup = await tx.group.create({
          data: {
            ownerId: request.user!.sub,
            name,
            description,
            isPrivate: isPrivate ?? false,
            imageUrl,
            coverUrl,
          },
          select: {
            id: true,
            ownerId: true,
            name: true,
            description: true,
            imageUrl: true,
            coverUrl: true,
            isPrivate: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        await tx.groupMember.create({
          data: {
            groupId: createdGroup.id,
            userId: request.user!.sub,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        });

        return createdGroup;
      });

      reply.status(201).send({
        success: true,
        data: group,
      });
    }
  );

  // Get group
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const group = await getGroupOrThrow(request.params.id);

      if (group.status === 'BANNED') {
        throw ApiError.forbidden('Group is banned');
      }

      const membership = await getGroupMembership(group.id, request.user!.sub);
      const isActiveMember = !!membership && membership.status === 'ACTIVE';

      // Private groups are reachable by non-members via a safe summary only:
      // name/description/count/public metadata and the caller's own request
      // status — never the member list, invites, or owner identity.
      if (group.isPrivate && !isActiveMember) {
        const memberCount = await prisma.groupMember.count({
          where: { groupId: group.id, status: 'ACTIVE' },
        });
        return {
          success: true,
          data: {
            id: group.id,
            name: group.name,
            description: group.description,
            imageUrl: group.imageUrl,
            coverUrl: group.coverUrl,
            isPrivate: true,
            status: group.status,
            memberCount,
            isMember: false,
            memberRole: null,
            viewerMembershipStatus: membership?.status ?? null,
            requestStatus: membership?.status ?? null,
            owner: null,
          },
        };
      }

      const memberCount = await prisma.groupMember.count({
        where: { groupId: group.id, status: 'ACTIVE' },
      });

      const owner = await prisma.user.findUnique({
        where: { id: group.ownerId },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      });

      return {
        success: true,
        data: {
          id: group.id,
          name: group.name,
          description: group.description,
          imageUrl: group.imageUrl,
          coverUrl: group.coverUrl,
          isPrivate: group.isPrivate,
          status: group.status,
          memberCount,
          isMember: !!membership && membership.status === 'ACTIVE',
          memberRole: membership?.role,
          viewerMembershipStatus: membership?.status ?? null,
          owner,
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        },
      };
    }
  );

  // Update group
  server.put<{
    Params: { id: string };
    Body: { name?: string; description?: string; isPrivate?: boolean; imageUrl?: string; coverUrl?: string };
  }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
            isPrivate: { type: 'boolean' },
            imageUrl: { type: 'string', format: 'uri' },
            coverUrl: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    async (request) => {
      const group = await getGroupOrThrow(request.params.id);
      await assertManager(group.id, request.user!.sub, ['OWNER']);

      const data: Record<string, unknown> = {};
      if (request.body.name !== undefined) data.name = request.body.name;
      if (request.body.description !== undefined) data.description = request.body.description;
      if (request.body.isPrivate !== undefined) data.isPrivate = request.body.isPrivate;
      if (request.body.imageUrl !== undefined) data.imageUrl = request.body.imageUrl;
      if (request.body.coverUrl !== undefined) data.coverUrl = request.body.coverUrl;

      const updated = await prisma.group.update({
        where: { id: group.id },
        data,
        select: {
          id: true,
          ownerId: true,
          name: true,
          description: true,
          imageUrl: true,
          coverUrl: true,
          isPrivate: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return {
        success: true,
        data: updated,
      };
    }
  );

  // Delete group
  server.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const group = await getGroupOrThrow(request.params.id);
      await assertManager(group.id, request.user!.sub, ['OWNER']);

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.deleteMany({ where: { groupId: group.id } });
        await tx.group.delete({ where: { id: group.id } });
      });

      return {
        success: true,
        data: { message: 'Group deleted' },
      };
    }
  );

  // List/discover groups — also serves as the "My Groups" query when
  // `mine=true` is passed (see below), rather than splitting that into a
  // separate endpoint: both modes share the same pagination/response
  // contract and the same per-group membership lookup, so a second route
  // would just duplicate this one with a different `where`.
  server.get<{ Querystring: { page?: number; limit?: number; query?: string; mine?: boolean } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            query: { type: 'string', maxLength: 100 },
            mine: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const q = request.query.query?.trim();
      const mine = request.query.mine ?? false;
      const userId = request.user!.sub;

      // `mine: true` narrows to ACTIVE groups where the caller has an
      // ACTIVE membership — a `some` relation filter applied at the
      // database level, so it composes with `orderBy`/`skip`/`take`/
      // `count` below rather than filtering a page after the fact (which
      // would both mis-paginate and let an older membership fall outside
      // the page before it was ever checked). Private groups are included
      // here precisely because membership is what's being required, not
      // `isPrivate: false` — a private group the caller has actually
      // joined is exactly what "My Groups" means to show. PENDING/LEFT/
      // BANNED/MUTED memberships, another user's membership, and a
      // missing membership row all fail `some`, so none of those groups
      // match.
      const where: Prisma.GroupWhereInput = {
        status: 'ACTIVE',
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
        ...(mine ? { members: { some: { userId, status: 'ACTIVE' } } } : {}),
      };

      const [groups, total] = await Promise.all([
        prisma.group.findMany({
          where,
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
              },
            },
            _count: {
              select: {
                members: {
                  where: { status: 'ACTIVE' },
                },
              },
            },
            // The caller's own ACTIVE membership row (if any) is selected
            // inside this main group query instead of being looked up per
            // group afterwards via `getGroupMembership` (a
            // `groupMember.findUnique` delegate call for every returned
            // row). That keeps membership selection in the group query and
            // removes the per-item delegate lookups from the request path.
            // Prisma may batch same-tick `findUnique` calls into a single
            // extra query, so the old pattern did not necessarily cost one
            // SQL statement per group — but it was still an additional
            // lookup that this include avoids.
            //
            // Filtering to `status: 'ACTIVE'` also guarantees `memberRole` is
            // never a stale role from an inactive membership: PENDING/LEFT/
            // BANNED/MUTED rows are not returned, so `isMember` is false and
            // `memberRole` is omitted. `userId` is unique per group (see the
            // `@@unique([groupId, userId])` constraint), so this returns at
            // most one row.
            members: {
              where: { userId, status: 'ACTIVE' },
              select: { role: true, status: true },
            },
          },
          // Deterministic: `createdAt` alone can tie (two groups created
          // in the same millisecond), which would make skip/take page
          // boundaries — and therefore which groups land on which page —
          // depend on whatever arbitrary order the database happens to
          // return ties in. `id` is unique, so appending it as a
          // tie-breaker makes the order, and so the pages, reproducible.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.group.count({ where }),
      ]);

      const data = groups.map((g) => {
        const membership = g.members[0];
        return {
          id: g.id,
          name: g.name,
          description: g.description,
          imageUrl: g.imageUrl,
          coverUrl: g.coverUrl,
          isPrivate: g.isPrivate,
          status: g.status,
          memberCount: g._count.members,
          // The included membership is already restricted to status ACTIVE,
          // so a present row means the caller is an active member; an
          // inactive (or absent) membership produces `isMember: false` and
          // no `memberRole` at all.
          isMember: !!membership,
          memberRole: membership?.role,
          // Only expose the owner to active members — consistent with the
          // private-group safe summary which returns owner: null for non-members.
          owner: membership ? g.owner : null,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        };
      });

      const totalPages = Math.ceil(total / limit);

      return {
        success: true,
        data,
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      };
    }
  );

  // Join group
  server.post<{ Params: { id: string } }>(
    '/:id/join',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const userId = request.user!.sub;

      const group = await getGroupOrThrow(groupId);

      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }

      if (group.isPrivate) {
        throw ApiError.badRequest('Group is private; you cannot join directly');
      }

      const existing = await getGroupMembership(groupId, userId);

      if (existing) {
        if (existing.status === 'ACTIVE') {
          throw ApiError.conflict('You are already a member of this group');
        }
        if (existing.status === 'BANNED') {
          throw ApiError.forbidden('You are banned from this group');
        }
        if (existing.status === 'PENDING') {
          throw ApiError.conflict('Your membership is pending approval');
        }
        if (existing.status === 'LEFT') {
          await prisma.groupMember.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE' },
          });

          // Server-verified activity: first-group achievement (post-commit).
          safeRecordActivity(userId, { type: 'GROUP_JOIN' });

          return {
            success: true,
            data: { message: 'You have rejoined the group' },
          };
        }
      }

      await prisma.groupMember.create({
        data: {
          groupId,
          userId,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });

      // Server-verified activity: first-group achievement (post-commit).
      safeRecordActivity(userId, { type: 'GROUP_JOIN' });

      return {
        success: true,
        data: { message: 'Joined group successfully' },
      };
    }
  );

  // Leave group
  server.post<{ Params: { id: string } }>(
    '/:id/leave',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const userId = request.user!.sub;

      await getGroupOrThrow(groupId);

      const membership = await getGroupMembership(groupId, userId);

      if (!membership) {
        throw ApiError.notFound('You are not a member of this group');
      }

      if (membership.role === 'OWNER') {
        throw ApiError.badRequest('The owner cannot leave the group. Transfer ownership or delete the group instead.');
      }

      if (membership.status === 'LEFT') {
        throw ApiError.conflict('You have already left this group');
      }

      if (membership.status === 'BANNED') {
        throw ApiError.forbidden('You are banned from this group');
      }

      // Same atomicity requirement as remove/role-change: a concurrent
      // ownership transfer can promote this member to OWNER between the
      // checks above and this write, and marking the new owner LEFT would
      // strand the group with no active owner. The status guard mirrors the
      // LEFT/BANNED pre-checks so their outcomes are unchanged.
      const left = await prisma.groupMember.updateMany({
        where: {
          id: membership.id,
          role: { not: 'OWNER' },
          status: { notIn: ['LEFT', 'BANNED'] },
        },
        data: { status: 'LEFT' },
      });

      if (left.count === 0) {
        const current = await prisma.groupMember.findUnique({
          where: { id: membership.id },
          select: { role: true, status: true },
        });
        if (!current) {
          throw ApiError.notFound('You are not a member of this group');
        }
        if (current.role === 'OWNER') {
          throw ApiError.badRequest(
            'The owner cannot leave the group. Transfer ownership or delete the group instead.'
          );
        }
        if (current.status === 'BANNED') {
          throw ApiError.forbidden('You are banned from this group');
        }
        throw ApiError.conflict('You have already left this group');
      }

      return {
        success: true,
        data: { message: 'Left group successfully' },
      };
    }
  );

  // Get group members
  server.get<{ Params: { id: string } }>(
    '/:id/members',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;

      await getGroupOrThrow(groupId);

      const membership = await getGroupMembership(groupId, request.user!.sub);
      if (!membership || membership.status !== 'ACTIVE') {
        throw ApiError.forbidden('You are not a member of this group');
      }

      const members = await prisma.groupMember.findMany({
        where: { groupId, status: 'ACTIVE' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { joinedAt: 'asc' },
      });

      return {
        success: true,
        data: members.map((m) => ({
          id: m.id,
          groupId: m.groupId,
          user: m.user,
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt,
        })),
      };
    }
  );

  // Remove member
  server.delete<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const targetUserId = request.params.userId;
      const actorUserId = request.user!.sub;

      await getGroupOrThrow(groupId);
      await assertManager(groupId, actorUserId);

      if (targetUserId === actorUserId) {
        throw ApiError.badRequest('You cannot remove yourself. Use leave instead.');
      }

      const target = await getGroupMembership(groupId, targetUserId);

      if (!target) {
        throw ApiError.notFound('User is not a member of this group');
      }

      if (target.role === 'OWNER') {
        throw ApiError.forbidden('You cannot remove the owner of the group');
      }

      // `role: { not: 'OWNER' }` makes the owner check atomic with the
      // delete. The pre-check above is only a fast path: a concurrent
      // ownership transfer can promote this same row to OWNER in between,
      // and an unguarded delete would then remove the group's owner, leaving
      // group.ownerId pointing at a membership that no longer exists — a
      // state no route can repair.
      const removed = await prisma.groupMember.deleteMany({
        where: { id: target.id, role: { not: 'OWNER' } },
      });

      if (removed.count === 0) {
        // Zero rows means the row either vanished (concurrent leave/remove)
        // or became OWNER (concurrent transfer). Re-read to answer with the
        // same status the pre-checks above would have produced.
        const current = await prisma.groupMember.findUnique({
          where: { id: target.id },
          select: { role: true },
        });
        if (!current) {
          throw ApiError.notFound('User is not a member of this group');
        }
        throw ApiError.forbidden('You cannot remove the owner of the group');
      }

      return {
        success: true,
        data: { message: 'Member removed' },
      };
    }
  );

  // Ban member (OWNER/ADMIN) — atomically revokes the user's PENDING invites
  // so a banned user can no longer redeem them.
  server.post<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId/ban',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const targetUserId = request.params.userId;
      const actorUserId = request.user!.sub;

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      await assertManager(groupId, actorUserId);

      if (targetUserId === actorUserId) {
        throw ApiError.badRequest('You cannot ban yourself');
      }

      const target = await getGroupMembership(groupId, targetUserId);
      if (!target) {
        throw ApiError.notFound('User is not a member of this group');
      }
      if (target.role === 'OWNER') {
        throw ApiError.forbidden('You cannot ban the owner of the group');
      }

      const alreadyBanned = await prisma.$transaction(async (tx) => {
        // Atomic transition — guards against two distinct races:
        //
        // 1. A concurrent duplicate ban (two managers, or a retried
        //    request): another request already moved this row to BANNED,
        //    so this call is treated as an idempotent no-op.
        // 2. A concurrent ownership transfer promoting this same target to
        //    OWNER between the pre-transaction check above and this write.
        //    `role: { not: 'OWNER' }` keeps that promotion and this ban
        //    mutually exclusive at the database level — whichever request's
        //    write lands first wins, and the loser's `updateMany` affects
        //    zero rows instead of leaving role=OWNER, status=BANNED, which
        //    would permanently strand the group (no route can un-ban an
        //    OWNER or transfer ownership away from a BANNED one).
        //
        // If `count` is 0, re-read inside the transaction to tell those two
        // cases apart: only the first is a legitimate idempotent replay.
        const banned = await tx.groupMember.updateMany({
          where: { id: target.id, status: { not: 'BANNED' }, role: { not: 'OWNER' } },
          data: { status: 'BANNED' },
        });
        if (banned.count === 0) {
          const current = await tx.groupMember.findUnique({
            where: { id: target.id },
            select: { role: true },
          });
          if (current?.role === 'OWNER') {
            // A concurrent transfer won the race — this is not a replay,
            // it's the same "cannot ban the owner" rejection the early
            // check above would have given if it had run a moment later.
            throw ApiError.forbidden('You cannot ban the owner of the group');
          }
          return true;
        }

        const user = await tx.user.findUnique({
          where: { id: targetUserId },
          select: { email: true },
        });
        if (user?.email) {
          await tx.groupInvite.updateMany({
            where: { groupId, email: user.email.toLowerCase(), status: 'PENDING' },
            data: { status: 'REVOKED' },
          });
        }

        await tx.notification.create({
          data: {
            userId: targetUserId,
            type: 'MODERATION',
            title: 'Banned from group',
            body: `You have been banned from "${group.name}"`,
            data: { groupId, bannedBy: actorUserId },
          },
        });

        return false;
      });

      return {
        success: true,
        data: { message: alreadyBanned ? 'Member already banned' : 'Member banned' },
      };
    }
  );

  // Change member role
  server.patch<{
    Params: { id: string; userId: string };
    Body: { role: string };
  }>(
    '/:id/members/:userId/role',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['role'],
          properties: {
            role: { type: 'string', enum: ['ADMIN', 'MODERATOR', 'MEMBER'] },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const targetUserId = request.params.userId;
      const actorUserId = request.user!.sub;
      const newRole = request.body.role as GroupMemberRole;

      await getGroupOrThrow(groupId);
      await assertManager(groupId, actorUserId);

      const actorMembership = await getGroupMembership(groupId, actorUserId);
      if (!actorMembership) {
        throw ApiError.forbidden('You are not a member of this group');
      }

      const target = await getGroupMembership(groupId, targetUserId);

      if (!target) {
        throw ApiError.notFound('User is not a member of this group');
      }

      const actorRole = actorMembership.role as GroupMemberRole;

      if (target.role === 'OWNER') {
        throw ApiError.forbidden('You cannot change the role of the owner');
      }

      if (newRole === 'OWNER') {
        throw ApiError.badRequest('You cannot assign the owner role');
      }

      if (actorRole === 'ADMIN' && newRole === 'ADMIN') {
        throw ApiError.forbidden('Only the owner can assign admin roles');
      }

      // `role: { not: 'OWNER' }` makes the owner check atomic with the
      // write, so a concurrent ownership transfer cannot slip a promotion
      // in between the pre-check and this update and have the new owner
      // silently demoted to MEMBER/MODERATOR/ADMIN.
      const updated = await prisma.groupMember.updateMany({
        where: { id: target.id, role: { not: 'OWNER' } },
        data: { role: newRole },
      });

      if (updated.count === 0) {
        const current = await prisma.groupMember.findUnique({
          where: { id: target.id },
          select: { role: true },
        });
        if (!current) {
          throw ApiError.notFound('User is not a member of this group');
        }
        throw ApiError.forbidden('You cannot change the role of the owner');
      }

      return {
        success: true,
        data: { message: 'Member role updated' },
      };
    }
  );

  // ─── Invitation Lifecycle ────────────────────────────────────

  // Create invite (OWNER/ADMIN, private groups only)
  server.post<{ Params: { id: string }; Body: { email: string; role?: string } }>(
    '/:id/invites',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 255 },
            role: { type: 'string', enum: ['ADMIN', 'MODERATOR', 'MEMBER'] },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const { email, role: rawRole } = request.body;
      const role = (rawRole ?? 'MEMBER') as GroupMemberRole;

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      if (!group.isPrivate) {
        throw ApiError.badRequest('Invites are only available for private groups');
      }
      const actorRole = await assertManager(groupId, request.user!.sub);

      // An invitation grants its role on acceptance, so it must obey the
      // same ceiling as a direct role change: only the OWNER may hand out
      // ADMIN. Without this, an ADMIN could mint an ADMIN invite and
      // escalate a peer past what PATCH /members/:userId/role allows.
      if (actorRole === 'ADMIN' && role === 'ADMIN') {
        throw ApiError.forbidden('Only the owner can assign admin roles');
      }

      const normalizedEmail = email.toLowerCase();

      // Block if the target is already an active member (case-insensitive).
      const existingUser = await prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });
      if (existingUser) {
        const existingMember = await getGroupMembership(groupId, existingUser.id);
        if (existingMember && existingMember.status === 'ACTIVE') {
          throw ApiError.conflict('User is already a member of this group');
        }
        if (existingMember && existingMember.status === 'BANNED') {
          throw ApiError.forbidden('User is banned from this group');
        }
      }

      const existingInvite = await prisma.groupInvite.findFirst({
        where: { groupId, email: normalizedEmail, status: 'PENDING' },
      });
      if (existingInvite) {
        throw ApiError.conflict('An active invite already exists for this email');
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Membership eligibility and the invite create are one transaction so a
      // ban landing between the pre-read and the insert cannot slip an invite
      // in for a banned recipient. The unique-invite conflict is also handled
      // here rather than relying on a later duplicate check.
      let invite:
        | {
            id: string;
            groupId: string;
            email: string;
            role: string;
            status: string;
            token: string;
            expiresAt: Date;
            invitedBy: string;
            createdAt: Date;
          }
        | null = null;
      try {
        await prisma.$transaction(async (tx) => {
          if (existingUser) {
            const current = await tx.groupMember.findUnique({
              where: { groupId_userId: { groupId, userId: existingUser.id } },
              select: { status: true },
            });
            if (current?.status === 'ACTIVE') {
              throw ApiError.conflict('User is already a member of this group');
            }
            if (current?.status === 'BANNED') {
              throw ApiError.forbidden('User is banned from this group');
            }
          }

          invite = await tx.groupInvite.create({
            data: {
              groupId,
              email: normalizedEmail,
              role,
              token,
              expiresAt,
              invitedBy: request.user!.sub,
            },
            select: {
              id: true,
              groupId: true,
              email: true,
              role: true,
              status: true,
              token: true,
              expiresAt: true,
              invitedBy: true,
              createdAt: true,
            },
          });

          if (existingUser) {
            await tx.notification.create({
              data: {
                userId: existingUser.id,
                type: 'GROUP_INVITE',
                title: 'Group invitation',
                body: `You have been invited to join "${group.name}"`,
                data: { groupId, inviteId: invite.id, groupName: group.name, invitedBy: request.user!.sub },
              },
            });
          }
        });
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const prismaErr = err as { code?: string; meta?: { target?: unknown } };
          if (prismaErr.code === 'P2002' && Array.isArray(prismaErr.meta?.target) && prismaErr.meta!.target!.includes('email')) {
            throw ApiError.conflict('An active invite already exists for this email');
          }
        }
        throw err;
      }

      return { success: true, data: invite };
    }
  );

  // List active invites (OWNER/ADMIN)
  server.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    '/:id/invites',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      await getGroupOrThrow(groupId);
      await assertManager(groupId, request.user!.sub);

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;

      const [invites, total] = await Promise.all([
        prisma.groupInvite.findMany({
          where: { groupId, status: 'PENDING' },
          include: {
            group: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.groupInvite.count({ where: { groupId, status: 'PENDING' } }),
      ]);

      return {
        success: true,
        data: invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          status: i.status,
          token: i.token,
          expiresAt: i.expiresAt,
          invitedBy: i.invitedBy,
          createdAt: i.createdAt,
        })),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page < Math.ceil(total / limit),
          hasPrevPage: page > 1,
        },
      };
    }
  );

  // Revoke invite (OWNER/ADMIN)
  server.delete<{ Params: { id: string; inviteId: string } }>(
    '/:id/invites/:inviteId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'inviteId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            inviteId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const { inviteId } = request.params;

      await getGroupOrThrow(groupId);
      await assertManager(groupId, request.user!.sub);

      const invite = await prisma.groupInvite.findFirst({
        where: { id: inviteId, groupId },
      });
      if (!invite) {
        throw ApiError.notFound('Invite not found');
      }
      if (invite.status !== 'PENDING') {
        throw ApiError.badRequest('Invite is not active');
      }

      await prisma.groupInvite.update({
        where: { id: inviteId },
        data: { status: 'REVOKED' },
      });

      return { success: true, data: { message: 'Invite revoked' } };
    }
  );

  // Resolve an invite by token (safe summary for the redemption page).
  // No email, no token in the response — only group identity, expiry, and state.
  server.get<{ Params: { token: string } }>(
    '/invites/:token',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const { token } = request.params;
      const invite = await prisma.groupInvite.findUnique({
        where: { token },
        include: { group: { select: { id: true, name: true, isPrivate: true } } },
      });
      if (!invite) {
        throw ApiError.notFound('Invalid invite token');
      }

      return {
        success: true,
        data: {
          id: invite.id,
          group: invite.group,
          status: invite.status,
          expiresAt: invite.expiresAt,
        },
      };
    }
  );

  // Accept invite (any authenticated user with verified email matching invite)
  server.post<{ Body: { token: string } }>(
    '/accept-invite',
    {
      preHandler: [authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.sub;
      const { token } = request.body;

      const invite = await prisma.groupInvite.findUnique({ where: { token } });
      if (!invite) {
        throw ApiError.notFound('Invalid invite token');
      }
      if (invite.status === 'ACCEPTED') {
        throw ApiError.conflict('This invite has already been accepted');
      }
      if (invite.status === 'REVOKED') {
        throw ApiError.conflict('This invite has been revoked');
      }
      if (invite.expiresAt < new Date()) {
        await prisma.groupInvite.updateMany({
          where: { id: invite.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        throw ApiError.badRequest('This invite has expired');
      }

      const caller = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, isVerified: true, status: true },
      });
      if (!caller || !caller.email || !caller.isVerified) {
        throw ApiError.forbidden('You must have a verified email to accept invites');
      }
      if (caller.status === 'BANNED') {
        throw ApiError.forbidden('You are banned from this group');
      }
      if (caller.status === 'SUSPENDED' || caller.status === 'INACTIVE') {
        throw ApiError.forbidden('Your account is not eligible to accept invitations');
      }
      if (caller.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw ApiError.forbidden('This invite is not for your email address');
      }

      const result = await prisma.$transaction(async (tx) => {
        const group = await tx.group.findUnique({ where: { id: invite.groupId } });
        if (!group || group.status !== 'ACTIVE') {
          throw ApiError.badRequest('Group is not active');
        }

        const existingMember = await tx.groupMember.findUnique({
          where: { groupId_userId: { groupId: invite.groupId, userId } },
        });
        if (existingMember && existingMember.status === 'ACTIVE') {
          throw ApiError.conflict('You are already a member of this group');
        }
        if (existingMember && existingMember.status === 'BANNED') {
          throw ApiError.forbidden('You are banned from this group');
        }

        const claimed = await tx.groupInvite.updateMany({
          where: { id: invite.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', acceptedBy: userId },
        });
        if (claimed.count === 0) {
          throw ApiError.conflict('This invite has already been accepted');
        }

        if (existingMember) {
          // Atomic conditional transition — prevents a stale acceptance from
          // overwriting a concurrently promoted OWNER, approved ACTIVE member,
          // or newly BANNED user. Only LEFT, MUTED, or PENDING rows are
          // eligible. If zero rows are affected, the membership was promoted
          // or restricted between the pre-transaction read and this write.
          const updated = await tx.groupMember.updateMany({
            where: {
              id: existingMember.id,
              status: { in: ['LEFT', 'MUTED', 'PENDING'] },
              role: { not: 'OWNER' },
            },
            data: { role: invite.role as GroupMemberRole, status: 'ACTIVE' },
          });
          if (updated.count === 0) {
            // Re-read inside the transaction to produce a specific error.
            const current = await tx.groupMember.findUnique({
              where: { id: existingMember.id },
              select: { status: true, role: true },
            });
            if (current?.status === 'ACTIVE') {
              throw ApiError.conflict('You are already a member of this group');
            }
            if (current?.role === 'OWNER') {
              throw ApiError.forbidden('Your membership status has changed and this invite is no longer valid');
            }
            if (current?.status === 'BANNED') {
              throw ApiError.forbidden('You are banned from this group');
            }
            throw ApiError.conflict('Your membership status has changed since this invite was sent');
          }
        } else {
          await tx.groupMember.create({
            data: {
              groupId: invite.groupId,
              userId,
              role: invite.role as GroupMemberRole,
              status: 'ACTIVE',
            },
          });
        }

        const acceptor = await tx.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true },
        });
        await tx.notification.create({
          data: {
            userId: invite.invitedBy,
            type: 'GROUP_INVITE_ACCEPTED',
            title: 'Invite accepted',
            body: `${acceptor?.displayName || acceptor?.username || 'A user'} accepted your invitation to "${group.name}"`,
            data: { groupId: invite.groupId, inviteId: invite.id, acceptedBy: userId },
          },
        });

        return { groupId: invite.groupId };
      });

      safeRecordActivity(userId, { type: 'GROUP_JOIN' });

      return { success: true, data: { message: 'Invite accepted', ...result } };
    }
  );

  // ─── Join Request Flow (Private Groups) ─────────────────────

  // Request membership (any authenticated user, private groups only)
  server.post<{ Params: { id: string } }>(
    '/:id/request',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const userId = request.user!.sub;

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      if (!group.isPrivate) {
        throw ApiError.badRequest('Public groups can be joined directly; use POST /join');
      }

      const existing = await getGroupMembership(groupId, userId);

      if (existing) {
        if (existing.status === 'ACTIVE') {
          throw ApiError.conflict('You are already a member of this group');
        }
        if (existing.status === 'PENDING') {
          throw ApiError.conflict('Your membership request is already pending');
        }
        if (existing.status === 'BANNED') {
          throw ApiError.forbidden('You are banned from this group');
        }
      }

      await prisma.$transaction(async (tx) => {
        if (existing) {
          // Atomic conditional transition — only LEFT memberships are eligible.
          // Prevents overwriting a concurrently approved/promoted OWNER, an
          // ACTIVE member, a BANNED user, or a still-PENDING request.
          const updated = await tx.groupMember.updateMany({
            where: {
              id: existing.id,
              status: 'LEFT',
              role: { not: 'OWNER' },
            },
            data: { status: 'PENDING', role: 'MEMBER' },
          });
          if (updated.count === 0) {
            // Re-read inside the transaction for a specific rejection.
            const current = await tx.groupMember.findUnique({
              where: { id: existing.id },
              select: { status: true, role: true },
            });
            if (current?.status === 'ACTIVE') {
              throw ApiError.conflict('You are already a member of this group');
            }
            if (current?.status === 'PENDING') {
              throw ApiError.conflict('Your membership request is already pending');
            }
            if (current?.status === 'BANNED') {
              throw ApiError.forbidden('You are banned from this group');
            }
            if (current?.role === 'OWNER') {
              throw ApiError.conflict('Your membership status cannot be changed');
            }
            throw ApiError.conflict('Your membership status has changed since this request was initiated');
          }
        } else {
          await tx.groupMember.create({
            data: { groupId, userId, role: 'MEMBER', status: 'PENDING' },
          });
        }

        // Notify all managers (OWNER/ADMIN).
        const managers = await tx.groupMember.findMany({
          where: { groupId, role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE' },
        });
        const requester = await tx.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true },
        });

        const notifications = managers.map((m) => ({
          userId: m.userId,
          type: 'GROUP_JOIN_REQUEST' as const,
          title: 'Join request',
          body: `${requester?.displayName || requester?.username || 'A user'} requests to join "${group.name}"`,
          data: { groupId, requesterId: userId },
        }));
        await tx.notification.createMany({ data: notifications });
      });

      return { success: true, data: { message: 'Join request submitted' } };
    }
  );

  // Approve join request (OWNER/ADMIN)
  server.post<{ Params: { id: string; userId: string } }>(
    '/:id/requests/:userId/approve',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const targetUserId = request.params.userId;

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      await assertManager(groupId, request.user!.sub);

      const target = await getGroupMembership(groupId, targetUserId);
      if (!target) {
        throw ApiError.notFound('Join request not found');
      }
      if (target.status !== 'PENDING') {
        throw ApiError.badRequest('This request is not pending');
      }

      await prisma.$transaction(async (tx) => {
        // Atomic transition — prevents two managers racing to approve the same
        // pending request from double-processing it.
        const transitioned = await tx.groupMember.updateMany({
          where: { id: target.id, status: 'PENDING' },
          data: { status: 'ACTIVE' },
        });
        if (transitioned.count === 0) {
          throw ApiError.badRequest('This request is not pending');
        }

        await tx.notification.create({
          data: {
            userId: targetUserId,
            type: 'GROUP_APPROVED',
            title: 'Request approved',
            body: `Your request to join the group has been approved`,
            data: { groupId, approvedBy: request.user!.sub },
          },
        });
      });

      safeRecordActivity(targetUserId, { type: 'GROUP_JOIN' });

      return { success: true, data: { message: 'Request approved' } };
    }
  );

  // Reject join request (OWNER/ADMIN)
  server.post<{ Params: { id: string; userId: string } }>(
    '/:id/requests/:userId/reject',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'userId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const targetUserId = request.params.userId;

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      await assertManager(groupId, request.user!.sub);

      const target = await getGroupMembership(groupId, targetUserId);
      if (!target) {
        throw ApiError.notFound('Join request not found');
      }
      if (target.status !== 'PENDING') {
        throw ApiError.badRequest('This request is not pending');
      }

      await prisma.$transaction(async (tx) => {
        // Atomic transition — guards against an approve racing the reject (or
        // two managers rejecting the same request) so only one PENDING row is
        // removed.
        const removed = await tx.groupMember.deleteMany({
          where: { id: target.id, status: 'PENDING' },
        });
        if (removed.count === 0) {
          throw ApiError.badRequest('This request is not pending');
        }

        await tx.notification.create({
          data: {
            userId: targetUserId,
            type: 'GROUP_REJECTED',
            title: 'Request rejected',
            body: `Your request to join the group has been rejected`,
            data: { groupId, rejectedBy: request.user!.sub },
          },
        });
      });

      return { success: true, data: { message: 'Request rejected' } };
    }
  );

  // List pending join requests (OWNER/ADMIN only)
  server.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    '/:id/requests',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      await assertManager(groupId, request.user!.sub);

      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;

      const [requests, total] = await Promise.all([
        prisma.groupMember.findMany({
          where: { groupId, status: 'PENDING' },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: { joinedAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.groupMember.count({ where: { groupId, status: 'PENDING' } }),
      ]);

      return {
        success: true,
        data: requests.map((m) => ({
          id: m.id,
          groupId: m.groupId,
          user: m.user,
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt,
        })),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page < Math.ceil(total / limit),
          hasPrevPage: page > 1,
        },
      };
    }
  );

  // ─── Ownership Transfer ──────────────────────────────────────

  server.post<{ Params: { id: string }; Body: { targetUserId: string } }>(
    '/:id/transfer',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['targetUserId'],
          properties: { targetUserId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const { targetUserId } = request.body;
      const actorUserId = request.user!.sub;

      if (targetUserId === actorUserId) {
        throw ApiError.badRequest('You cannot transfer ownership to yourself');
      }

      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }

      // OWNER only.
      const actorMembership = await getGroupMembership(groupId, actorUserId);
      if (!actorMembership || actorMembership.status !== 'ACTIVE' || actorMembership.role !== 'OWNER') {
        throw ApiError.forbidden('Only the owner can transfer ownership');
      }

      // Target must be an ACTIVE member at read time; the in-transaction
      // updateMany below re-verifies ACTIVE so a concurrent leave/removal
      // turns into a 409 instead of promoting a stale membership row.
      const targetMembership = await getGroupMembership(groupId, targetUserId);
      if (!targetMembership || targetMembership.status !== 'ACTIVE') {
        throw ApiError.badRequest('Target user must be an active member');
      }

      // Atomic ownership transfer: use a single transaction with the
      // ownerId check preventing concurrent conflicting transfers.

      const result = await prisma.$transaction(async (tx) => {
        // Optimistic lock: verify ownerId hasn't changed since we read it.
        const updatedGroup = await tx.group.updateMany({
          where: { id: groupId, ownerId: actorUserId },
          data: { ownerId: targetUserId },
        });
        if (updatedGroup.count === 0) {
          throw ApiError.conflict('Concurrent ownership change detected; please retry');
        }

        // Demote old owner to ADMIN.
        await tx.groupMember.update({
          where: { id: actorMembership.id },
          data: { role: 'ADMIN' },
        });

        // Promote new owner — requiring ACTIVE status so a target that was
        // banned/removed/left between the read and this write fails atomically.
        const promoted = await tx.groupMember.updateMany({
          where: { id: targetMembership.id, status: 'ACTIVE' },
          data: { role: 'OWNER' },
        });
        if (promoted.count === 0) {
          throw ApiError.conflict('Target user is no longer an active member');
        }

        // Notify both parties.
        const [oldOwner, newOwner] = await Promise.all([
          tx.user.findUnique({ where: { id: actorUserId }, select: { username: true, displayName: true } }),
          tx.user.findUnique({ where: { id: targetUserId }, select: { username: true, displayName: true } }),
        ]);

        await tx.notification.createMany({
          data: [
            {
              userId: targetUserId,
              type: 'GROUP_OWNERSHIP_TRANSFERRED',
              title: 'Ownership transferred',
              body: `You are now the owner of "${group.name}"`,
              data: { groupId, previousOwnerId: actorUserId },
            },
            {
              userId: actorUserId,
              type: 'GROUP_OWNERSHIP_TRANSFERRED',
              title: 'Ownership transferred',
              body: `Ownership of "${group.name}" has been transferred to ${newOwner?.displayName || newOwner?.username || 'a user'}`,
              data: { groupId, newOwnerId: targetUserId },
            },
          ],
        });

        return { message: 'Ownership transferred' };
      });

      return { success: true, data: result };
    }
  );
}
