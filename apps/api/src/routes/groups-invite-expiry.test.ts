import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// Expired-invite semantics.
//
// An invite's stored status only becomes EXPIRED when something WRITES it (an
// accept attempt, or a replacement invite). One nobody has touched since its
// deadline therefore still says PENDING, and the API used to report exactly
// that: a redemption page would offer "Accept invite" on a dead link, and the
// manager's "active invites" list would offer a dead link to copy.
//
// Defined behavior, all covered below:
//   - RESOLVE derives the status: PENDING past its expiry reads as EXPIRED.
//     It does not write — a GET must not change state.
//   - The manager LIST shows live invites only.
//   - CREATE for an email whose PENDING invite has expired REPLACES it: the
//     stale invite is closed out as EXPIRED and a fresh one (new token) is
//     issued. A PENDING invite that is still live still blocks with 409.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures();
  if (server) await server.close();
  await prisma.$disconnect();
});

const EMAIL_PREFIX = 'gexp-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.22.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `ge_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Expiry ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function cleanFixtures() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
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
      // Coin provenance/allocation rows are a real foreign key to User —
      // must be cleared before the user row itself can be deleted (covers
      // legacy backfill rows for any stale fixture user too).
      await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
      const res = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (res.count === users.length) return;
    } catch {
      // A late async reward write still references these users; wait and retry.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function signToken(user: { id: string; email: string; username: string }): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

const HOUR = 3_600_000;

async function makeFixture(tag: string) {
  const owner = await createUser(`${tag}-own`);
  const invitee = await createUser(`${tag}-inv`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Exp-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  return { owner, invitee, groupId: group.id };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function seedInvite(
  f: Fixture,
  opts: { expiresInMs: number; status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' }
) {
  const token = `exptok-${uniqueSuffix()}${uniqueSuffix()}`;
  return prisma.groupInvite
    .create({
      data: {
        groupId: f.groupId,
        email: f.invitee.email.toLowerCase(),
        role: 'MEMBER',
        status: opts.status ?? 'PENDING',
        token,
        expiresAt: new Date(Date.now() + opts.expiresInMs),
        invitedBy: f.owner.id,
      },
    })
    .then((invite) => ({ invite, token }));
}

const resolve = (f: Fixture, token: string) =>
  server.inject({
    method: 'GET',
    url: `${PREFIX}/invites/${token}`,
    headers: { authorization: `Bearer ${signToken(f.invitee)}` },
    remoteAddress: nextIp(),
  });

const createInvite = (f: Fixture, actor = f.owner) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: { authorization: `Bearer ${signToken(actor)}` },
    payload: { email: f.invitee.email },
    remoteAddress: nextIp(),
  });

const listInvites = (f: Fixture) =>
  server.inject({
    method: 'GET',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: { authorization: `Bearer ${signToken(f.owner)}` },
    remoteAddress: nextIp(),
  });

describeIf('expired invites', () => {
  describe('resolve', () => {
    it('reports an untouched expired invite as EXPIRED — and does not write on a GET', async () => {
      const f = await makeFixture('resolve-expired');
      const { invite, token } = await seedInvite(f, { expiresInMs: -HOUR });

      const resp = await resolve(f, token);

      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.status).toBe('EXPIRED');
      // The stored row is exactly as it was: a read must not mutate.
      const row = await prisma.groupInvite.findUniqueOrThrow({ where: { id: invite.id } });
      expect(row.status).toBe('PENDING');
      expect(row.updatedAt.getTime()).toBe(invite.updatedAt.getTime());
    });

    it('still reports a live PENDING invite as PENDING', async () => {
      const f = await makeFixture('resolve-live');
      const { token } = await seedInvite(f, { expiresInMs: HOUR });
      const resp = await resolve(f, token);
      expect(JSON.parse(resp.body).data.status).toBe('PENDING');
    });

    it('leaves terminal states as stored (ACCEPTED, REVOKED, EXPIRED)', async () => {
      const f = await makeFixture('resolve-terminal');
      for (const status of ['ACCEPTED', 'REVOKED', 'EXPIRED'] as const) {
        // Use a distinct email per row: only one PENDING may exist per email,
        // and these are all terminal so that rule does not apply — but keep
        // fixtures independent anyway.
        const { token } = await seedInvite(f, { expiresInMs: -HOUR, status });
        const resp = await resolve(f, token);
        expect(JSON.parse(resp.body).data.status, `stored ${status}`).toBe(status);
      }
    });
  });

  describe('accept', () => {
    it('rejects an expired invite with 400 and records EXPIRED', async () => {
      const f = await makeFixture('accept-expired');
      const { invite, token } = await seedInvite(f, { expiresInMs: -HOUR });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: { authorization: `Bearer ${signToken(f.invitee)}` },
        payload: { token },
        remoteAddress: nextIp(),
      });

      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('This invite has expired');
      expect((await prisma.groupInvite.findUniqueOrThrow({ where: { id: invite.id } })).status).toBe('EXPIRED');
      expect(
        await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.invitee.id } } })
      ).toBeNull();
    });
  });

  describe('manager list', () => {
    it('lists live invites only, and counts only live invites', async () => {
      const f = await makeFixture('list');
      const other = await createUser('list-other');
      // An expired-but-PENDING invite for one email, a live one for another.
      const { token: expiredToken } = await seedInvite(f, { expiresInMs: -HOUR });
      const liveToken = `exptok-${uniqueSuffix()}${uniqueSuffix()}`;
      await prisma.groupInvite.create({
        data: {
          groupId: f.groupId,
          email: other.email.toLowerCase(),
          role: 'MEMBER',
          status: 'PENDING',
          token: liveToken,
          expiresAt: new Date(Date.now() + HOUR),
          invitedBy: f.owner.id,
        },
      });

      const resp = await listInvites(f);
      const body = JSON.parse(resp.body);

      expect(resp.statusCode).toBe(200);
      const tokens = body.data.map((i: { token: string }) => i.token);
      expect(tokens).toContain(liveToken);
      expect(tokens).not.toContain(expiredToken);
      expect(body.meta.total).toBe(1);
    });
  });

  describe('creating an invite for an email that already has a PENDING invite', () => {
    it('a LIVE pending invite still blocks with 409', async () => {
      const f = await makeFixture('create-live');
      await seedInvite(f, { expiresInMs: HOUR });

      const resp = await createInvite(f);

      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body).error.message).toBe('An active invite already exists for this email');
    });

    it('an EXPIRED pending invite is REPLACED: closed out as EXPIRED, superseded by a fresh invite with a new token', async () => {
      const f = await makeFixture('create-replace');
      const { invite: stale, token: staleToken } = await seedInvite(f, { expiresInMs: -HOUR });

      const resp = await createInvite(f);

      expect(resp.statusCode).toBe(200);
      const fresh = JSON.parse(resp.body).data as { id: string; token: string; status: string };
      expect(fresh.id).not.toBe(stale.id);
      expect(fresh.token).not.toBe(staleToken);
      expect(fresh.status).toBe('PENDING');

      // The stale row was closed out, and exactly one live PENDING remains.
      expect((await prisma.groupInvite.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
      expect(
        await prisma.groupInvite.count({
          where: { groupId: f.groupId, email: f.invitee.email.toLowerCase(), status: 'PENDING' },
        })
      ).toBe(1);

      // Old link is dead, new link is live — as the redemption page will see it.
      expect(JSON.parse((await resolve(f, staleToken)).body).data.status).toBe('EXPIRED');
      expect(JSON.parse((await resolve(f, fresh.token)).body).data.status).toBe('PENDING');
    });

    it('the superseded token can no longer be accepted, and says it expired (not "already accepted")', async () => {
      const f = await makeFixture('create-replace-accept');
      const { token: staleToken } = await seedInvite(f, { expiresInMs: -HOUR });
      await createInvite(f);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: { authorization: `Bearer ${signToken(f.invitee)}` },
        payload: { token: staleToken },
        remoteAddress: nextIp(),
      });

      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('This invite has expired');
    });

    it('two concurrent creates over a stale invite yield exactly one live invite', async () => {
      const f = await makeFixture('create-concurrent');
      await seedInvite(f, { expiresInMs: -HOUR });

      const [a, b] = await Promise.all([createInvite(f), createInvite(f)]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(
        await prisma.groupInvite.count({
          where: { groupId: f.groupId, email: f.invitee.email.toLowerCase(), status: 'PENDING' },
        })
      ).toBe(1);
    });
  });
});
