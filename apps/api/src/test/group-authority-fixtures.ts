import { prisma, type Prisma } from '@socialplay/database';
import type { buildServer } from '../server.js';
import { createUser, membershipSnapshot, uniqueSuffix } from './group-admission-fixtures.js';

/**
 * Fixtures and route callers shared by the manager-authority race suites
 * (moderation actions, invite management, edit and transfer). Every suite gives
 * its own email prefix and group-name prefix, so cleanup and the write gate only
 * ever touch the rows that suite created.
 */

export type AuthorityUser = Awaited<ReturnType<typeof createUser>>;
export interface Res {
  statusCode: number;
  body: string;
}

export const errorMessage = (resp: { body: string }): string => JSON.parse(resp.body).error?.message as string;

/**
 * A membership-row id whose sort position is `rank` (one hex digit, 0-f). Every
 * action that writes a target's row locks the actor's row and the target's in
 * ASCENDING id order (group-locks.ts), and a random uuid would make "which of the
 * two is locked first" a coin toss; a fixture that needs one order builds it.
 */
export function rankedRowId(rank: string): string {
  if (!/^[0-9a-f]$/.test(rank)) throw new Error(`rank must be one hex digit: ${rank}`);
  return `${rank}0000000-0000-4000-8000-${uniqueSuffix()}`;
}

/**
 * Where the manager's own row sorts among the rows it acts on:
 *   'targets-first'  every target sorts BEFORE the manager: a request whose target row is
 *                    held parks there WITHOUT holding the manager's row.
 *   'actor-first'    the manager sorts BEFORE every target: it holds the manager's row
 *                    while it waits at the target's.
 */
export type RowOrder = 'targets-first' | 'actor-first';

const RANKS: Record<RowOrder, Record<MemberKey, string>> = {
  'targets-first': { member: '1', banned: '2', pending: '3', peer: '4', admin: '6', admin2: '7', owner: '9' },
  'actor-first': { admin: '1', admin2: '2', owner: '3', member: '6', banned: '7', pending: '8', peer: '9' },
};

export type MemberKey = 'owner' | 'admin' | 'admin2' | 'member' | 'banned' | 'pending' | 'peer';

export interface AuthorityFixture {
  /** OWNER. */
  owner: AuthorityUser;
  /** ADMIN: the manager whose authority the tests end. */
  admin: AuthorityUser;
  /** A second ADMIN: a peer that can act on the first (and be acted on by it). */
  admin2: AuthorityUser;
  /** ACTIVE MEMBER: the usual target. */
  member: AuthorityUser;
  /** BANNED (role ADMIN, so an unban's role reset is visible). */
  banned: AuthorityUser;
  /** A PENDING join request. */
  pending: AuthorityUser;
  /** ACTIVE MEMBER: an ownership transfer's target. */
  peer: AuthorityUser;
  groupId: string;
  groupName: string;
  /** Membership row ids by key. */
  rows: Record<MemberKey, string>;
  /** A live PENDING invite for `member`'s email: a ban must revoke it, a refused ban must leave it. */
  memberInviteId: string;
  /** A live PENDING invite for an address that belongs to nobody. */
  outsiderInviteId: string;
  outsiderEmail: string;
}

