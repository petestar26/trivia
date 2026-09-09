import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

function uniqueTag(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

describeIf('auth identity foundation slice 4a — multi-provider identity model', () => {
  const createdUserIds: string[] = [];
  const createdSubjects: string[] = [];

  async function cleanupFixtures() {
    if (createdUserIds.length) {
      // Cascade deletes identities via the FK (also exercised in test 6).
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
    if (createdSubjects.length) {
      await prisma.userAuthIdentity.deleteMany({ where: { providerSubject: { in: createdSubjects } } });
      createdSubjects.length = 0;
    }
  }

  beforeAll(async () => {
    await cleanupFixtures();
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  it('1: a User with email=null and passwordHash=null is directly insertable', async () => {
    const tag = uniqueTag('p1');
    const username = `id42_p1_${tag}`.slice(0, 30);
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username, displayName: username, status: 'ACTIVE', role: 'USER', tokenVersion: 0 },
    });
    createdUserIds.push(user.id);
    expect(user.email).toBeNull();
    expect(user.passwordHash).toBeNull();
    expect(user.username).toBe(username);
  });

  it('2: one User can own multiple identities across providers', async () => {
    const tag = uniqueTag('p2');
    const username = `id42_p2_${tag}`.slice(0, 30);
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username, displayName: username },
    });
    createdUserIds.push(user.id);

    await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'EMAIL', providerSubject: `p2-${tag}@test.local`, verifiedAt: null },
    });
    await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'TELEGRAM', providerSubject: tag, verifiedAt: new Date() },
    });
    await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'GOOGLE', providerSubject: `${tag}-sub`, verifiedAt: new Date() },
    });

    const identities = await prisma.userAuthIdentity.findMany({
      where: { userId: user.id },
      orderBy: { provider: 'asc' },
    });
    expect(identities).toHaveLength(3);
    expect(identities.map((i) => i.provider).sort()).toEqual(['EMAIL', 'GOOGLE', 'TELEGRAM']);
  });

  it('3: duplicate (provider, providerSubject) is rejected by the database', async () => {
    const tag = uniqueTag('p3');
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p3_${tag}`.slice(0, 30), displayName: 'p3' },
    });
    createdUserIds.push(user.id);
    const subject = `p3-dupe-${tag}@test.local`;
    await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
    });

    await expect(
      prisma.userAuthIdentity.create({
        data: { userId: user.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('4: the same identity cannot attach to two Users', async () => {
    const tag = uniqueTag('p4');
    const subject = `p4-shared-${tag}@test.local`;
    const userA = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p4a_${tag}`.slice(0, 30), displayName: 'p4a' },
    });
    createdUserIds.push(userA.id);
    await prisma.userAuthIdentity.create({
      data: { userId: userA.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
    });

    const userB = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p4b_${tag}`.slice(0, 30), displayName: 'p4b' },
    });
    createdUserIds.push(userB.id);

    await expect(
      prisma.userAuthIdentity.create({
        data: { userId: userB.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('5: different provider subjects for different Users succeed', async () => {
    const tag = uniqueTag('p5');
    const userA = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p5a_${tag}`.slice(0, 30), displayName: 'p5a' },
    });
    createdUserIds.push(userA.id);
    const userB = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p5b_${tag}`.slice(0, 30), displayName: 'p5b' },
    });
    createdUserIds.push(userB.id);

    await prisma.userAuthIdentity.create({
      data: { userId: userA.id, provider: 'TELEGRAM', providerSubject: `${tag}-a`, verifiedAt: null },
    });
    await prisma.userAuthIdentity.create({
      data: { userId: userB.id, provider: 'TELEGRAM', providerSubject: `${tag}-b`, verifiedAt: null },
    });

    const count = await prisma.userAuthIdentity.count({ where: { provider: 'TELEGRAM', providerSubject: { in: [`${tag}-a`, `${tag}-b`] } } });
    expect(count).toBe(2);
  });

  it('6: deleting a User cascades its identities', async () => {
    const tag = uniqueTag('p6');
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p6_${tag}`.slice(0, 30), displayName: 'p6' },
    });
    await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'EMAIL', providerSubject: `p6-${tag}@test.local`, verifiedAt: null },
    });

    const before = await prisma.userAuthIdentity.count({ where: { userId: user.id } });
    expect(before).toBe(1);

    await prisma.user.delete({ where: { id: user.id } });

    const after = await prisma.userAuthIdentity.count({ where: { userId: user.id } });
    expect(after).toBe(0);
  });

  it('7: deleting an identity does NOT delete the User', async () => {
    const tag = uniqueTag('p7');
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p7_${tag}`.slice(0, 30), displayName: 'p7' },
    });
    createdUserIds.push(user.id);
    const identity = await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'EMAIL', providerSubject: `p7-${tag}@test.local`, verifiedAt: null },
    });

    await prisma.userAuthIdentity.delete({ where: { id: identity.id } });

    const stillThere = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stillThere).not.toBeNull();
  });

  it('8: a legacy EMAIL identity has verifiedAt = null and must not be treated as verified', async () => {
    const tag = uniqueTag('p8');
    const user = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p8_${tag}`.slice(0, 30), displayName: 'p8' },
    });
    createdUserIds.push(user.id);
    createdSubjects.push(`p8-${tag}@test.local`);

    const identity = await prisma.userAuthIdentity.create({
      data: { userId: user.id, provider: 'EMAIL', providerSubject: `p8-${tag}@test.local`, verifiedAt: null },
    });
    expect(identity.verifiedAt).toBeNull();
  });

  it('9: case-different EMAIL subjects coexist on different legal Users (no normalization)', async () => {
    const tag = uniqueTag('p9');

    // Only the leading B/b case differs, on otherwise identical subjects.
    const subjectA = `Bob${tag}@x.com`;
    const subjectB = `bob${tag}@x.com`;

    const userA = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p9a_${tag}`.slice(0, 30), displayName: 'p9a' },
    });
    createdUserIds.push(userA.id);
    const userB = await prisma.user.create({
      data: { email: null, passwordHash: null, username: `id42_p9b_${tag}`.slice(0, 30), displayName: 'p9b' },
    });
    createdUserIds.push(userB.id);

    await prisma.userAuthIdentity.create({
      data: { userId: userA.id, provider: 'EMAIL', providerSubject: subjectA, verifiedAt: null },
    });
    await prisma.userAuthIdentity.create({
      data: { userId: userB.id, provider: 'EMAIL', providerSubject: subjectB, verifiedAt: null },
    });

    const a = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'EMAIL', providerSubject: subjectA } },
    });
    const b = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'EMAIL', providerSubject: subjectB } },
    });

    expect(subjectA !== subjectB).toBe(true);
    expect(a?.providerSubject).toBe(subjectA);
    expect(b?.providerSubject).toBe(subjectB);
    expect(a?.userId).toBe(userA.id);
    expect(b?.userId).toBe(userB.id);
  });

  // ─── CONCURRENCY (10 rounds each) ───────────────────────────

  it('C: 10 rounds of concurrent direct identity inserts (same provider+subject, different Users) — exactly one succeeds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const tag = uniqueTag('rc');
      const subject = `c-${tag}@test.local`;

      const userA = await prisma.user.create({
        data: { email: null, passwordHash: null, username: `id42_ca_${tag}`.slice(0, 30), displayName: 'ca' },
      });
      createdUserIds.push(userA.id);
      const userB = await prisma.user.create({
        data: { email: null, passwordHash: null, username: `id42_cb_${tag}`.slice(0, 30), displayName: 'cb' },
      });
      createdUserIds.push(userB.id);

      const results = await Promise.allSettled([
        prisma.userAuthIdentity.create({
          data: { userId: userA.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
        }),
        prisma.userAuthIdentity.create({
          data: { userId: userB.id, provider: 'EMAIL', providerSubject: subject, verifiedAt: null },
        }),
      ]);

      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      expect(okCount).toBe(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length) {
        expect((rejected[0] as PromiseRejectedResult).reason?.code ?? '').toBe('P2002');
      }

      const rows = await prisma.userAuthIdentity.count({ where: { providerSubject: subject } });
      expect(rows).toBe(1);
    }
  });

  it('D: 10 rounds of concurrent direct identity inserts (same provider, different subjects) — both succeed', async () => {
    for (let round = 0; round < 10; round += 1) {
      const tag = uniqueTag('rd');
      const user = await prisma.user.create({
        data: { email: null, passwordHash: null, username: `id42_d_${tag}`.slice(0, 30), displayName: 'd' },
      });
      createdUserIds.push(user.id);

      const [r1, r2] = await Promise.all([
        prisma.userAuthIdentity.create({
          data: { userId: user.id, provider: 'EMAIL', providerSubject: `d1-${tag}@test.local`, verifiedAt: null },
        }),
        prisma.userAuthIdentity.create({
          data: { userId: user.id, provider: 'EMAIL', providerSubject: `d2-${tag}@test.local`, verifiedAt: null },
        }),
      ]);

      expect(r1.providerSubject).toContain('d1-');
      expect(r2.providerSubject).toContain('d2-');
      const rows = await prisma.userAuthIdentity.count({
        where: { userId: user.id, provider: 'EMAIL', providerSubject: { in: [`d1-${tag}@test.local`, `d2-${tag}@test.local`] } },
      });
      expect(rows).toBe(2);
    }
  });
});