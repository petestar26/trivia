import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// Regression coverage for a specific race: an ADMIN concurrently bans a
// member while the OWNER transfers ownership to that same member. Before
// the fix in groups.ts, the ban route's atomic guard only excluded rows
// that were already BANNED — not rows that had just been promoted to
// OWNER by a racing transfer — so the two writes could interleave into
// role=OWNER, status=BANNED. That state is permanently unrecoverable:
// every route that could undo it (transfer-away, role change, removal,
// re-join, leave) requires either an ACTIVE actor/target or rejects
// touching an OWNER, so the group is stuck forever.
//
// This lives in its own file for the same reason groups-ban-authorization
// .test.ts does: the API's global rate limit is IP-keyed, and this test
// fires many concurrent request pairs. Every injected request below also
// carries a unique `remoteAddress` so none of them share a rate-limit
// bucket regardless of round count (see apps/api/src/routes/users.test.ts
// for the same established pattern).

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

const EMAIL_PREFIX = 'grace-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `gr_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `RaceTest ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (!userIds.length) return;
  const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
  const groupIds = groups.map((g) => g.id);
  if (groupIds.length) {
    await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  }
  await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

// Deterministic, collision-free dotted-quad per logical request index, so
// every request in this file gets its own global-rate-limit bucket no
// matter how many rounds run.
function ipFor(n: number): string {
  const a = (n >> 16) & 255;
  const b = (n >> 8) & 255;
  const c = n & 255;
  return `10.${a}.${b}.${c || 1}`;
}

interface RoundFixture {
  groupId: string;
  ownerId: string;
  targetId: string;
  banToken: string;
  transferToken: string;
}

// The ban and the transfer are issued by two DIFFERENT managers (an ADMIN
// and the OWNER) rather than the same account twice. Empirically this is
// what actually produces a two-sided race: when the same account issues
// both requests, its own two pre-transaction reads (assertManager's
// membership fetch for the ban, actorMembership for the transfer) resolve
// with enough shared timing that one side wins essentially every round,
// leaving the "ban wins" branch below unexercised. Two independent actors
// racing an independent manager's ban against the owner's transfer removes
// that bias and lets either side genuinely win from round to round.
async function setupRound(index: number): Promise<RoundFixture> {
  const tag = `r${index}`;
  const owner = await createUser(`${tag}-own`);
  const admin = await createUser(`${tag}-adm`);
  const target = await createUser(`${tag}-tgt`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Race-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.createMany({
    data: [
      { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
      { groupId: group.id, userId: admin.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.ACTIVE },
      { groupId: group.id, userId: target.id, role: GroupMemberRole.MEMBER, status: GroupMemberStatus.ACTIVE },
    ],
  });
  return {
    groupId: group.id,
    ownerId: owner.id,
    targetId: target.id,
    banToken: await mintToken(admin),
    transferToken: await mintToken(owner),
  };
}

interface RoundOutcome {
  index: number;
  ownerId: string;
  targetId: string;
  banStatus: number;
  transferStatus: number;
  targetRole: string;
  targetStatus: string;
  groupOwnerId: string;
  ownerRowCount: number;
}

async function runRound(fixture: RoundFixture, index: number): Promise<RoundOutcome> {
  const { groupId, ownerId, targetId, banToken, transferToken } = fixture;

  // The same owner fires both requests at once: a ban of the target, and a
  // transfer of ownership to that same target. Real HTTP-shaped requests
  // via server.inject, not a direct DB race — this exercises the actual
  // route handlers end to end, including their pre-transaction reads.
  const [banResp, transferResp] = await Promise.all([
    server.inject({
      method: 'POST',
      url: `${PREFIX}/${groupId}/members/${targetId}/ban`,
      headers: authHeader(banToken),
      remoteAddress: ipFor(index * 2),
    }),
    server.inject({
      method: 'POST',
      url: `${PREFIX}/${groupId}/transfer`,
      headers: authHeader(transferToken),
      payload: { targetUserId: targetId },
      remoteAddress: ipFor(index * 2 + 1),
    }),
  ]);

  const [targetRow, ownerRows] = await Promise.all([
    prisma.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId, userId: targetId } } }),
    prisma.groupMember.findMany({ where: { groupId, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE } }),
  ]);
  const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });

  return {
    index,
    ownerId,
    targetId,
    banStatus: banResp.statusCode,
    transferStatus: transferResp.statusCode,
    targetRole: targetRow.role,
    targetStatus: targetRow.status,
    groupOwnerId: group.ownerId,
    ownerRowCount: ownerRows.length,
  };
}

