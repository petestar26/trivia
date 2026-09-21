import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, type Prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';
import { ErrorCode } from '@socialplay/shared';
import { safeRecordActivity } from '../rewards/activity-service';
import {
  ADMISSION_PERMITTED_GROUP_STATUSES,
  ADMISSION_PERMITTED_USER_STATUSES,
  lockAccountForAdmission,
  lockActorAndTarget,
  lockActorMembership,
  lockGroupForAdmission,
  lockGroupForDeletion,
  lockGroupForEdit,
  lockInviteForRevocation,
  lockInviteRow,
  lockInviteSubject,
  type LockedGroup,
  type LockedMembership,
  type Tx,
} from './group-locks.js';

type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
type GroupMemberStatus = 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED' | 'LEFT';

const MANAGER_ROLES: GroupMemberRole[] = ['OWNER', 'ADMIN'];

function hasRole(role: GroupMemberRole, allowed: GroupMemberRole[]): boolean {
  return allowed.includes(role);
}

/**
 * Whether an account may be admitted through an invitation addressed to
 * `inviteEmail`. Pure: it judges whatever row it is handed, so the SAME
 * predicate runs on the unlocked fast-path read and on the authoritative read
 * taken under the row lock (see group-locks.ts) and the two cannot drift.
 */
function assertAdmissionEligible(
  account: { email: string | null; isVerified: boolean; status: string } | null,
  inviteEmail: string
): void {
  if (!account || !account.email || !account.isVerified) {
    throw ApiError.forbidden('You must have a verified email to accept invites');
  }
  if (account.status === 'BANNED') {
    throw ApiError.forbidden('You are banned from this group');
  }
  if (!(ADMISSION_PERMITTED_USER_STATUSES as readonly string[]).includes(account.status)) {
    throw ApiError.forbidden('Your account is not eligible to accept invitations');
  }
  if (account.email.toLowerCase() !== inviteEmail.toLowerCase()) {
    throw ApiError.forbidden('This invite is not for your email address');
  }
}

/**
 * Whether the account a manager is admitting through a join request may be
 * admitted at all. Judged on the row read UNDER the account lock. A join request
 * carries no invitation, so — unlike acceptance — nothing here compares an
 * email: the only question is whether the account is usable (canonical ACTIVE).
 * The rejection is one generic answer for every restricted status, so a manager
 * learns nothing about an applicant's platform standing beyond "not now".
 */
function assertApplicantAdmissible(account: { status: string } | null): void {
  if (!account) {
    // The applicant (and with them the request) was deleted after the manager's
    // fast-path read.
    throw ApiError.notFound('Join request not found');
  }
  if (!(ADMISSION_PERMITTED_USER_STATUSES as readonly string[]).includes(account.status)) {
    throw ApiError.forbidden('This applicant is not eligible to be admitted');
  }
}

/**
 * Whether the group still admits, judged on the row read UNDER the group lock
 * (lockGroupForAdmission) — never on a read taken before it. A group that has
 * been archived, deactivated or banned, or deleted, admits nobody.
 */
function assertGroupActive(group: LockedGroup | null): asserts group is LockedGroup {
  if (!group || !(ADMISSION_PERMITTED_GROUP_STATUSES as readonly string[]).includes(group.status)) {
    throw ApiError.badRequest('Group is not active');
  }
}

/**
 * Whether the account making a DIRECT membership call (public join, request to
 * join) may enter a group at all, judged on the row read UNDER the account lock:
 * only a canonical ACTIVE account may. Nothing here binds the call to an email or
 * a verified address — unlike an invitation, neither route has one. One generic
 * answer for every restricted status, and for an account that no longer exists.
 */
function assertCallerEligible(account: { status: string } | null): void {
  if (!account || !(ADMISSION_PERMITTED_USER_STATUSES as readonly string[]).includes(account.status)) {
    throw ApiError.forbidden('Your account is not eligible to join groups');
  }
}

/**
 * The controlled refusal for a membership row that stands in the way of a PUBLIC
 * JOIN, or null when there is nothing in the way: no row, or a LEFT one that a
 * join may reactivate. Pure, so the unlocked fast path and the re-read under the
 * locks judge a row by the very same rules.
 */
function joinRefusal(membership: { status: string; role: string } | null): ApiError | null {
  if (!membership) return null;
  if (membership.status === 'ACTIVE' || membership.status === 'MUTED') {
    return ApiError.conflict('You are already a member of this group');
  }
  if (membership.status === 'BANNED') return ApiError.forbidden('You are banned from this group');
  if (membership.status === 'PENDING') return ApiError.conflict('Your membership is pending approval');
  if (membership.role === 'OWNER') return ApiError.conflict('Your membership status cannot be changed');
  return null;
}

/** The same for a REQUEST TO JOIN. (MUTED is not refused here: it is reported by the guarded write.) */
function requestRefusal(membership: { status: string } | null): ApiError | null {
  if (!membership) return null;
  if (membership.status === 'ACTIVE') return ApiError.conflict('You are already a member of this group');
  if (membership.status === 'PENDING') return ApiError.conflict('Your membership request is already pending');
  if (membership.status === 'BANNED') return ApiError.forbidden('You are banned from this group');
  return null;
}

/** A Prisma unique-constraint violation: two concurrent inserts of the same (group, user) membership. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
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

/**
 * Whether a membership grants the authority to act as one of `allowedRoles`: it
 * must be ACTIVE and hold one of the roles. Pure, so the unlocked fast path
 * (assertManager) and the re-read under the actor's row lock (lockActorMembership,
 * in group-locks.ts) judge a row by the very same rules and their answers cannot
 * drift.
 */