export async function makeAuthorityFixture(
  emailPrefix: string,
  groupNamePrefix: string,
  tag: string,
  opts: {
    order?: RowOrder;
    isPrivate?: boolean;
    /** Swap the two admins' positions, so the SECOND admin's row sorts before the first's. */
    adminsSwapped?: boolean;
  } = {}
): Promise<AuthorityFixture> {
  const order = opts.order ?? 'targets-first';
  const ranks = { ...RANKS[order] };
  if (opts.adminsSwapped) [ranks.admin, ranks.admin2] = [ranks.admin2, ranks.admin];
  const owner = await createUser(emailPrefix, `${tag}-own`);
  const admin = await createUser(emailPrefix, `${tag}-adm`);
  const admin2 = await createUser(emailPrefix, `${tag}-ad2`);
  const member = await createUser(emailPrefix, `${tag}-mem`);
  const banned = await createUser(emailPrefix, `${tag}-ban`);
  const pending = await createUser(emailPrefix, `${tag}-pen`);
  const peer = await createUser(emailPrefix, `${tag}-peer`);
  const groupName = `${groupNamePrefix}${tag}-${uniqueSuffix().slice(0, 6)}`;
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: groupName, isPrivate: opts.isPrivate ?? true, status: 'ACTIVE' },
  });
  const rows = Object.fromEntries((Object.keys(ranks) as MemberKey[]).map((k) => [k, rankedRowId(ranks[k])])) as Record<MemberKey, string>;
  const make = (key: MemberKey, user: AuthorityUser, role: 'OWNER' | 'ADMIN' | 'MEMBER', status: 'ACTIVE' | 'BANNED' | 'PENDING') =>
    prisma.groupMember.create({ data: { id: rows[key], groupId: group.id, userId: user.id, role, status } });
  await make('owner', owner, 'OWNER', 'ACTIVE');
  await make('admin', admin, 'ADMIN', 'ACTIVE');
  await make('admin2', admin2, 'ADMIN', 'ACTIVE');
  await make('member', member, 'MEMBER', 'ACTIVE');
  await make('banned', banned, 'ADMIN', 'BANNED');
  await make('pending', pending, 'MEMBER', 'PENDING');
  await make('peer', peer, 'MEMBER', 'ACTIVE');
  const invite = (email: string) =>
    prisma.groupInvite.create({
      data: {
        groupId: group.id,
        email: email.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: `${emailPrefix}tok-${uniqueSuffix()}${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
        invitedBy: owner.id,
      },
    });
  const outsiderEmail = `${emailPrefix}${tag}-out-${uniqueSuffix()}@test.local`;
  const memberInvite = await invite(member.email!);
  const outsiderInvite = await invite(outsiderEmail);
  return {
    owner, admin, admin2, member, banned, pending, peer,
    groupId: group.id,
    groupName,
    rows,
    memberInviteId: memberInvite.id,
    outsiderInviteId: outsiderInvite.id,
    outsiderEmail,
  };
}

type Server = Awaited<ReturnType<typeof buildServer>>;

/**
 * The group routes the authority suites drive, each through its REAL route with a
 * client address of its own (the API's global rate limit is keyed by IP).
 */
export function authorityApi(getServer: () => Server, apiPrefix: string, nextIp: () => string) {
  const groups = `${apiPrefix}/groups`;
  const asUser = (user: AuthorityUser) => ({
    authorization: `Bearer ${getServer().jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] })}`,
  });
  const call = (
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    as: AuthorityUser,
    payload?: Record<string, unknown>
  ): Promise<Res> => getServer().inject({ method, url, headers: asUser(as), payload, remoteAddress: nextIp() });
  return {
    asUser,
    ban: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => call('POST', `${groups}/${f.groupId}/members/${target.id}/ban`, as),
    unban: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => call('POST', `${groups}/${f.groupId}/members/${target.id}/unban`, as),
    remove: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => call('DELETE', `${groups}/${f.groupId}/members/${target.id}`, as),
    role: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser, role: 'ADMIN' | 'MODERATOR' | 'MEMBER') =>
      call('PATCH', `${groups}/${f.groupId}/members/${target.id}/role`, as, { role }),
    approve: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => call('POST', `${groups}/${f.groupId}/requests/${target.id}/approve`, as),
    reject: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => call('POST', `${groups}/${f.groupId}/requests/${target.id}/reject`, as),
    revoke: (f: AuthorityFixture, as: AuthorityUser, inviteId: string) => call('DELETE', `${groups}/${f.groupId}/invites/${inviteId}`, as),
    createInvite: (f: AuthorityFixture, as: AuthorityUser, email: string, role?: 'ADMIN' | 'MODERATOR' | 'MEMBER') =>
      call('POST', `${groups}/${f.groupId}/invites`, as, role ? { email, role } : { email }),
    edit: (f: AuthorityFixture, as: AuthorityUser, body: { name?: string; description?: string; isPrivate?: boolean }) =>
      call('PUT', `${groups}/${f.groupId}`, as, body),
    transfer: (f: AuthorityFixture, as: AuthorityUser, to: AuthorityUser) => call('POST', `${groups}/${f.groupId}/transfer`, as, { targetUserId: to.id }),
    leave: (f: AuthorityFixture, as: AuthorityUser) => call('POST', `${groups}/${f.groupId}/leave`, as),
    deleteGroup: (f: AuthorityFixture, as: AuthorityUser) => call('DELETE', `${groups}/${f.groupId}`, as),
    acceptInvite: (as: AuthorityUser, token: string) => call('POST', `${groups}/accept-invite`, as, { token }),
  };
}

export type AuthorityApi = ReturnType<typeof authorityApi>;

/**
 * ILIKE patterns of the statements the authority suites park a request in, or wait to
 * see a request parked in. pg_stat_activity reports a waiting backend's statement
 * text, so these depend on which statement waits: a request that locks rows before
 * it writes waits in the LOCK, not in its UPDATE.
 */
export const SQL = {
  /** The lock on the manager's row and the target's, in ONE statement (group-locks.ts, level 4). */
  memberRowsLock: '%FROM "group_members"%FOR NO KEY UPDATE%',
  /** The manager's row alone, FOR SHARE (invite creation and revocation, edit, delete). */
  actorShare: '%FROM "group_members"%FOR SHARE%',
  memberUpdate: '%UPDATE "public"."group_members"%',
  memberDelete: '%DELETE FROM "public"."group_members"%',
  lockGroupShare: '%FROM "groups"%FOR SHARE%',
  lockGroupEdit: '%FROM "groups"%FOR NO KEY UPDATE%',
  lockGroupDelete: '%FROM "groups"%FOR UPDATE%',
  groupWrite: '%UPDATE "public"."groups"%',
  inviteUpdate: '%UPDATE "public"."group_invites"%',
  /** A revocation's lock on the invite row (level 5). */
  inviteLock: '%FROM "group_invites"%FOR NO KEY UPDATE%',
  subjectLock: '%pg_advisory_xact_lock%',
} as const;

/** A way for the acting manager (`f.admin`, an ADMIN) to lose authority, done through the REAL route by the owner (or by the admin, for a leave). */
export interface AuthorityLoss {
  name: string;
  happen: (f: AuthorityFixture) => Promise<Res>;
  /** What a request refused for it is told. */
  message: string;
  /** The manager's row afterwards; null: the row is gone. */
  row: { status: string; role: string } | null;
  /** The statement the competing writer itself waits in when it queues behind a lock on the manager's row. */
  waitsIn: string;
}

export function authorityLosses(api: AuthorityApi): AuthorityLoss[] {
  const direct = async (f: AuthorityFixture, data: Prisma.GroupMemberUpdateInput): Promise<Res> => {
    await prisma.groupMember.update({ where: { id: f.rows.admin }, data });
    return { statusCode: 200, body: '{}' };
  };
  return [
    {
      name: 'demoted to MEMBER (PATCH role)',
      happen: (f) => api.role(f, f.owner, f.admin, 'MEMBER'),
      message: 'Insufficient permissions',
      row: { status: 'ACTIVE', role: 'MEMBER' },
      waitsIn: SQL.memberRowsLock,
    },
    {
      name: 'demoted to MODERATOR (PATCH role)',
      happen: (f) => api.role(f, f.owner, f.admin, 'MODERATOR'),
      message: 'Insufficient permissions',
      row: { status: 'ACTIVE', role: 'MODERATOR' },
      waitsIn: SQL.memberRowsLock,
    },
    {
      name: 'banned (POST ban)',
      happen: (f) => api.ban(f, f.owner, f.admin),
      message: 'You are not a member of this group',
      row: { status: 'BANNED', role: 'ADMIN' },
      waitsIn: SQL.memberRowsLock,
    },
    {
      name: 'removed (DELETE member)',
      happen: (f) => api.remove(f, f.owner, f.admin),
      message: 'You are not a member of this group',
      row: null,
      waitsIn: SQL.memberRowsLock,
    },
    {
      name: 'left the group (POST leave)',
      happen: (f) => api.leave(f, f.admin),
      message: 'You are not a member of this group',
      row: { status: 'LEFT', role: 'ADMIN' },
      waitsIn: SQL.memberUpdate,
    },
    {
      name: 'muted (status change)',
      happen: (f) => direct(f, { status: 'MUTED' }),
      message: 'You are not a member of this group',
      row: { status: 'MUTED', role: 'ADMIN' },
      waitsIn: SQL.memberUpdate,
    },
  ];
}

/** The manager's (f.admin) row as the tests compare it. */
export async function managerRow(f: AuthorityFixture): Promise<{ status: string; role: string } | null> {
  const row = await membershipSnapshot(f.groupId, f.admin.id);
  return row ? { status: row.status, role: row.role } : null;
}
