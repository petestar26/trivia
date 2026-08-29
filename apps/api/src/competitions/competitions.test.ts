import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  createCompetition,
  updateCompetition,
  cancelCompetition,
  joinCompetition,
  playCompetition,
  finalizeCompetition,
  getCompetitionForGroup,
  listCompetitionsForGroup,
} from './competition-service';
import { getOrCreateWallet, getWalletBalance, executeBalanceChange } from '../economy/wallet-service';
import { ensureGameDefinitions } from '../games/game-catalog';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `comp-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `comp_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Comp ${tag}`,
    },
  });
}

async function createGroup(ownerId: string, name: string) {
  return prisma.group.create({
    data: {
      ownerId,
      name,
      description: `Test group: ${name}`,
    },
  });
}

async function addMember(groupId: string, userId: string, role = 'MEMBER') {
  return prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: { status: 'ACTIVE', role: role as any },
    create: { groupId, userId, role: role as any, status: 'ACTIVE' },
  });
}

async function primeGamePoints(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [{
      currency: 'GAME_POINTS',
      amount,
      ledgerType: 'CREDIT',
      transactionType: 'GAME_POINT_CREDIT',
      referenceType: 'ADMIN',
      description: 'Test fixture game points',
    }],
    operationName: 'test_fund_gp',
  });
}

async function cleanCompFixtures() {
  const users = await prisma.user.findMany({ where: { email: { contains: '@comp-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const comps = await prisma.groupCompetition.findMany({
      where: { createdBy: { in: userIds } },
      select: { id: true },
    });
    const compIds = comps.map((c) => c.id);
    if (compIds.length) {
      await prisma.competitionParticipant.deleteMany({ where: { competitionId: { in: compIds } } });
      await prisma.groupCompetition.deleteMany({ where: { id: { in: compIds } } });
    }

    await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.gameSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.group.deleteMany({ where: { name: { startsWith: 'Comp Test' } } });
}

// ─── CREATE COMPETITION ────────────────────────────────────────

describeIf('Create competition', () => {
  let owner: { id: string };
  let member: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('owner1');
    member = await createUser('member1');
    group = await createGroup(owner.id, 'Comp Test Group');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, member.id, 'MEMBER');
    await ensureGameDefinitions();
  });

  it('creates a scheduled competition', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Dice Showdown',
      description: 'Best dice roller wins!',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
      entryAmount: 10,
      rewardGamePoints: 100,
      rewardCoins: 50,
    });

    expect(comp.status).toBe('SCHEDULED');
    expect(comp.title).toBe('Dice Showdown');
    expect(comp.entryAmount).toBe(10);
    expect(comp.rewardGamePoints).toBe(100);
    expect(comp.rewardCoins).toBe(50);
    expect(comp.scoring).toBe('DICE_SUM');
  });

  it('rejects non-manager creating competition', async () => {
    const now = new Date();
    await expect(
      createCompetition(member.id, {
        groupId: group.id,
        gameKey: 'dice',
        title: 'Unauthorized Comp',
        startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 3600000).toISOString(),
      })
    ).rejects.toThrow();
  });

  it('validates title is required', async () => {
    const now = new Date();
    await expect(
      createCompetition(owner.id, {
        groupId: group.id,
        gameKey: 'dice',
        title: '',
        startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 3600000).toISOString(),
      })
    ).rejects.toThrow();
  });

  it('validates end after start', async () => {
    const now = new Date();
    await expect(
      createCompetition(owner.id, {
        groupId: group.id,
        gameKey: 'dice',
        title: 'Bad Dates',
        startsAt: new Date(now.getTime() + 3600000).toISOString(),
        endsAt: now.toISOString(),
      })
    ).rejects.toThrow();
  });

  it('validates entry amount is non-negative integer', async () => {
    const now = new Date();
    await expect(
      createCompetition(owner.id, {
        groupId: group.id,
        gameKey: 'dice',
        title: 'Bad Entry',
        startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 3600000).toISOString(),
        entryAmount: -5,
      })
    ).rejects.toThrow();
  });
});

// ─── UPDATE COMPETITION ────────────────────────────────────────

describeIf('Update competition', () => {
  let owner: { id: string };
  let member: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('uowner');
    member = await createUser('umember');
    group = await createGroup(owner.id, 'Comp Test Update');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, member.id, 'MEMBER');
    await ensureGameDefinitions();
  });

  it('owner can update scheduled competition', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Before Update',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    const updated = await updateCompetition(owner.id, comp.id, {
      title: 'After Update',
      rewardGamePoints: 200,
    });

    expect(updated.title).toBe('After Update');
    expect(updated.rewardGamePoints).toBe(200);
  });

  it('member cannot update competition', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Member Cannot Update',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    await expect(updateCompetition(member.id, comp.id, { title: 'Hacked' })).rejects.toThrow();
  });
});

// ─── CANCEL COMPETITION ────────────────────────────────────────

describeIf('Cancel competition', () => {
  let owner: { id: string };
  let player: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('cowner');
    player = await createUser('cplayer');
    group = await createGroup(owner.id, 'Comp Test Cancel');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeGamePoints(player.id, 500);
  });

  it('cancels and refunds entry fees', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Cancel Me',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
      entryAmount: 50,
    });

    await joinCompetition(player.id, comp.id);

    const before = (await getWalletBalance(player.id)).gamePointsBalance;
    const result = await cancelCompetition(owner.id, comp.id);
    expect(result.status).toBe('CANCELLED');

    const after = (await getWalletBalance(player.id)).gamePointsBalance;
    expect(after).toBe(before + 50); // refund
  });
});

// ─── JOIN COMPETITION ──────────────────────────────────────────

describeIf('Join competition', () => {
  let owner: { id: string };
  let player: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('jowner');
    player = await createUser('jplayer');
    group = await createGroup(owner.id, 'Comp Test Join');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeGamePoints(player.id, 500);
  });

  it('joins a competition and debits entry', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Join Me',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
      entryAmount: 25,
    });

    const before = (await getWalletBalance(player.id)).gamePointsBalance;
    await joinCompetition(player.id, comp.id);
    const after = (await getWalletBalance(player.id)).gamePointsBalance;
    expect(after).toBe(before - 25);
  });

  it('rejects duplicate join', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'No Double Join',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    await joinCompetition(player.id, comp.id);
    await expect(joinCompetition(player.id, comp.id)).rejects.toThrow();
  });
});

// ─── PLAY COMPETITION ──────────────────────────────────────────

describeIf('Play competition', () => {
  let owner: { id: string };
  let player: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('powner');
    player = await createUser('pplayer');
    group = await createGroup(owner.id, 'Comp Test Play');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeGamePoints(player.id, 500);
  });

  it('plays a turn and accumulates score', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Play Dice',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    await joinCompetition(player.id, comp.id);

    const result = await playCompetition(player.id, comp.id);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeLessThanOrEqual(12);
    expect(result.gamesPlayed).toBe(1);
  });

  it('rejects playing without joining first', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Must Join First',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    const other = await createUser('pother');
    await expect(playCompetition(other.id, comp.id)).rejects.toThrow();
  });
});

// ─── FINALIZE COMPETITION ──────────────────────────────────────

describeIf('Finalize competition', () => {
  let owner: { id: string };
  let player1: { id: string };
  let player2: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('fowner');
    player1 = await createUser('fplayer1');
    player2 = await createUser('fplayer2');
    group = await createGroup(owner.id, 'Comp Test Finalize');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player1.id, 'MEMBER');
    await addMember(group.id, player2.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeGamePoints(player1.id, 500);
    await primeGamePoints(player2.id, 500);
  });

  it('finalizes competition and computes leaderboard', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Finalize Test',
      startsAt: new Date(now.getTime() - 7200000).toISOString(),
      endsAt: now.toISOString(),
      entryAmount: 10,
      rewardGamePoints: 100,
    });

    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);

    await playCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id);
    await playCompetition(player2.id, comp.id);

    const result = await finalizeCompetition(owner.id, comp.id);
    expect(result.status).toBe('COMPLETED');
    expect(result.alreadyFinalized).toBe(false);
    expect(result.result).toHaveProperty('participants');
  });

  it('idempotent: second finalize returns alreadyFinalized', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Idempotent Finalize',
      startsAt: new Date(now.getTime() - 7200000).toISOString(),
      endsAt: now.toISOString(),
      entryAmount: 0,
      rewardGamePoints: 50,
    });

    await joinCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id);
    await finalizeCompetition(owner.id, comp.id);

    const second = await finalizeCompetition(owner.id, comp.id);
    expect(second.alreadyFinalized).toBe(true);
  });

  it('non-manager cannot finalize', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Owner Only Finalize',
      startsAt: new Date(now.getTime() - 7200000).toISOString(),
      endsAt: now.toISOString(),
    });

    await joinCompetition(player1.id, comp.id);
    await expect(finalizeCompetition(player1.id, comp.id)).rejects.toThrow();
  });

  it('awards rewards to winners and creates notifications', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Reward Finalize',
      startsAt: new Date(now.getTime() - 7200000).toISOString(),
      endsAt: now.toISOString(),
      entryAmount: 0,
      rewardGamePoints: 200,
      rewardCoins: 100,
    });

    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);

    await playCompetition(player1.id, comp.id);
    await playCompetition(player2.id, comp.id);

    const before1 = (await getWalletBalance(player1.id)).gamePointsBalance;
    const before2 = (await getWalletBalance(player2.id)).gamePointsBalance;

    const result = await finalizeCompetition(owner.id, comp.id);
    expect(result.status).toBe('COMPLETED');

    const after1 = (await getWalletBalance(player1.id)).gamePointsBalance;
    const after2 = (await getWalletBalance(player2.id)).gamePointsBalance;

    const totalAwarded = (after1 - before1) + (after2 - before2);
    expect(totalAwarded).toBe(200);

    const notifs = await prisma.notification.findMany({
      where: {
        type: 'COMPETITION_RESULT',
        data: { path: ['competitionId'], equals: comp.id },
      },
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── LIST / GET COMPETITION ────────────────────────────────────

describeIf('List and get competition', () => {
  let owner: { id: string };
  let member: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('lowner');
    member = await createUser('lmember');
    group = await createGroup(owner.id, 'Comp Test List');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, member.id, 'MEMBER');
    await ensureGameDefinitions();
  });

  it('lists competitions for group', async () => {
    const now = new Date();
    await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'List Test 1',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    const list = await listCompetitionsForGroup(group.id, member.id);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('gets competition detail with participants', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Detail Test',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    });

    await joinCompetition(member.id, comp.id);

    const detail = await getCompetitionForGroup(group.id, comp.id, member.id);
    expect(detail.title).toBe('Detail Test');
    expect(detail.participants.length).toBeGreaterThanOrEqual(1);
  });

  it('non-member cannot list competitions', async () => {
    const outsider = await createUser('outsider');
    await expect(listCompetitionsForGroup(group.id, outsider.id)).rejects.toThrow();
  });
});