function assertActorAuthority(
  membership: { role: string; status: string } | null,
  allowedRoles: GroupMemberRole[] = MANAGER_ROLES
): GroupMemberRole {
  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }

  const role = membership.role as GroupMemberRole;

  if (!hasRole(role, allowedRoles)) {
    throw ApiError.forbidden('Insufficient permissions');
  }

  return role;
}

/**
 * FAST PATH: the actor's authority, from a plain read. It can be stale the
 * instant it returns; the routes that act on it re-check under the actor's row
 * lock (assertActorAuthority over lockActorMembership) where it matters.
 */
async function assertManager(
  groupId: string,
  userId: string,
  allowedRoles: GroupMemberRole[] = MANAGER_ROLES
): Promise<GroupMemberRole> {
  return assertActorAuthority(await getGroupMembership(groupId, userId), allowedRoles);
}

interface ManagerAuthorization {
  /** The group as the lock read it. */
  group: LockedGroup;
  /** The actor's role as the lock read it (the ceiling of what they may do). */
  actorRole: GroupMemberRole;
  /** The target's membership as the lock read it — null when it does not exist, or when the action has no target row. */
  target: LockedMembership | null;
}

/**
 * THE in-transaction authorization for every manager action: it locks the group
 * and the actor's own membership — and the target's — in the order the protocol
 * in group-locks.ts prescribes, re-reads them AFTER the locks are granted, and
 * refuses the action unless the actor is, RIGHT NOW, an ACTIVE holder of one of
 * `allowedRoles` in a group in the state the action needs. The locks stay held to
 * commit, so what it saw stays true for the whole transaction.
 *
 * Everything the routes checked with plain reads before their transaction — the
 * fast path (assertManager, the group's status) — was an optimization that can be
 * stale by the time the write happens; this is the authority.
 *
 *   level 2  the group row: FOR SHARE (`groupLock` 'SHARE', the default), FOR NO
 *            KEY UPDATE ('NO KEY UPDATE', an edit) or FOR UPDATE ('UPDATE', a
 *            deletion). Gone: 404 "Group not found".
 *            `requireActiveGroup`: not ACTIVE — or gone, which is not active
 *            either: 400 "Group is not active".
 *   level 3  `beforeMembers`, if given, runs here (an action that takes the
 *            (group, email) subject lock takes it BETWEEN the group and the members).
 *   level 4  the actor's row and, when `targetUserId` is given, the target's,
 *            together in id order (lockActorAndTarget); otherwise the actor's row
 *            alone, FOR SHARE. Not an ACTIVE member: 403 "You are not a member of
 *            this group"; the wrong role: 403 "Insufficient permissions".
 *            `mustOwn`: also groups.ownerId must be the actor (403).
 */