// 300 rounds gives >99.9% probability of reproducing the corruption at
// least once against the unguarded code, at the empirically observed
// ~2.5-3% per-round collision rate for this specific race (verified via
// repeated mutation runs during development — a smaller round count let
// the mutation intermittently survive by chance, i.e. was too flaky to
// trust as a regression gate). Sequential rounds cost ~15-20ms each, so
// this is ~5s of wall time, not a meaningful drag on the suite.
const ROUNDS = 300;

describeIf('groups/routes — ban vs ownership-transfer race', () => {
  it(
    'never leaves a member role=OWNER and status=BANNED, and the group always keeps exactly one active owner',
    async () => {
      // Rounds run one at a time, not batched into one giant Promise.all:
      // batching all 60 rounds' request pairs together was tried first and
      // produced a deterministic, non-racy result (the same side won every
      // single round, 60/0, with the connection pool apparently servicing
      // requests in a fixed order under that much simultaneous load) —
      // verified empirically, not assumed. One round in flight at a time
      // reproduces genuine, independently-timed racing between the two
      // requests within that round, matching how this race was originally
      // found and reproduced.
      const outcomes: RoundOutcome[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        const fixture = await setupRound(i);
        outcomes.push(await runRound(fixture, i));
      }

      let transferWon = 0;
      let banWon = 0;
      let neither = 0;
      let transferRejectedEarly = 0;        // 400 — pre-transaction read saw BANNED
      let transferRejectedInTransaction = 0; // 409 — in-transaction guard caught it
      const corrupted: RoundOutcome[] = [];

      for (const o of outcomes) {
        // The one invariant that must never break, regardless of which
        // request won: an OWNER can never simultaneously be BANNED.
        const isCorrupted = o.targetRole === 'OWNER' && o.targetStatus === 'BANNED';
        if (isCorrupted) corrupted.push(o);

        // Every round must end with exactly one active OWNER — the group
        // itself is never allowed to end up ownerless or double-owned.
        expect(o.ownerRowCount, `round ${o.index}: active-owner count`).toBe(1);

        const transferSucceeded = o.targetRole === 'OWNER';
        const banSucceeded = o.targetStatus === 'BANNED';

        if (transferSucceeded && !banSucceeded) {
          transferWon++;
          // Transfer won: target must be a clean ACTIVE owner, and the
          // group record must agree, and the ban must have been rejected
          // (403 — either by the pre-transaction check, if it ran late
          // enough to see the promotion, or by the in-transaction re-read
          // this fix adds).
          expect(o.targetStatus, `round ${o.index}: transfer won`).toBe('ACTIVE');
          expect(o.groupOwnerId, `round ${o.index}: group.ownerId`).toBe(o.targetId);
          expect(o.banStatus, `round ${o.index}: ban status when transfer won`).toBe(403);
        } else if (banSucceeded && !transferSucceeded) {
          banWon++;
          // Ban won: target must be BANNED and demoted-or-unchanged (never
          // OWNER), ownership must still sit with the original owner, and
          // the transfer must have been rejected (409 — the transfer
          // route's own atomic `status: 'ACTIVE'` guard on the promotion
          // updateMany, unaffected by this fix).
          expect(o.targetRole, `round ${o.index}: ban won`).not.toBe('OWNER');
          expect(o.groupOwnerId, `round ${o.index}: group.ownerId unchanged`).toBe(o.ownerId);
          // Two rejections are legitimate here and which one fires depends
          // on how far the transfer had progressed when the ban committed:
          //
          //   400 — the transfer's pre-transaction read already saw the
          //         target as BANNED ('Target user must be an active member')
          //   409 — the read saw ACTIVE, and the transfer's in-transaction
          //         `status: 'ACTIVE'` guard caught the change instead
          //         ('Target user is no longer an active member')
          //
          // Both are asserted exactly, never "any 4xx" — each is also
          // pinned deterministically by its own test below.
          expect(
            [400, 409],
            `round ${o.index}: transfer status when ban won (got ${o.transferStatus})`
          ).toContain(o.transferStatus);
          if (o.transferStatus === 400) transferRejectedEarly++;
          else transferRejectedInTransaction++;
        } else {
          neither++;
        }
      }

      // Diagnostic context for a failure — not itself an assertion beyond
      // `corrupted` being empty and `neither` being zero.
      const banStatusCounts: Record<number, number> = {};
      const transferStatusCounts: Record<number, number> = {};
      for (const o of outcomes) {
        banStatusCounts[o.banStatus] = (banStatusCounts[o.banStatus] ?? 0) + 1;
        transferStatusCounts[o.transferStatus] = (transferStatusCounts[o.transferStatus] ?? 0) + 1;
      }
      console.log(`banStatusCounts=${JSON.stringify(banStatusCounts)}`);
      console.log(`transferStatusCounts=${JSON.stringify(transferStatusCounts)}`);
      console.log(
        `race summary: ${ROUNDS} rounds — transferWon=${transferWon} banWon=${banWon} neither=${neither} corrupted=${corrupted.length}`
      );
      console.log(
        `transfer rejections when ban won: 400(early-read)=${transferRejectedEarly} 409(in-transaction)=${transferRejectedInTransaction}`
      );

      expect(neither, 'every round must end with either the ban or the transfer having taken effect').toBe(0);
      expect(
        corrupted,
        `${corrupted.length}/${ROUNDS} rounds left a BANNED owner: ${JSON.stringify(corrupted)}`
      ).toEqual([]);
    },
    120_000
  );

  // The probabilistic suite above accepts either 400 or 409 from a losing
  // transfer because which one fires depends on timing. Both are pinned
  // deterministically here so neither can silently stop happening.
  describe('both transfer rejection paths, forced', () => {
    async function fixture(tag: string) {
      const owner = await createUser(`${tag}-own`);
      const admin = await createUser(`${tag}-adm`);
      const target = await createUser(`${tag}-tgt`);
      const group = await prisma.group.create({
        data: { ownerId: owner.id, name: `Det-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
      });
      await prisma.groupMember.createMany({
        data: [
          { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
          { groupId: group.id, userId: admin.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.ACTIVE },
          { groupId: group.id, userId: target.id, role: GroupMemberRole.MEMBER, status: GroupMemberStatus.ACTIVE },
        ],
      });
      const targetRow = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: group.id, userId: target.id } },
      });
      return { group, owner, admin, target, targetRowId: targetRow.id };
    }

    async function assertInvariant(groupId: string, expectedOwnerId: string) {
      const activeOwners = await prisma.groupMember.findMany({
        where: { groupId, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
      });
      expect(activeOwners).toHaveLength(1);
      expect(activeOwners[0].userId).toBe(expectedOwnerId);
      const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
      expect(group.ownerId).toBe(expectedOwnerId);
    }

    it('400 when the transfer\'s pre-transaction read already sees the target BANNED', async () => {
      const f = await fixture('early');

      const ban = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.group.id}/members/${f.target.id}/ban`,
        headers: authHeader(await mintToken(f.admin)),
      });
      expect(ban.statusCode).toBe(200);

      // The ban is fully committed before the transfer begins, so the
      // transfer's own `targetMembership.status !== 'ACTIVE'` pre-check
      // rejects it — never reaching the transaction.
      const transfer = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.group.id}/transfer`,
        headers: authHeader(await mintToken(f.owner)),
        payload: { targetUserId: f.target.id },
      });

      expect(transfer.statusCode).toBe(400);
      expect(JSON.parse(transfer.body).error.message).toBe('Target user must be an active member');
      await assertInvariant(f.group.id, f.owner.id);
    }, 60_000);

    it('409 when the ban lands after that read but before the promotion write', async () => {
      const f = await fixture('late');
      const transferToken = await mintToken(f.owner);

      // Hold the target row so the transfer clears its pre-checks (seeing
      // ACTIVE) and then blocks on its promotion updateMany. The ban's
      // effect is applied underneath and committed, so the promotion's
      // `status: 'ACTIVE'` guard re-qualifies against a BANNED row.
      let pending: Promise<{ statusCode: number; body: string }> | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM group_members WHERE id = ${f.targetRowId} FOR UPDATE`;
          pending = server.inject({
            method: 'POST',
            url: `${PREFIX}/${f.group.id}/transfer`,
            headers: authHeader(transferToken),
            payload: { targetUserId: f.target.id },
          }) as unknown as Promise<{ statusCode: number; body: string }>;
          pending.catch(() => undefined);
          await new Promise((r) => setTimeout(r, 350));
          await tx.groupMember.update({
            where: { id: f.targetRowId },
            data: { status: GroupMemberStatus.BANNED },
          });
        },
        { timeout: 20_000, maxWait: 20_000 }
      );

      const transfer = await pending!;
      expect(transfer.statusCode).toBe(409);
      expect(JSON.parse(transfer.body).error.message).toBe('Target user is no longer an active member');
      // The whole transfer transaction rolled back, so ownership never moved.
      await assertInvariant(f.group.id, f.owner.id);
    }, 60_000);
  });
});
