import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';
import { ErrorCode } from '@socialplay/shared';

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

      const group = await prisma.group.create({
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

      await prisma.groupMember.create({
        data: {
          groupId: group.id,
          userId: request.user!.sub,
          role: 'OWNER',
          status: 'ACTIVE',
        },
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

      if (group.isPrivate) {
        const membership = await getGroupMembership(request.params.id, request.user!.sub);
        if (!membership || membership.status !== 'ACTIVE') {
          throw ApiError.forbidden('Group is private');
        }
      }

      const memberCount = await prisma.groupMember.count({
        where: { groupId: group.id, status: 'ACTIVE' },
      });

      const membership = await getGroupMembership(group.id, request.user!.sub);
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

  // List/discover groups
  server.get<{ Querystring: { page?: number; limit?: number; query?: string } }>(
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
          },
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const q = request.query.query?.trim();

      const where: Record<string, unknown> = {
        status: 'ACTIVE',
      };

      if (q) {
        where.name = { contains: q, mode: 'insensitive' };
      }

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
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.group.count({ where }),
      ]);

      const data = await Promise.all(
        groups.map(async (g) => {
          const membership = await getGroupMembership(g.id, request.user!.sub);
          return {
            id: g.id,
            name: g.name,
            description: g.description,
            imageUrl: g.imageUrl,
            coverUrl: g.coverUrl,
            isPrivate: g.isPrivate,
            status: g.status,
            memberCount: g._count.members,
            isMember: !!membership && membership.status === 'ACTIVE',
            memberRole: membership?.role,
            owner: g.owner,
            createdAt: g.createdAt,
            updatedAt: g.updatedAt,
          };
        })
      );

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

      await prisma.groupMember.update({
        where: { id: membership.id },
        data: { status: 'LEFT' },
      });

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

      await prisma.groupMember.delete({
        where: { id: target.id },
      });

      return {
        success: true,
        data: { message: 'Member removed' },
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

      await prisma.groupMember.update({
        where: { id: target.id },
        data: { role: newRole },
      });

      return {
        success: true,
        data: { message: 'Member role updated' },
      };
    }
  );
}