async function authorizeManagerAction(
  tx: Tx,
  args: {
    groupId: string;
    actorId: string;
    targetUserId?: string;
    allowedRoles?: GroupMemberRole[];
    groupLock?: 'SHARE' | 'NO KEY UPDATE' | 'UPDATE';
    requireActiveGroup?: boolean;
    mustOwn?: boolean;
    beforeMembers?: (group: LockedGroup) => Promise<void>;
  }
): Promise<ManagerAuthorization> {
  const lockGroup =
    args.groupLock === 'UPDATE'
      ? lockGroupForDeletion
      : args.groupLock === 'NO KEY UPDATE'
        ? lockGroupForEdit
        : lockGroupForAdmission;
  const group = await lockGroup(tx, args.groupId);
  // A group that is gone is not an ACTIVE one: for the actions that need an active
  // group that is the answer admission has always given (400), for the others a 404.
  if (args.requireActiveGroup) assertGroupActive(group);
  if (!group) {
    throw ApiError.notFound('Group not found');
  }

  if (args.beforeMembers) await args.beforeMembers(group);

  let actor: LockedMembership | null;
  let target: LockedMembership | null = null;
  if (args.targetUserId !== undefined) {
    ({ actor, target } = await lockActorAndTarget(tx, args.groupId, args.actorId, args.targetUserId));
  } else {
    actor = await lockActorMembership(tx, args.groupId, args.actorId);
  }
  const actorRole = assertActorAuthority(actor, args.allowedRoles);
  if (args.mustOwn && group.ownerId !== args.actorId) {
    throw ApiError.forbidden('Insufficient permissions');
  }
  return { group, actorRole, target };
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
          isMember: isActiveMember,
          // Null — never omitted, and never the role of a membership that is
          // not ACTIVE (a LEFT admin is not acting as one).
          memberRole: isActiveMember ? membership!.role : null,
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
      const actorId = request.user!.sub;
      await assertManager(group.id, actorId, ['OWNER']);

      const data: Record<string, unknown> = {};
      if (request.body.name !== undefined) data.name = request.body.name;
      if (request.body.description !== undefined) data.description = request.body.description;
      if (request.body.isPrivate !== undefined) data.isPrivate = request.body.isPrivate;
      if (request.body.imageUrl !== undefined) data.imageUrl = request.body.imageUrl;
      if (request.body.coverUrl !== undefined) data.coverUrl = request.body.coverUrl;

      const updated = await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECK. The owner check above was a plain read taken before
        // this transaction: an owner who handed the group over meanwhile is an
        // ADMIN by now and must not rename, re-describe or flip the privacy of a
        // group that is no longer theirs. The group row is taken FOR NO KEY UPDATE
        // (the lock the UPDATE below needs anyway), which no admission, manager
        // action or transfer can be inside while it is held; then the caller's own
        // membership row. The caller must be groups.ownerId AND an ACTIVE OWNER.
        await authorizeManagerAction(tx, {
          groupId: group.id,
          actorId,
          allowedRoles: ['OWNER'],
          groupLock: 'NO KEY UPDATE',
          mustOwn: true,
        });

        return tx.group.update({
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
      const actorId = request.user!.sub;
      await assertManager(group.id, actorId, ['OWNER']);

      await prisma.$transaction(async (tx) => {
        // Level 2 of the protocol in group-locks.ts, FIRST: the group row before
        // any member row. Deleting the members first inverted the order every
        // other group writer uses (transfer and admission take the group row,
        // then member rows), so a delete holding member rows while waiting for
        // the group row could deadlock with either (PostgreSQL 40P01 -> a 500).
        //
        // AUTHORITATIVE CHECK. The owner check above was a plain read taken before
        // this transaction: an owner who handed the group over meanwhile is an
        // ADMIN by now, and a deletion cannot be undone. With the group row held
        // FOR UPDATE no transfer can be mid-flight, so the owner read from it is
        // stable; the caller's own membership row is locked and re-read too
        // (level 4, before every other member row): the caller must be
        // groups.ownerId AND an ACTIVE OWNER member.
        await authorizeManagerAction(tx, {
          groupId: group.id,
          actorId,
          allowedRoles: ['OWNER'],
          groupLock: 'UPDATE',
          mustOwn: true,
        });

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

      // FAST PATH ONLY. None of these reads takes a lock, so each can be stale the
      // instant it returns; they turn away the common refusal without opening a
      // transaction. Authority is the locked re-read below.
      const group = await getGroupOrThrow(groupId);

      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }

      if (group.isPrivate) {
        throw ApiError.badRequest('Group is private; you cannot join directly');
      }

      const refused = joinRefusal(await getGroupMembership(groupId, userId));
      if (refused) throw refused;

      const outcome = await prisma.$transaction(async (tx): Promise<'joined' | 'rejoined'> => {
        // AUTHORITATIVE CHECKS. Lock the caller's account row and the group row
        // and re-read both, then hold the locks through the membership write and
        // the commit, so neither an account restriction nor an archive or a
        // switch to private can slip in between the check and the admission.
        // Order — see group-locks.ts: account row (1), group row (2), then the
        // member row (4). No subject lock (3) and no invite row (5): a join
        // touches one membership row, and the guarded write below is what orders
        // it against a ban.
        const account = await lockAccountForAdmission(tx, userId);
        const locked = await lockGroupForAdmission(tx, groupId);
        assertGroupActive(locked);
        if (locked.isPrivate) {
          throw ApiError.badRequest('Group is private; you cannot join directly');
        }
        assertCallerEligible(account);

        // A fresh read, but NOT the authority: nothing locks the member row yet,
        // so a ban can still commit between this read and the write. The guarded
        // write is the authority.
        const current = await tx.groupMember.findUnique({
          where: { groupId_userId: { groupId, userId } },
        });
        const blocked = joinRefusal(current);
        if (blocked) throw blocked;

        if (!current) {
          try {
            await tx.groupMember.create({
              data: { groupId, userId, role: 'MEMBER', status: 'ACTIVE' },
            });
          } catch (err) {
            // A concurrent join of the same account inserted the row first.
            if (isUniqueViolation(err)) throw ApiError.conflict('You are already a member of this group');
            throw err;
          }
          return 'joined';
        }

        // Atomic conditional transition — only a LEFT, non-OWNER membership may be
        // reactivated. An unconditional update here would overwrite a ban (or a
        // promotion, an approval, a request) that committed after the read above:
        // the write waits for that writer's row lock, re-evaluates this WHERE, and
        // matches nothing. Rejoining is a fresh admission: the member returns as
        // MEMBER, never with privileges (ADMIN/MODERATOR) earned under an earlier
        // membership.
        const reactivated = await tx.groupMember.updateMany({
          where: { id: current.id, status: 'LEFT', role: { not: 'OWNER' } },
          data: { status: 'ACTIVE', role: 'MEMBER' },
        });
        if (reactivated.count === 0) {
          // Re-read inside the transaction for a specific refusal.
          const now = await tx.groupMember.findUnique({
            where: { id: current.id },
            select: { status: true, role: true },
          });
          throw (
            joinRefusal(now) ??
            ApiError.conflict('Your membership status has changed since this request was initiated')
          );
        }
        return 'rejoined';
      });

      // Server-verified activity: first-group achievement — only for a join that
      // has COMMITTED. A refused join returned above without reaching this line.
      safeRecordActivity(userId, { type: 'GROUP_JOIN' });

      return {
        success: true,
        data: { message: outcome === 'rejoined' ? 'You have rejoined the group' : 'Joined group successfully' },
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

      await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS. The manager, the group and the target above are
        // plain reads taken before this transaction; a manager demoted, banned,
        // muted, removed or gone since must not remove anyone, and the target may
        // have been promoted to OWNER. Lock the group row, then the actor's row and
        // the target's together (group-locks.ts, "Level 4 and the actor"), and
        // decide on what they hold now.
        const { target: locked } = await authorizeManagerAction(tx, { groupId, actorId: actorUserId, targetUserId });

        if (!locked) {
          throw ApiError.notFound('User is not a member of this group');
        }
        if (locked.role === 'OWNER') {
          throw ApiError.forbidden('You cannot remove the owner of the group');
        }

        // The row is locked by this transaction and was just judged not to be the
        // owner's (group.ownerId must never point at a membership that no longer
        // exists — a state no route can repair), so this deletes exactly it.
        await tx.groupMember.delete({
          where: { id: locked.id },
        });
      });

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

      // The subject lock is keyed on the target's email, so it has to be read
      // first. An unlocked read is fine here: it only selects WHICH lock to
      // take, and everything that matters is re-checked after taking it.
      const targetAccount = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { email: true },
      });

      const alreadyBanned = await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS. Everything read above is a fast path taken before
        // this transaction and can be stale by the time it writes: the actor may
        // have been demoted, banned, muted, removed or have left; the group may
        // have stopped being ACTIVE, been renamed or deleted; the target may have
        // been promoted to OWNER or already banned. So lock the group, the (group,
        // email) subject, and the actor's and target's rows together — the order
        // in group-locks.ts — and decide on what they hold NOW.
        //
        // The subject lock (level 3) totally orders this ban against invite
        // creation and acceptance for the same (group, email). Without it a
        // concurrent invite could commit a PENDING invite AFTER this transaction
        // revoked the pending ones, leaving a live invite for a banned user; and
        // an accept holding the invite row while this ban held the member row
        // would deadlock (PostgreSQL 40P01 → a 500 for the manager while the
        // target was admitted anyway).
        const { group: lockedGroup, target: locked } = await authorizeManagerAction(tx, {
          groupId,
          actorId: actorUserId,
          targetUserId,
          requireActiveGroup: true,
          beforeMembers: async () => {
            if (targetAccount?.email) {
              await lockInviteSubject(tx, groupId, targetAccount.email);
            }
          },
        });

        if (!locked) {
          throw ApiError.notFound('User is not a member of this group');
        }
        if (locked.role === 'OWNER') {
          // Nothing may ban the owner — and the row is locked, so a transfer that
          // promoted this target has either committed (seen here) or waits for us.
          throw ApiError.forbidden('You cannot ban the owner of the group');
        }
        if (locked.status === 'BANNED') {
          // A concurrent duplicate ban (two managers, or a retried request) got
          // there first: an idempotent no-op.
          return true;
        }

        await tx.groupMember.update({
          where: { id: locked.id },
          data: { status: 'BANNED' },
        });

        if (targetAccount?.email) {
          await tx.groupInvite.updateMany({
            where: { groupId, email: targetAccount.email.toLowerCase(), status: 'PENDING' },
            data: { status: 'REVOKED' },
          });
        }

        await tx.notification.create({
          data: {
            userId: targetUserId,
            type: 'MODERATION',
            title: 'Banned from group',
            body: `You have been banned from "${lockedGroup.name}"`,
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

  // List banned members (OWNER/ADMIN) — the manager's view of who is banned,
  // so that a ban can be reversed (see unban below).
  //
  // A banned account's identity is moderation data. It is served to managers
  // of THIS group only, and only as the public profile the members list
  // already shows: no email, no role, no dates, and nothing about any other
  // membership the account holds. `status: 'BANNED'` and `groupId` are both in
  // the where-clause, so no other membership can reach the response.
  //
  // Order is most-recently-changed first with the row id as a tie-breaker.
  // `updatedAt` alone is not a total order (a bulk write can stamp several rows
  // with the same instant), and offset pagination over a non-total order can
  // repeat or skip rows between two pages of the same list.
  server.get<{ Params: { id: string }; Querystring: { page?: number; limit?: number } }>(
    '/:id/banned-members',
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
            // The cap keeps `skip` inside the database's integer range; a page
            // number past it would otherwise surface as a 500.
            page: { type: 'integer', minimum: 1, maximum: 1_000_000, default: 1 },
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
      const where = { groupId, status: 'BANNED' as const };

      const [banned, total] = await Promise.all([
        prisma.groupMember.findMany({
          where,
          select: {
            id: true,
            groupId: true,
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.groupMember.count({ where }),
      ]);

      return {
        success: true,
        data: banned.map((m) => ({ id: m.id, groupId: m.groupId, user: m.user })),
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

  // Unban member (OWNER/ADMIN) — the inverse of ban: BANNED → LEFT, role reset
  // to MEMBER, in one guarded write. Nothing else is restored:
  //
  //   • Not ACTIVE. Unbanning lifts the bar; it is not readmission. The user
  //     asks to join again, or is sent a new invitation, like anyone who left.
  //   • Not the pre-ban role. Ban flips the status only, so a banned
  //     ADMIN/MODERATOR still carries that role on the BANNED row. Resetting
  //     it here means no later path back into the group can hand it back.
  //   • Not the invitations the ban revoked. They stay REVOKED — this route
  //     never touches group_invites.
  server.post<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId/unban',
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

      // Looked up by (groupId, userId), so a user who is banned in ANOTHER
      // group — or who does not exist — is indistinguishable from a user who
      // was never in this one: the same 404 as ban, and nothing to learn.
      const target = await getGroupMembership(groupId, targetUserId);
      if (!target) {
        throw ApiError.notFound('User is not a member of this group');
      }
      if (target.role === 'OWNER') {
        throw ApiError.forbidden('You cannot unban the owner of the group');
      }

      // Read first because the subject lock is keyed on the target's email.
      // Unlocked is fine: it only picks WHICH lock to take, and the guarded
      // write below re-checks everything after the lock is held.
      const targetAccount = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { email: true },
      });

      await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS, exactly as ban takes them: the group (ACTIVE, and
        // named as it is NOW), the (group, email) subject, then the actor's row
        // and the target's together — group-locks.ts, in that order. What the
        // plain reads above saw is a fast path that can be stale: the manager may
        // since have been demoted, banned, removed or have left, and the target
        // readmitted or promoted.
        //
        // The subject lock totally orders an unban against a ban, an invite
        // creation and an invite acceptance for the same (group, email). The two
        // orders that matter: an acceptance that started while the target was
        // still banned is refused, never half-admitted; and one that waits behind
        // this unban then sees LEFT and proceeds, instead of reading a stale BANNED.
        const { group: lockedGroup, target: locked } = await authorizeManagerAction(tx, {
          groupId,
          actorId: actorUserId,
          targetUserId,
          requireActiveGroup: true,
          beforeMembers: async () => {
            if (targetAccount?.email) {
              await lockInviteSubject(tx, groupId, targetAccount.email);
            }
          },
        });

        // Judged on the locked row, in the order the fast path answers them. Only
        // the request that makes the transition writes anything and announces it;
        // a target that was readmitted or promoted since the read above, or is
        // simply not banned, is refused with nothing written.
        if (!locked) {
          throw ApiError.notFound('User is not a member of this group');
        }
        if (locked.role === 'OWNER') {
          throw ApiError.forbidden('You cannot unban the owner of the group');
        }
        if (locked.status !== 'BANNED') {
          throw ApiError.conflict('This member is not banned');
        }

        await tx.groupMember.update({
          where: { id: locked.id },
          data: { status: 'LEFT', role: 'MEMBER' },
        });

        // Created in the same transaction: a rollback takes it with it.
        await tx.notification.create({
          data: {
            userId: targetUserId,
            type: 'MODERATION',
            title: 'Unbanned from group',
            body: `You are no longer banned from "${lockedGroup.name}". You may request to join again.`,
            data: { groupId, unbannedBy: actorUserId },
          },
        });
      });

      return { success: true, data: { message: 'Member unbanned' } };
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

      // FAST PATH: plain reads that answer the common refusals without opening a
      // transaction. None of them is authoritative — the transaction below repeats
      // every one of them on rows it holds locked.
      await getGroupOrThrow(groupId);
      await assertManager(groupId, actorUserId);

      const target = await getGroupMembership(groupId, targetUserId);

      if (!target) {
        throw ApiError.notFound('User is not a member of this group');
      }

      if (target.role === 'OWNER') {
        throw ApiError.forbidden('You cannot change the role of the owner');
      }

      if (newRole === 'OWNER') {
        throw ApiError.badRequest('You cannot assign the owner role');
      }

      await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS. The ceiling below — an ADMIN may not hand out
        // ADMIN — is decided on the actor's role AS LOCKED: an owner who handed
        // the group over since the fast path is an ADMIN now, and a manager who
        // was demoted, banned, removed or left is nobody's manager at all.
        // Nothing here needs the group to be ACTIVE (it never did).
        const { actorRole, target: locked } = await authorizeManagerAction(tx, {
          groupId,
          actorId: actorUserId,
          targetUserId,
        });

        if (!locked) {
          throw ApiError.notFound('User is not a member of this group');
        }
        if (locked.role === 'OWNER') {
          throw ApiError.forbidden('You cannot change the role of the owner');
        }
        if (actorRole === 'ADMIN' && newRole === 'ADMIN') {
          throw ApiError.forbidden('Only the owner can assign admin roles');
        }

        await tx.groupMember.update({
          where: { id: locked.id },
          data: { role: newRole },
        });
      });

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

      // Fast path: turn away the common duplicate without a transaction. An
      // invite whose expiry has passed is NOT active even though its stored
      // status is still PENDING, so it must not block a replacement.
      const existingInvite = await prisma.groupInvite.findFirst({
        where: { groupId, email: normalizedEmail, status: 'PENDING', expiresAt: { gt: new Date() } },
      });
      if (existingInvite) {
        throw ApiError.conflict('An active invite already exists for this email');
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Everything above is a fast path on unlocked reads. The authoritative
      // checks run below, AFTER taking the (group, email) subject lock and
      // BEFORE the insert, all in one transaction — the same lock a ban takes
      // first (see group-locks.ts). That is what makes "ban wins" mean no
      // PENDING invite and no invitation notification: a re-read that is not
      // ordered against the ban by a lock would still race it.
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
          // AUTHORITATIVE CHECKS — the group, the subject and the ACTOR, in the
          // order of group-locks.ts, through the one shared authorizeManagerAction.
          //
          // Level 2: the group is only ACTIVE (and PRIVATE, and named as it is
          // read here) for as long as this lock is held, so an archive or an edit
          // that commits after the fast-path checks above cannot leave a fresh
          // PENDING invite (and an invitation notification) behind it. It also
          // orders this transaction against a group DELETE: a delete can no longer
          // wait on the stale invite this transaction just closed out while this
          // transaction waits on the group row for its INSERT.
          //
          // Level 3, after the group and before the actor's row: the (group,
          // email) subject lock a ban takes first, so a ban that committed wins.
          //
          // Level 4: the manager and the role they act with were read before this
          // transaction; an owner who handed the group over meanwhile is an ADMIN
          // by now and may not mint ADMIN invites, and a manager demoted, banned,
          // muted, removed or gone may not create any. The ceiling below is
          // applied to the LOCKED role.
          const { group: lockedGroup, actorRole: actorNow } = await authorizeManagerAction(tx, {
            groupId,
            actorId: request.user!.sub,
            requireActiveGroup: true,
            beforeMembers: async (locked) => {
              // The privacy judged above was a plain read too: an edit that made
              // the group PUBLIC after it must not leave a PENDING invite (and a
              // notification) in a group that does not take invitations.
              if (!locked.isPrivate) {
                throw ApiError.badRequest('Invites are only available for private groups');
              }
              await lockInviteSubject(tx, groupId, normalizedEmail);
            },
          });
          if (actorNow === 'ADMIN' && role === 'ADMIN') {
            throw ApiError.forbidden('Only the owner can assign admin roles');
          }

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

          // Replacement policy for a stale invite: a PENDING invite whose
          // expiry has passed is closed out as EXPIRED and superseded by
          // this one (its token stops working and resolves as EXPIRED). A
          // PENDING invite that is still live blocks the create. This runs
          // under the lock, so two concurrent creates cannot both conclude
          // "nothing pending" and only one supersedes the stale invite.
          const pending = await tx.groupInvite.findFirst({
            where: { groupId, email: normalizedEmail, status: 'PENDING' },
            select: { id: true, expiresAt: true },
          });
          if (pending) {
            if (pending.expiresAt > new Date()) {
              throw ApiError.conflict('An active invite already exists for this email');
            }
            await tx.groupInvite.updateMany({
              where: { id: pending.id, status: 'PENDING' },
              data: { status: 'EXPIRED' },
            });
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
                body: `You have been invited to join "${lockedGroup.name}"`,
                data: { groupId, inviteId: invite.id, groupName: lockedGroup.name, invitedBy: request.user!.sub },
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

      // "Pending" here means live: PENDING and not yet past its expiry. An
      // expired invite still carries status PENDING until something writes
      // it, but listing it as active would offer a manager a dead link.
      const livePending = { groupId, status: 'PENDING' as const, expiresAt: { gt: new Date() } };

      const [invites, total] = await Promise.all([
        prisma.groupInvite.findMany({
          where: livePending,
          include: {
            group: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.groupInvite.count({ where: livePending }),
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

      await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS. The manager, the invite and its status above are
        // plain reads taken before this transaction. A manager demoted, banned,
        // muted, removed or gone since must not revoke anything, and the invite
        // may have been accepted, revoked or replaced meanwhile — an unguarded
        // write here would turn an ACCEPTED invite into a REVOKED one.
        //
        // The same subject lock invite creation, ban, unban and acceptance take
        // (level 3, keyed on the invite's own email, which never changes), then
        // the actor's row FOR SHARE, then the invite row: group-locks.ts, in order.
        await authorizeManagerAction(tx, {
          groupId,
          actorId: request.user!.sub,
          beforeMembers: async () => {
            await lockInviteSubject(tx, groupId, invite.email);
          },
        });

        const locked = await lockInviteForRevocation(tx, groupId, inviteId);
        if (!locked) {
          throw ApiError.notFound('Invite not found');
        }
        if (locked.status !== 'PENDING') {
          throw ApiError.badRequest('Invite is not active');
        }

        await tx.groupInvite.update({
          where: { id: locked.id },
          data: { status: 'REVOKED' },
        });
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

      // The stored status only becomes EXPIRED when something WRITES it (an
      // accept attempt, or a replacement invite), so an invite nobody has
      // touched since its deadline still says PENDING. Report what is true
      // now: a PENDING invite past its expiry is EXPIRED. Derived on read —
      // no write from a GET.
      const effectiveStatus =
        invite.status === 'PENDING' && invite.expiresAt <= new Date() ? 'EXPIRED' : invite.status;

      return {
        success: true,
        data: {
          id: invite.id,
          group: invite.group,
          status: effectiveStatus,
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

      // FAST PATH ONLY. This read takes no lock, so its answer can be stale
      // the instant it returns: an account suspended a moment later still
      // passes it. It exists to turn away the ineligible cheaply, without
      // opening a transaction. Authority is the locked re-read below.
      const preflight = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, isVerified: true, status: true },
      });
      assertAdmissionEligible(preflight, invite.email);

      const outcome = await prisma.$transaction(async (tx): Promise<'accepted' | 'expired' | 'revoked' | 'already-accepted' | 'invalid'> => {
        // AUTHORITATIVE CHECKS. Lock the account row and the group row and
        // re-read both, then hold the locks through the invite claim, the
        // membership transition, the notification and the commit, so neither an
        // account restriction nor a group status change can slip in between the
        // check and the admission. Order matters — see the protocol in
        // group-locks.ts: account row (1), group row (2), then the (group,
        // email) subject (3). The group's status is read from the LOCKED row:
        // a plain read here, ahead of the waits below, would go stale while this
        // transaction sat behind the subject, member or invite lock.
        const account = await lockAccountForAdmission(tx, userId);
        const group = await lockGroupForAdmission(tx, invite.groupId);
        await lockInviteSubject(tx, invite.groupId, invite.email);
        assertAdmissionEligible(account, invite.email);
        assertGroupActive(group);

        const existingMember = await tx.groupMember.findUnique({
          where: { groupId_userId: { groupId: invite.groupId, userId } },
        });
        if (existingMember && existingMember.status === 'ACTIVE') {
          throw ApiError.conflict('You are already a member of this group');
        }
        if (existingMember && existingMember.status === 'BANNED') {
          throw ApiError.forbidden('You are banned from this group');
        }

        // LEVEL 5, then the clock. Lock the invite row FIRST — this can wait
        // behind another transaction for as long as it likes — and only then
        // read the time. The wait may outlast the invite: it was live at the
        // pre-read, and it can be dead by the time this line returns. So the
        // clock is read AFTER every blocking lock in this transaction is held
        // (a fresh Date here; never the transaction-start now(), which is
        // frozen at BEGIN), and the claim below — which no longer waits,
        // because the row is already ours — is judged against it.
        const lockedInvite = await lockInviteRow(tx, invite.id);
        const claimTime = new Date();
        if (!lockedInvite) return 'invalid';

        // Atomic claim: the invite must still be PENDING AND unexpired at
        // transition time. Either failing predicate makes this affect zero
        // rows — expiry is enforced HERE, at the claim, not on the pre-read.
        const claimed = await tx.groupInvite.updateMany({
          where: { id: invite.id, status: 'PENDING', expiresAt: { gt: claimTime } },
          data: { status: 'ACCEPTED', acceptedBy: userId },
        });
        if (claimed.count === 0) {
          // Tell the caller WHY, from the row as it stands under our lock —
          // the state cannot change under us between that read and now.
          if (lockedInvite.status === 'REVOKED') return 'revoked';
          if (lockedInvite.status === 'ACCEPTED') return 'already-accepted';
          if (lockedInvite.status === 'EXPIRED') return 'expired';
          // Still PENDING, so the claim's only failing predicate was the
          // deadline. Persist EXPIRED — and RETURN rather than throw — so the
          // marker commits with this transaction instead of rolling back with
          // an exception. It never marks the invite ACCEPTED, activates or
          // changes a membership, or creates a notification.
          if (lockedInvite.expiresAt <= claimTime) {
            await tx.groupInvite.updateMany({
              where: { id: invite.id, status: 'PENDING' },
              data: { status: 'EXPIRED' },
            });
            return 'expired';
          }
          return 'invalid';
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

        return 'accepted';
      });

      // The transaction commits the outcome, then — for the failures — the
      // error is raised HERE, AFTER commit. Raising inside the callback would
      // roll the whole transaction back, including the EXPIRED marker this
      // path deliberately persists.
      switch (outcome) {
        case 'expired':
          throw ApiError.badRequest('This invite has expired');
        case 'revoked':
          throw ApiError.conflict('This invite has been revoked');
        case 'already-accepted':
          throw ApiError.conflict('This invite has already been accepted');
        case 'invalid':
          throw ApiError.conflict('This invite is no longer valid');
        case 'accepted':
          safeRecordActivity(userId, { type: 'GROUP_JOIN' });
          return { success: true, data: { message: 'Invite accepted', groupId: invite.groupId } };
      }
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

      // FAST PATH ONLY. None of these reads takes a lock, so each can be stale the
      // instant it returns; they turn away the common refusal without opening a
      // transaction. Authority is the locked re-read below.
      const group = await getGroupOrThrow(groupId);
      if (group.status !== 'ACTIVE') {
        throw ApiError.badRequest('Group is not active');
      }
      if (!group.isPrivate) {
        throw ApiError.badRequest('Public groups can be joined directly; use POST /join');
      }

      const refused = requestRefusal(await getGroupMembership(groupId, userId));
      if (refused) throw refused;

      await prisma.$transaction(async (tx) => {
        // AUTHORITATIVE CHECKS. Lock the caller's account row and the group row
        // and re-read both, then hold the locks through the membership write, the
        // manager notifications and the commit: a restricted account creates no
        // PENDING row and notifies nobody, and neither an archive nor a switch to
        // public can slip in between the check and the write. Order — see
        // group-locks.ts: account row (1), group row (2), then the member row (4)
        // and the notifications (6). No subject lock (3) and no invite row (5): a
        // request touches one membership row, and the guarded write below is what
        // orders it against a ban.
        const account = await lockAccountForAdmission(tx, userId);
        const locked = await lockGroupForAdmission(tx, groupId);
        assertGroupActive(locked);
        if (!locked.isPrivate) {
          throw ApiError.badRequest('Public groups can be joined directly; use POST /join');
        }
        assertCallerEligible(account);

        // A fresh read, but NOT the authority: nothing locks the member row yet,
        // so a ban can still commit between this read and the write. The guarded
        // write is the authority.
        const current = await tx.groupMember.findUnique({
          where: { groupId_userId: { groupId, userId } },
        });
        const blocked = requestRefusal(current);
        if (blocked) throw blocked;

        if (current) {
          // Atomic conditional transition — only LEFT memberships are eligible.
          // Prevents overwriting a concurrently approved/promoted OWNER, an
          // ACTIVE member, a BANNED user, or a still-PENDING request.
          const updated = await tx.groupMember.updateMany({
            where: {
              id: current.id,
              status: 'LEFT',
              role: { not: 'OWNER' },
            },
            data: { status: 'PENDING', role: 'MEMBER' },
          });
          if (updated.count === 0) {
            // Re-read inside the transaction for a specific rejection.
            const now = await tx.groupMember.findUnique({
              where: { id: current.id },
              select: { status: true, role: true },
            });
            const refusal = requestRefusal(now);
            if (refusal) throw refusal;
            if (now?.role === 'OWNER') {
              throw ApiError.conflict('Your membership status cannot be changed');
            }
            throw ApiError.conflict('Your membership status has changed since this request was initiated');
          }
        } else {
          try {
            await tx.groupMember.create({
              data: { groupId, userId, role: 'MEMBER', status: 'PENDING' },
            });
          } catch (err) {
            // A concurrent request of the same account inserted the row first.
            if (isUniqueViolation(err)) throw ApiError.conflict('Your membership request is already pending');
            throw err;
          }
        }

        // Notify all managers (OWNER/ADMIN).
        const managers = await tx.groupMember.findMany({
          where: { groupId, role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE' },
        });
        const requester = await tx.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true },
        });

        // The group's name comes from the LOCKED row: a rename that committed
        // while this request waited is what the managers read.
        const notifications = managers.map((m) => ({
          userId: m.userId,
          type: 'GROUP_JOIN_REQUEST' as const,
          title: 'Join request',
          body: `${requester?.displayName || requester?.username || 'A user'} requests to join "${locked.name}"`,
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
        // AUTHORITATIVE CHECKS. Everything above — the group's status, the
        // manager, the membership — is a fast path on unlocked reads, each stale
        // the moment it returns. Lock the APPLICANT's account row, the group row,
        // and the manager's and the applicant's membership rows, re-read all of
        // them, and hold the locks through the transition, the notification and
        // the commit, so an account restriction, an archive, or a demotion, ban,
        // removal or departure of the manager that commits after those reads
        // cannot be approved past. Order — see group-locks.ts: account row (1),
        // group row (2), member rows (4, the two together, in id order). A join
        // request carries no invitation, so nothing here binds it to an email.
        const applicant = await lockAccountForAdmission(tx, targetUserId);
        const { target: locked } = await authorizeManagerAction(tx, {
          groupId,
          actorId: request.user!.sub,
          targetUserId,
          requireActiveGroup: true,
        });
        assertApplicantAdmissible(applicant);

        // Atomic transition — two managers racing to approve the same pending
        // request cannot both process it: the row is locked, and the second one
        // reads what the first one left. A request that was withdrawn, rejected or
        // banned since the fast path is "not pending" all the same.
        if (!locked || locked.status !== 'PENDING') {
          throw ApiError.badRequest('This request is not pending');
        }
        await tx.groupMember.update({
          where: { id: locked.id },
          data: { status: 'ACTIVE' },
        });

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
        // AUTHORITATIVE CHECKS, as approve takes them but without an account row
        // (a rejection admits nobody): the group (ACTIVE), then the manager's row
        // and the applicant's together — group-locks.ts, in that order. A manager
        // demoted, banned, muted, removed or gone since the fast path above must
        // not reject anyone.
        const { target: locked } = await authorizeManagerAction(tx, {
          groupId,
          actorId: request.user!.sub,
          targetUserId,
          requireActiveGroup: true,
        });

        // Atomic transition — an approve racing the reject, or two managers
        // rejecting the same request, cannot both process it: the row is locked,
        // and the second one reads what the first one left.
        if (!locked || locked.status !== 'PENDING') {
          throw ApiError.badRequest('This request is not pending');
        }
        await tx.groupMember.delete({
          where: { id: locked.id },
        });

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
        // AUTHORITATIVE CHECKS. Its FIRST statement is the group row's write
        // (level 2 of group-locks.ts): it takes the row lock, waits behind every
        // admission and manager action holding it FOR SHARE, and is guarded on
        // BOTH things the transfer depends on — the caller is STILL the owner
        // (ownerId), and the group is STILL ACTIVE. Optimistic lock: a transfer
        // that already committed, or a group that was archived or deleted since
        // the reads above, matches no row and writes nothing.
        const updatedGroup = await tx.group.updateMany({
          where: { id: groupId, ownerId: actorUserId, status: 'ACTIVE' },
          data: { ownerId: targetUserId },
        });
        if (updatedGroup.count === 0) {
          // Nothing was written and nothing is held: say WHY with a plain read. A
          // group that still has the caller as its owner refused on its state;
          // anything else (another transfer, a deletion) is a concurrent
          // ownership change.
          const current = await tx.group.findUnique({ where: { id: groupId }, select: { ownerId: true } });
          if (current?.ownerId === actorUserId) {
            throw ApiError.badRequest('Group is not active');
          }
          throw ApiError.conflict('Concurrent ownership change detected; please retry');
        }

        // The row is ours until commit (the write above holds it), so the name
        // read here is the one the notifications must carry — an edit that
        // renamed the group after the reads above waited for this transaction, or
        // committed before it and is seen here. Never the name read before the
        // transaction.
        const { name: groupName } = await tx.group.findUniqueOrThrow({
          where: { id: groupId },
          select: { name: true },
        });

        // Demote old owner to ADMIN — guarded on being, right now, an ACTIVE
        // OWNER: the row is the caller's authority. No route can change it while
        // the group row is held (the ones that write member rows hold the group
        // row FOR SHARE), so this only refuses a writer that bypassed the routes;
        // it must then refuse, not demote whatever the row has become.
        const demoted = await tx.groupMember.updateMany({
          where: { id: actorMembership.id, role: 'OWNER', status: 'ACTIVE' },
          data: { role: 'ADMIN' },
        });
        if (demoted.count === 0) {
          throw ApiError.conflict('Concurrent ownership change detected; please retry');
        }

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
        const newOwner = await tx.user.findUnique({
          where: { id: targetUserId },
          select: { username: true, displayName: true },
        });

        await tx.notification.createMany({
          data: [
            {
              userId: targetUserId,
              type: 'GROUP_OWNERSHIP_TRANSFERRED',
              title: 'Ownership transferred',
              body: `You are now the owner of "${groupName}"`,
              data: { groupId, previousOwnerId: actorUserId },
            },
            {
              userId: actorUserId,
              type: 'GROUP_OWNERSHIP_TRANSFERRED',
              title: 'Ownership transferred',
              body: `Ownership of "${groupName}" has been transferred to ${newOwner?.displayName || newOwner?.username || 'a user'}`,
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
