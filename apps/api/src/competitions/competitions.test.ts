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
import { getOrCreateWallet, getWalletBalance, executeBalanceChange, applyBalanceChanges } from '../economy/wallet-service';
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

async function primeCoins(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [{
      currency: 'COINS',
      amount,
      ledgerType: 'CREDIT',
      transactionType: 'COIN_CREDIT',
      referenceType: 'ADMIN',
      description: 'Test fixture coins',
    }],
    operationName: 'test_fund_coins',
  });
}

// Competition prizes are creator-funded and escrowed at creation time, so any
// fixture that creates a competition WITH a prize must fund its creator first.
async function primeCreator(userId: string, gp = 100_000, coins = 100_000) {
  await primeGamePoints(userId, gp);
  await primeCoins(userId, coins);
}

/**
 * Net movement of a competition's PRIZE escrow across the whole wallet ledger.
 *
 * Every prize movement — the escrow debit at creation, update deltas, winner
 * payouts, and creator refunds — is tagged referenceType 'REWARD' with the
 * competition id, while entry fees are tagged 'GAME'. So for any fully settled
 * competition this must net to exactly zero: every escrowed unit came back out
 * once and only once. A positive result means money was created; a negative
 * result means money was stranded.
 */
async function prizeLedgerNet(competitionId: string) {
  const rows = await prisma.walletTransaction.findMany({
    where: { referenceType: 'REWARD', referenceId: competitionId },
    select: { ledgerType: true, currency: true, amount: true },
  });
  let gp = 0;
  let coins = 0;
  for (const r of rows) {
    const signed = (r.ledgerType === 'CREDIT' ? 1 : -1) * r.amount;
    if (r.currency === 'GAME_POINTS') gp += signed;
    else coins += signed;
  }
  return { gp, coins };
}

async function cleanCompFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'comp-' } } });
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

    // Groups MUST be deleted before their owners. Group.ownerId references
    // User.id with onDelete: Restrict (schema.prisma), so deleting a user who
    // still owns a group raises a foreign-key violation and aborts this whole
    // cleanup — leaving stale fixtures behind and failing beforeAll.
    //
    // Scoped by ownerId (drawn from the SAME userIds this whole function
    // already scopes every other deletion by), NOT by a literal name prefix.
    // A name filter silently misses any group whose fixture used a different
    // title string — which is exactly what broke this on a reused database:
    // the "Trivia post-finalization scoring" describe block below creates its
    // group as 'Comp Trivia Finalize Race', which does not start with
    // 'Comp Test'. That group survived every previous cleanup, so on the next
    // run its owner (a `comp-` user, correctly matched into userIds) failed
    // to delete with `groups_ownerId_fkey`. Filtering by ownerId instead
    // makes cleanup correct for every group any fixture in this file creates,
    // present or future, without maintaining a list of name literals.
    await prisma.group.deleteMany({ where: { ownerId: { in: userIds } } });

    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  // Defensive fallback only: sweep any leftover 'Comp Test'-prefixed group
  // whose owner is no longer a `comp-` user (e.g. cleanup was interrupted
  // mid-run before reaching the ownerId-scoped delete above). Group.ownerId
  // is onDelete: Restrict, so this can only ever match a group whose owner
  // still exists — it cannot reach into another suite's data by name
  // collision alone without also owning that name, which no other suite does.
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
    await primeCreator(owner.id);
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
    await primeCreator(owner.id);
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
    await primeCreator(owner.id);
    await primeGamePoints(player1.id, 500);
    await primeGamePoints(player2.id, 500);
  });

  // These tests need the competition OPEN (joinable/playable) at creation
  // time, and only ENDED once join/play are done and finalize is about to
  // run. A single static `endsAt: now` cannot satisfy both — by the time
  // join() executes, real time has already advanced past that timestamp
  // (joinCompetition requires now <= endsAt), which is exactly why these
  // four tests failed with "Competition has ended" INSIDE joinCompetition,
  // not inside finalizeCompetition. joinCompetition's and finalizeCompetition's
  // own guards are both correct; this was a test-timing defect.
  //
  // Fix: create with a safely-future endsAt (mirrors futureWindow()/forceEnd()
  // used elsewhere in this file), join/play while the window is genuinely
  // open, then explicitly push endsAt into the past right before finalizing.
  const futureWindow = () => {
    const now = new Date();
    return {
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
  };

  async function forceEnd(competitionId: string) {
    await prisma.groupCompetition.update({
      where: { id: competitionId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
  }

  it('finalizes competition and computes leaderboard', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Finalize Test',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 10,
      rewardGamePoints: 100,
    });

    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);

    await playCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id);
    await playCompetition(player2.id, comp.id);

    await forceEnd(comp.id);
    const result = await finalizeCompetition(owner.id, comp.id);
    expect(result.status).toBe('COMPLETED');
    expect(result.alreadyFinalized).toBe(false);
    expect(result.result).toHaveProperty('participants');
  });

  it('idempotent: second finalize returns alreadyFinalized', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Idempotent Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 50,
    });

    await joinCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id);
    await forceEnd(comp.id);
    await finalizeCompetition(owner.id, comp.id);

    const second = await finalizeCompetition(owner.id, comp.id);
    expect(second.alreadyFinalized).toBe(true);
  });

  it('non-manager cannot finalize', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Owner Only Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
    });

    await joinCompetition(player1.id, comp.id);
    await forceEnd(comp.id);
    await expect(finalizeCompetition(player1.id, comp.id)).rejects.toThrow();
  });

  it('awards rewards to winners and creates notifications', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Reward Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
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

    await forceEnd(comp.id);
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

// ─── TRIVIA COMPETITION ──────────────────────────────────────────

describeIf('Trivia competition', () => {
  let owner: { id: string };
  let player: { id: string };
  let group: { id: string };
  let competitionId: string;

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('towner');
    player = await createUser('tplayer');
    group = await createGroup(owner.id, 'Comp Test Trivia');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeCreator(owner.id);
    await primeGamePoints(player.id, 5000);

    // Create a trivia competition
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title: 'Trivia Test',
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
      entryAmount: 10,
      rewardGamePoints: 100,
    });
    competitionId = comp.id;
    await joinCompetition(player.id, competitionId);
  });

  it('Phase 1: serves a random trivia question without correctIndex', async () => {
    const result = await playCompetition(player.id, competitionId);
    expect(result).toHaveProperty('phase', 'question');
    expect(result).toHaveProperty('question');
    expect(result.question).toHaveProperty('id');
    expect(result.question).toHaveProperty('question');
    expect(result.question).toHaveProperty('choices');
    expect(result.question).toHaveProperty('category');
    expect(result.question).toHaveProperty('difficulty');
    expect(result.question).not.toHaveProperty('correctIndex');
  });

  it('Phase 2: scores a correct answer and increments score', async () => {
    // First, get a question
    const phase1 = await playCompetition(player.id, competitionId);
    expect(phase1.phase).toBe('question');
    const questionId = phase1.question!.id;

    // Find the correct answer by checking the database
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    const correctAnswer = q!.correctIndex;

    // Phase 2: submit correct answer
    const result = await playCompetition(player.id, competitionId, {
      questionId,
      answerIndex: correctAnswer,
    });

    expect(result).toHaveProperty('phase', 'answer');
    expect(result.score).toBe(1000);
    expect(result.result).toEqual({ questionId, answerIndex: correctAnswer, correct: true });
    expect(result.accumulatedScore).toBe(1000);
    expect(result.gamesPlayed).toBe(1);
  });

  it('Phase 2: wrong answer awards zero score', async () => {
    const phase1 = await playCompetition(player.id, competitionId);
    const questionId = phase1.question!.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    const wrongAnswer = (q!.correctIndex + 1) % q!.choices.length;

    const result = await playCompetition(player.id, competitionId, {
      questionId,
      answerIndex: wrongAnswer,
    });

    expect(result.phase).toBe('answer');
    expect(result.score).toBe(0);
    expect(result.result.correct).toBe(false);
    // Score should not increment, but gamesPlayed should increment
    expect(result.accumulatedScore).toBe(1000); // previous score
    expect(result.gamesPlayed).toBe(2);
  });

  it('rejects duplicate attempt on same question in same competition', async () => {
    const phase1 = await playCompetition(player.id, competitionId);
    const questionId = phase1.question!.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    const correctAnswer = q!.correctIndex;

    // First attempt
    await playCompetition(player.id, competitionId, { questionId, answerIndex: correctAnswer });

    // Second attempt on same question
    await expect(
      playCompetition(player.id, competitionId, { questionId, answerIndex: correctAnswer })
    ).rejects.toThrow('already answered this question in this competition');
  });

  // Every test above this point deliberately shares the describe-level
  // `competitionId`/`player`, so their `accumulatedScore` assertions form a
  // running total that depends on exactly how many earlier tests in this
  // block scored correctly (Phase 2 correct: +1000, wrong-answer test: +0,
  // duplicate-attempt test's first successful attempt: +1000 — 2000 total
  // by this point). The two tests below previously reused that SAME shared
  // participant but asserted fixed absolute totals (1000, then 2000) as if
  // they were the first and second scored questions — they were actually the
  // 3rd and 5th, so the real totals were 3000 and 5000. That mismatch is a
  // test-isolation defect, not a scoring defect: playTriviaCompetitionRound
  // was accumulating correctly the whole time.
  //
  // Fix: give each of these two tests its OWN fresh competition + participant
  // so the expected score transition is self-contained and cannot be
  // polluted by however many prior tests in this file happened to score.
  async function freshTriviaParticipant(tag: string) {
    const p = await createUser(tag);
    // joinCompetition -> assertActiveMember requires an ACTIVE GroupMember
    // row. createUser() only creates the user; it establishes no group
    // relationship, so a fresh user here was never a member of `group` and
    // joinCompetition legitimately rejected with "You are not a member of
    // this group." addMember() is the same helper beforeAll already uses to
    // seat owner/player in this group.
    await addMember(group.id, p.id, 'MEMBER');
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title: `Trivia Isolated ${tag}`,
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      entryAmount: 0,
    });
    await joinCompetition(p.id, comp.id);
    return { userId: p.id, competitionId: comp.id };
  }

  it('concurrent duplicate submissions cannot double-score', async () => {
    const { userId, competitionId: compId } = await freshTriviaParticipant('tdupe');

    const phase1 = await playCompetition(userId, compId);
    const questionId = phase1.question!.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    const correctAnswer = q!.correctIndex;

    // Fire concurrent requests
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        playCompetition(userId, compId, { questionId, answerIndex: correctAnswer })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    // Verify score only incremented once, from a known-fresh baseline of 0.
    const participant = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: compId, userId } },
    });
    expect(participant!.score).toBe(1000);
  });

  it('allows different questions to be attempted', async () => {
    const { userId, competitionId: compId } = await freshTriviaParticipant('tmulti');

    // Answer first question
    let phase1 = await playCompetition(userId, compId);
    let questionId = phase1.question!.id;
    const q1 = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    await playCompetition(userId, compId, { questionId, answerIndex: q1!.correctIndex });

    // Get a different question (Phase 1 should skip already-answered)
    phase1 = await playCompetition(userId, compId);
    expect(phase1.question!.id).not.toBe(q1!.id);

    const q2 = await prisma.triviaQuestion.findUnique({ where: { id: phase1.question!.id } });
    const result = await playCompetition(userId, compId, {
      questionId: phase1.question!.id,
      answerIndex: q2!.correctIndex,
    });

    // Known-fresh baseline: first question +1000, second question +1000.
    expect(result.score).toBe(1000);
    expect(result.accumulatedScore).toBe(2000);
  });

  // Both tests below need to exercise PLAY rejection, not JOIN rejection.
  // The previous versions built the competition already in the invalid
  // state and then called joinCompetition() — but joinCompetition applies
  // the identical startsAt/endsAt guard, so it threw the very same error
  // first, before playCompetition (the function actually under test) ever
  // ran. Fixed by joining while the window is genuinely open, THEN
  // transitioning the row into the invalid state (mirroring forceEnd(),
  // the established pattern used elsewhere in this file for the same
  // purpose), THEN calling play.
  async function forceEnd(competitionId: string) {
    await prisma.groupCompetition.update({
      where: { id: competitionId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
  }

  async function forceNotYetStarted(competitionId: string) {
    await prisma.groupCompetition.update({
      where: { id: competitionId },
      data: {
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
      },
    });
  }

  it('rejects play after competition has ended', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title: 'Ended Trivia',
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      entryAmount: 0,
    });

    await joinCompetition(player.id, comp.id);
    await forceEnd(comp.id);
    await expect(playCompetition(player.id, comp.id)).rejects.toThrow('Competition has ended');
  });

  it('rejects play when competition is not playable', async () => {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title: 'Scheduled Trivia',
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      entryAmount: 0,
    });

    await joinCompetition(player.id, comp.id);
    await forceNotYetStarted(comp.id);
    await expect(playCompetition(player.id, comp.id)).rejects.toThrow('Competition has not started yet');
  });

  it('rejects fake score from client', async () => {
    const phase1 = await playCompetition(player.id, competitionId);
    const questionId = phase1.question!.id;
    // Derive a guaranteed-wrong answer from the actual question, matching the
    // pattern used by 'Phase 2: wrong answer awards zero score' above. The
    // previous hardcoded `answerIndex: 0` was only wrong for questions whose
    // correctIndex happened to be non-zero; part of the seeded pool has
    // correctIndex 0, and Phase 1 serves a random question, so this test
    // intermittently submitted a CORRECT answer and legitimately scored 1000.
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    const wrongAnswer = (q!.correctIndex + 1) % q!.choices.length;

    // Client tries to manipulate by sending fake score in clientData
    // (The backend ignores client-provided score and computes server-side)
    const result = await playCompetition(player.id, competitionId, {
      questionId,
      answerIndex: wrongAnswer,
      // Attempt to inject fake score (should be ignored)
      score: 999999,
      reward: 999999,
    });

    // Should still award 0 for wrong answer
    expect(result.score).toBe(0);
  });
});

// ─── P0 REGRESSION: MUTABLE entryAmount / UNBACKED REFUND ───────
//
// Prior to this fix, cancelCompetition refunded every participant using the
// competition's LIVE entryAmount rather than what they actually paid at join.
// Because entryAmount had no participant-join lock, a manager could:
//   join (paying 0) -> raise entryAmount -> cancel -> mint an unbacked refund
// or:
//   join (paying N) -> lower/zero entryAmount -> cancel -> destroy that N
//
// The fix has two independent parts, both covered here:
//   1. CompetitionParticipant.entryPaid records what was ACTUALLY debited at
//      join, and cancelCompetition refunds THAT field, never entryAmount.
//   2. entryAmount (like the prize) is locked once any participant has joined,
//      so the exploit's setup step can no longer even be performed through
//      the public API.
// Part 1 is tested with a direct, deliberate bypass of part 2 (a raw
// competition-row mutation simulating a hypothetical future code path that
// changes entryAmount post-join) specifically to prove the refund mechanism
// itself is correct in depth, not merely that today's single call path to it
// is blocked.

describeIf('Competition entry-fee accounting (entryPaid) — P0 fix', () => {
  let owner: { id: string };
  let player1: { id: string };
  let player2: { id: string };
  let group: { id: string };

  const futureWindow = () => {
    const now = new Date();
    return {
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    };
  };

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('epowner');
    player1 = await createUser('epplayer1');
    player2 = await createUser('epplayer2');
    group = await createGroup(owner.id, 'Comp Test Entry Paid');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player1.id, 'MEMBER');
    await addMember(group.id, player2.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeGamePoints(player1.id, 5_000);
    await primeGamePoints(player2.id, 5_000);
  });

  it('records entryPaid exactly matching what was debited at join', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Entry Paid Recorded',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 75,
    });

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id);
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(before - 75);

    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player1.id } },
    });
    expect(p!.entryPaid).toBe(75);
  });

  it('rejects changing entryAmount once a participant has joined', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Entry Locked After Join',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 50,
    });

    await joinCompetition(player1.id, comp.id);

    // This is the exact setup step of the original exploit chain — it must no
    // longer be reachable at all.
    await expect(
      updateCompetition(owner.id, comp.id, { entryAmount: 999_000_000 })
    ).rejects.toThrow(/after participants have joined/i);

    const fresh = await prisma.groupCompetition.findUnique({ where: { id: comp.id } });
    expect(fresh!.entryAmount).toBe(50);
  });

  it('allows changing entryAmount before anyone has joined, and the new amount is what gets collected', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Entry Adjustable Pre-Join',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 50,
    });

    await updateCompetition(owner.id, comp.id, { entryAmount: 120 });

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id);
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(before - 120);

    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player1.id } },
    });
    expect(p!.entryPaid).toBe(120);
  });

  it('P0: cancel cannot mint currency even if entryAmount is raised after collection (defense in depth)', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Exploit Attempt: Raise Then Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
    });

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id); // pays 0, entryPaid recorded as 0

    // Simulate a hypothetical future code path (or a direct DB compromise)
    // that manages to bypass the public API's join-lock and raises
    // entryAmount post-collection anyway. The refund mechanism itself — not
    // just the lock in front of it — must remain safe.
    await prisma.groupCompetition.update({
      where: { id: comp.id },
      data: { entryAmount: 500_000 },
    });

    await cancelCompetition(owner.id, comp.id);

    // No currency was minted: the participant paid 0 and is refunded 0,
    // because the refund reads entryPaid (0), never the tampered entryAmount.
    const after = (await getWalletBalance(player1.id)).gamePointsBalance;
    expect(after).toBe(before);
  });

  it('P0: cancel cannot destroy participant funds even if entryAmount is zeroed after collection (defense in depth)', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Exploit Attempt: Zero Then Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 300,
    });

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id); // pays 300, entryPaid recorded as 300
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(before - 300);

    // Same simulated bypass as above, in the destructive direction.
    await prisma.groupCompetition.update({
      where: { id: comp.id },
      data: { entryAmount: 0 },
    });

    await cancelCompetition(owner.id, comp.id);

    // The participant's 300 is NOT destroyed: refund reads entryPaid (300),
    // never the tampered entryAmount (0).
    const after = (await getWalletBalance(player1.id)).gamePointsBalance;
    expect(after).toBe(before);
  });

  it('cancel refunds each participant their OWN entryPaid when amounts differ across joins', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Mixed Entry Amounts',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 40,
    });

    const p1Before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id); // entryPaid = 40

    // A second, differently-priced join is not reachable through the normal
    // API once player1 has joined (the lock above prevents it) — construct it
    // directly to prove refunds are correctly PER-PARTICIPANT, not a single
    // value read once for the whole competition.
    await getOrCreateWallet(player2.id);
    const p2Before = (await getWalletBalance(player2.id)).gamePointsBalance;
    await prisma.$transaction(async (tx) => {
      await applyBalanceChanges(tx, player2.id, [
        {
          currency: 'GAME_POINTS',
          amount: 999,
          ledgerType: 'DEBIT',
          transactionType: 'GAME_POINT_DEBIT',
          referenceType: 'GAME',
          description: 'test fixture: manual differing entry',
        },
      ]);
      await tx.competitionParticipant.create({
        data: { competitionId: comp.id, userId: player2.id, entryPaid: 999 },
      });
    });
    expect((await getWalletBalance(player2.id)).gamePointsBalance).toBe(p2Before - 999);

    await cancelCompetition(owner.id, comp.id);

    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(p1Before);
    expect((await getWalletBalance(player2.id)).gamePointsBalance).toBe(p2Before);
  });
});

// ─── P0 REGRESSION: PRIZE FUNDING / REWARD MINTING ──────────────
//
// Competition prizes are creator-funded and escrowed at creation. These tests
// pin the economic invariant:
//
//   total competition payouts <= funded (escrowed) prize
//
// and specifically that a participant who never played can never be paid.

describeIf('Competition prize escrow and reward minting (P0)', () => {
  let attacker: { id: string };
  let owner: { id: string };
  let player1: { id: string };
  let player2: { id: string };
  let group: { id: string };
  let attackerGroup: { id: string };

  // Ends a competition without waiting in real time, so finalization paths can
  // be exercised deterministically.
  async function forceEnd(competitionId: string) {
    await prisma.groupCompetition.update({
      where: { id: competitionId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
  }

  const futureWindow = () => {
    const now = new Date();
    return {
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    };
  };

  beforeAll(async () => {
    await cleanCompFixtures();
    attacker = await createUser('p0attacker');
    owner = await createUser('p0owner');
    player1 = await createUser('p0player1');
    player2 = await createUser('p0player2');

    group = await createGroup(owner.id, 'Comp Test P0');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player1.id, 'MEMBER');
    await addMember(group.id, player2.id, 'MEMBER');

    // The attacker's OWN group — reproducing the exact self-service path.
    attackerGroup = await createGroup(attacker.id, 'Comp Test P0 Attacker');
    await addMember(attackerGroup.id, attacker.id, 'OWNER');

    await ensureGameDefinitions();
    await primeCreator(owner.id);
    await primeGamePoints(attacker.id, 50_000);
    await primeCoins(attacker.id, 50_000);
    await primeGamePoints(player1.id, 5_000);
    await primeGamePoints(player2.id, 5_000);
  });

  // ── Test 1 — the original exploit ─────────────────────────────
  it('P0: sole zero-play participant receives NO reward and cannot mint currency', async () => {
    const before = await getWalletBalance(attacker.id);

    const w = futureWindow();
    const comp = await createCompetition(attacker.id, {
      groupId: attackerGroup.id,
      gameKey: 'dice',
      title: 'Free Money',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 10_000,
      rewardCoins: 10_000,
    });

    // Prize is escrowed immediately — the creator is already out of pocket.
    const afterCreate = await getWalletBalance(attacker.id);
    expect(afterCreate.gamePointsBalance).toBe(before.gamePointsBalance - 10_000);
    expect(afterCreate.coinsBalance).toBe(before.coinsBalance - 10_000);

    // Join as the only participant, and never play.
    await joinCompetition(attacker.id, comp.id);
    await forceEnd(comp.id);

    const result = await finalizeCompetition(attacker.id, comp.id);
    expect(result.status).toBe('COMPLETED');
    expect(result.winnerIds).toEqual([]); // zero-play participant is not a winner

    // Escrow returns to the funder — net effect is exactly zero, NOT a mint.
    const after = await getWalletBalance(attacker.id);
    expect(after.gamePointsBalance).toBe(before.gamePointsBalance);
    expect(after.coinsBalance).toBe(before.coinsBalance);

    // And no reward claim was ever created for the freeloader.
    const claim = await prisma.rewardClaim.findUnique({
      where: {
        userId_sourceType_sourceId: {
          userId: attacker.id,
          sourceType: 'COMPETITION',
          sourceId: comp.id,
        },
      },
    });
    expect(claim).toBeNull();
  });

  // ── Test: creation is refused when the prize is not funded ────
  it('rejects competition creation when the creator cannot fund the prize', async () => {
    const poor = await createUser('p0poor');
    await addMember(attackerGroup.id, poor.id, 'ADMIN');
    await getOrCreateWallet(poor.id);

    const w = futureWindow();
    await expect(
      createCompetition(poor.id, {
        groupId: attackerGroup.id,
        gameKey: 'dice',
        title: 'Unfunded',
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        rewardGamePoints: 999_999,
      })
    ).rejects.toThrow(/Insufficient/i);
  });

  // ── Test 14 — rollback: no competition row on funding failure ─
  it('rolls back the whole creation when prize funding fails', async () => {
    const poor = await createUser('p0poor2');
    await addMember(attackerGroup.id, poor.id, 'ADMIN');
    await getOrCreateWallet(poor.id);

    const w = futureWindow();
    await expect(
      createCompetition(poor.id, {
        groupId: attackerGroup.id,
        gameKey: 'dice',
        title: 'Rollback Probe',
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        rewardGamePoints: 999_999,
      })
    ).rejects.toThrow();

    // The competition must NOT exist — creation and funding are atomic.
    const orphan = await prisma.groupCompetition.findFirst({
      where: { title: 'Rollback Probe' },
    });
    expect(orphan).toBeNull();
  });

  // ── Test 2 / 3 — participation rules ──────────────────────────
  it('pays a participant who actually played (zero score still counts as participation)', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Real Play',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 300,
    });

    await joinCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id); // gamesPlayed -> 1

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;
    await forceEnd(comp.id);
    const result = await finalizeCompetition(owner.id, comp.id);

    expect(result.winnerIds).toContain(player1.id);
    const after = (await getWalletBalance(player1.id)).gamePointsBalance;
    expect(after).toBe(before + 300);
  });

  it('does not pay a joiner who never played when another participant did', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Freeloader Excluded',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 400,
    });

    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);
    await playCompetition(player1.id, comp.id); // only player1 plays

    const before2 = (await getWalletBalance(player2.id)).gamePointsBalance;
    await forceEnd(comp.id);
    const result = await finalizeCompetition(owner.id, comp.id);

    expect(result.winnerIds).toEqual([player1.id]);
    const after2 = (await getWalletBalance(player2.id)).gamePointsBalance;
    expect(after2).toBe(before2); // freeloader gets nothing
  });

  // ── Test 4 — no participants at all ───────────────────────────
  it('pays nobody and refunds the funder when there are no participants', async () => {
    const before = (await getWalletBalance(owner.id)).gamePointsBalance;

    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Empty Competition',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 750,
    });

    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(before - 750);

    await forceEnd(comp.id);
    const result = await finalizeCompetition(owner.id, comp.id);
    expect(result.winnerIds).toEqual([]);

    // Full escrow released — nothing stranded.
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(before);
  });

  // ── Test 6 — tie splitting, including the remainder ───────────
  it('splits a tie and returns the floor-division remainder to the funder', async () => {
    const w = futureWindow();
    // 101 GP across 2 tied winners -> 50 each, 1 GP remainder back to funder.
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Tie Split',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 101,
    });

    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);

    // Both genuinely play (dice scores are random), then scores are pinned to
    // an exact tie so the split arithmetic is deterministic. gamesPlayed stays
    // > 0 for both, which is what makes them eligible.
    await playCompetition(player1.id, comp.id);
    await playCompetition(player2.id, comp.id);
    for (const p of [player1, player2]) {
      await prisma.competitionParticipant.update({
        where: { competitionId_userId: { competitionId: comp.id, userId: p.id } },
        data: { score: 7 },
      });
    }

    const b1 = (await getWalletBalance(player1.id)).gamePointsBalance;
    const b2 = (await getWalletBalance(player2.id)).gamePointsBalance;
    const bOwner = (await getWalletBalance(owner.id)).gamePointsBalance;

    await forceEnd(comp.id);
    const result = await finalizeCompetition(owner.id, comp.id);
    expect(result.winnerIds.sort()).toEqual([player1.id, player2.id].sort());

    const a1 = (await getWalletBalance(player1.id)).gamePointsBalance;
    const a2 = (await getWalletBalance(player2.id)).gamePointsBalance;
    const aOwner = (await getWalletBalance(owner.id)).gamePointsBalance;

    expect(a1 - b1).toBe(50);
    expect(a2 - b2).toBe(50);
    expect(aOwner - bOwner).toBe(1); // remainder returned, never stranded

    // Invariant: total paid out never exceeds the funded prize.
    expect((a1 - b1) + (a2 - b2) + (aOwner - bOwner)).toBe(101);
  });

  // ── Tests 7/8/9 — reward validation at CREATE ─────────────────
  it('rejects invalid reward values at creation', async () => {
    const w = futureWindow();
    const bad: Array<[string, unknown]> = [
      ['above maximum', 1_000_001],
      ['negative', -1],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['string', '100' as unknown],
      ['null', null],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ];

    for (const [label, value] of bad) {
      await expect(
        createCompetition(owner.id, {
          groupId: group.id,
          gameKey: 'dice',
          title: `Bad Reward ${label}`,
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          rewardGamePoints: value as number,
        }),
        `rewardGamePoints=${label} must be rejected`
      ).rejects.toThrow();
    }
  });

  // ── Test 10 — update cannot bypass creation-time validation ───
  it('rejects invalid reward values on update', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Update Validation',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 10,
    });

    for (const value of [1_000_001, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        updateCompetition(owner.id, comp.id, { rewardGamePoints: value })
      ).rejects.toThrow();
    }

    // The stored prize is untouched by the rejected updates.
    const fresh = await prisma.groupCompetition.findUnique({ where: { id: comp.id } });
    expect(fresh!.rewardGamePoints).toBe(10);
  });

  it('escrows the difference when a prize is raised, and releases it when lowered', async () => {
    const w = futureWindow();
    const start = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Prize Adjust',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 100,
    });
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(start - 100);

    await updateCompetition(owner.id, comp.id, { rewardGamePoints: 250 });
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(start - 250);

    await updateCompetition(owner.id, comp.id, { rewardGamePoints: 40 });
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(start - 40);

    const fresh = await prisma.groupCompetition.findUnique({ where: { id: comp.id } });
    expect(fresh!.rewardGamePoints).toBe(40);
  });

  // ── Test 11 — prize is locked once players commit ─────────────
  it('refuses to change the prize after a participant has joined', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Locked Prize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 120,
    });

    await joinCompetition(player1.id, comp.id);

    await expect(
      updateCompetition(owner.id, comp.id, { rewardGamePoints: 5 })
    ).rejects.toThrow(/after participants have joined/i);

    const fresh = await prisma.groupCompetition.findUnique({ where: { id: comp.id } });
    expect(fresh!.rewardGamePoints).toBe(120);
  });

  // ── Tests 12/13 — concurrent finalization ─────────────────────
  it('concurrent finalize produces at most one payout', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Concurrent Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 500,
    });

    await joinCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id);
    await forceEnd(comp.id);

    const before = (await getWalletBalance(player1.id)).gamePointsBalance;

    await Promise.allSettled([
      finalizeCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
    ]);

    const after = (await getWalletBalance(player1.id)).gamePointsBalance;
    expect(after).toBe(before + 500); // exactly one payout, never 1000/1500

    const claims = await prisma.rewardClaim.findMany({
      where: { sourceType: 'COMPETITION', sourceId: comp.id },
    });
    expect(claims.length).toBe(1);
  });

  // ── Test 15 — cancellation accounting ─────────────────────────
  it('cancel refunds the full prize escrow and all entry fees exactly', async () => {
    const w = futureWindow();
    const ownerStart = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Cancel Accounting',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 25,
      rewardGamePoints: 600,
    });
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerStart - 600);

    const p1Start = (await getWalletBalance(player1.id)).gamePointsBalance;
    await joinCompetition(player1.id, comp.id);
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(p1Start - 25);

    await cancelCompetition(owner.id, comp.id);

    // Everyone is made exactly whole.
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerStart);
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(p1Start);
  });

  it('CONCURRENCY: concurrent finalize with ZERO participants refunds the creator exactly once', async () => {
    const w = futureWindow();
    const before = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Zero Participants',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 300,
    });
    await forceEnd(comp.id);

    // No RewardClaim is created on this path, so ONLY the atomic competition
    // state claim can prevent a double refund here.
    await Promise.allSettled([
      finalizeCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
    ]);

    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(before);
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: concurrent finalize with all participants zero-play refunds exactly once', async () => {
    const w = futureWindow();
    const before = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race All Zero Play',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 300,
    });
    await joinCompetition(player1.id, comp.id);
    await joinCompetition(player2.id, comp.id);
    await forceEnd(comp.id);

    const p1Before = (await getWalletBalance(player1.id)).gamePointsBalance;
    const p2Before = (await getWalletBalance(player2.id)).gamePointsBalance;

    await Promise.allSettled([
      finalizeCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
    ]);

    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(before);
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(p1Before);
    expect((await getWalletBalance(player2.id)).gamePointsBalance).toBe(p2Before);
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: finalize retried after a zero-winner refund performs no second refund', async () => {
    const w = futureWindow();
    const before = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Retry After Zero Winner',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 250,
    });
    await forceEnd(comp.id);

    await finalizeCompetition(owner.id, comp.id);
    const afterFirst = (await getWalletBalance(owner.id)).gamePointsBalance;
    expect(afterFirst).toBe(before);

    const second = await finalizeCompetition(owner.id, comp.id);
    expect(second.alreadyFinalized).toBe(true);
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(before);
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: cancel racing finalize yields exactly one terminal outcome', async () => {
    const w = futureWindow();
    const ownerBefore = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Cancel vs Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 400,
    });
    await joinCompetition(player1.id, comp.id);
    await playCompetition(player1.id, comp.id); // eligible winner exists
    await forceEnd(comp.id);

    const p1Before = (await getWalletBalance(player1.id)).gamePointsBalance;

    await Promise.allSettled([
      cancelCompetition(owner.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
    ]);

    const finalComp = await prisma.groupCompetition.findUnique({ where: { id: comp.id } });
    expect(['COMPLETED', 'CANCELLED']).toContain(finalComp!.status);

    const ownerAfter = (await getWalletBalance(owner.id)).gamePointsBalance;
    const p1After = (await getWalletBalance(player1.id)).gamePointsBalance;

    if (finalComp!.status === 'CANCELLED') {
      // Cancel won: creator whole, no payout.
      expect(ownerAfter).toBe(ownerBefore);
      expect(p1After).toBe(p1Before);
    } else {
      // Finalize won: winner paid from escrow, creator stays out of pocket.
      expect(p1After).toBe(p1Before + 400);
      expect(ownerAfter).toBe(ownerBefore - 400);
    }

    // Either way, not a single unit was created or destroyed.
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: prize decrease racing finalize never pays more than escrow', async () => {
    const w = futureWindow();
    const ownerBefore = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Update Down vs Finalize',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 400,
    });
    await forceEnd(comp.id);

    await Promise.allSettled([
      updateCompetition(owner.id, comp.id, { rewardGamePoints: 100 }),
      finalizeCompetition(owner.id, comp.id),
    ]);

    // Zero participants -> whatever the settled prize was, it returns intact.
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerBefore);
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: prize increase racing cancel strands nothing', async () => {
    const w = futureWindow();
    const ownerBefore = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Update Up vs Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      rewardGamePoints: 100,
    });

    await Promise.allSettled([
      updateCompetition(owner.id, comp.id, { rewardGamePoints: 900 }),
      cancelCompetition(owner.id, comp.id),
    ]);

    // Whichever won, the creator ends up exactly whole — no stranded delta.
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerBefore);
    expect(await prizeLedgerNet(comp.id)).toEqual({ gp: 0, coins: 0 });
  });

  it('CONCURRENCY: join racing cancel never strands an entry fee', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Join vs Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 40,
      rewardGamePoints: 100,
    });

    const p1Before = (await getWalletBalance(player1.id)).gamePointsBalance;

    await Promise.allSettled([
      joinCompetition(player1.id, comp.id),
      cancelCompetition(owner.id, comp.id),
    ]);

    // Either the join never happened, or it happened and was refunded by the
    // cancellation. In both cases the entrant is exactly whole.
    expect((await getWalletBalance(player1.id)).gamePointsBalance).toBe(p1Before);
  });

  it('concurrent cancel refunds only once', async () => {
    const w = futureWindow();
    const ownerStart = (await getWalletBalance(owner.id)).gamePointsBalance;

    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Concurrent Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
      rewardGamePoints: 200,
    });

    await Promise.allSettled([
      cancelCompetition(owner.id, comp.id),
      cancelCompetition(owner.id, comp.id),
      cancelCompetition(owner.id, comp.id),
    ]);

    // Refunded exactly once — not two or three times.
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerStart);
  });
});

// ─── P1-3 REGRESSION: NON-TRIVIA PLAY AMPLIFICATION ─────────────
//
// Phase 6K made rewardGamePoints/rewardCoins a real, creator-funded escrow.
// Before this fix, playCompetition had no cap on DICE/NUMBER_CHALLENGE/
// LUCKY_SPIN rounds, so a participant could call it repeatedly to inflate
// score/gamesPlayed without bound and capture another user's funded prize.
//
// MAX_NON_TRIVIA_PLAYS_PER_COMPETITION (currently 5) is a newly introduced
// constant — see the comment at its definition in competition-service.ts.

describeIf('Non-trivia competition play limit (P1-3)', () => {
  let owner: { id: string };
  let player: { id: string };
  let player2: { id: string };
  let group: { id: string };
  const MAX_PLAYS = 5; // mirrors MAX_NON_TRIVIA_PLAYS_PER_COMPETITION

  const futureWindow = () => {
    const now = new Date();
    return {
      startsAt: new Date(now.getTime() - 1000).toISOString(),
      endsAt: new Date(now.getTime() + 3600000).toISOString(),
    };
  };

  async function newCompetition(gameKey: string, title: string) {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey,
      title,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
    });
    await joinCompetition(player.id, comp.id);
    return comp;
  }

  beforeAll(async () => {
    await cleanCompFixtures();
    owner = await createUser('plowner');
    player = await createUser('plplayer');
    player2 = await createUser('plplayer2');
    group = await createGroup(owner.id, 'Comp Test Play Limit');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await addMember(group.id, player2.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeCreator(owner.id);
    // Every OTHER test in this block uses newCompetition(), which hardcodes
    // entryAmount: 0, so player's Game Points balance was never exercised —
    // this block's beforeAll never funded it. The one test below that calls
    // createCompetition() directly with entryAmount: 30 then legitimately
    // failed joinCompetition's entry-fee debit with "have 0, need 30": a
    // missing fixture, not a production defect (the debit rejecting an
    // underfunded join is exactly correct behavior).
    await primeGamePoints(player.id, 10_000);
  });

  // ── Tests 1-3 ──────────────────────────────────────────────────
  it('allows play while below the limit', async () => {
    const comp = await newCompetition('dice', 'Below Limit');
    for (let i = 0; i < MAX_PLAYS - 1; i++) {
      const result = await playCompetition(player.id, comp.id);
      expect(result.gamesPlayed).toBe(i + 1);
    }
  });

  it('allows exactly the final permitted play, then rejects the next one', async () => {
    const comp = await newCompetition('dice', 'Exact Limit');
    let last;
    for (let i = 0; i < MAX_PLAYS; i++) {
      last = await playCompetition(player.id, comp.id);
    }
    expect(last!.gamesPlayed).toBe(MAX_PLAYS);

    await expect(playCompetition(player.id, comp.id)).rejects.toThrow(/maximum/i);

    // Rejection performs NO economic operation: gamesPlayed does not advance.
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(MAX_PLAYS);
  });

  // ── Tests 4-6: each non-trivia game type ─────────────────────
  it('caps repeated DICE plays at the limit', async () => {
    const comp = await newCompetition('dice', 'Dice Cap');
    for (let i = 0; i < MAX_PLAYS; i++) await playCompetition(player.id, comp.id);
    await expect(playCompetition(player.id, comp.id)).rejects.toThrow(/maximum/i);
  });

  it('caps repeated NUMBER_CHALLENGE plays at the limit', async () => {
    const comp = await newCompetition('number_challenge', 'Number Cap');
    for (let i = 0; i < MAX_PLAYS; i++) {
      await playCompetition(player.id, comp.id, { guess: 50 });
    }
    await expect(playCompetition(player.id, comp.id, { guess: 50 })).rejects.toThrow(/maximum/i);
  });

  it('caps repeated LUCKY_SPIN plays at the limit', async () => {
    const comp = await newCompetition('lucky_spin', 'Spin Cap');
    for (let i = 0; i < MAX_PLAYS; i++) await playCompetition(player.id, comp.id);
    await expect(playCompetition(player.id, comp.id)).rejects.toThrow(/maximum/i);
  });

  // ── Test 7: concurrency at the final slot ─────────────────────
  it('CONCURRENCY: two simultaneous requests at the final slot — exactly one succeeds', async () => {
    const comp = await newCompetition('dice', 'Concurrent Final Slot');
    for (let i = 0; i < MAX_PLAYS - 1; i++) await playCompetition(player.id, comp.id);

    const before = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(before!.gamesPlayed).toBe(MAX_PLAYS - 1);

    const results = await Promise.allSettled([
      playCompetition(player.id, comp.id),
      playCompetition(player.id, comp.id),
      playCompetition(player.id, comp.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const after = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    // gamesPlayed advanced by exactly 1, never 2 or 3.
    expect(after!.gamesPlayed).toBe(MAX_PLAYS);
    // score increased by exactly one round's worth (dice: 2-12 for one roll).
    expect(after!.score).toBeGreaterThanOrEqual(before!.score + 2);
    expect(after!.score).toBeLessThanOrEqual(before!.score + 12);
  });

  it('CONCURRENCY: high-volume concurrent requests never exceed the limit', async () => {
    const comp = await newCompetition('dice', 'Volume Concurrent');

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => playCompetition(player.id, comp.id))
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(MAX_PLAYS);

    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(MAX_PLAYS);
  });

  // ── play vs finalize / play vs cancel (6K.3.2) ────────────────
  //
  // These exercise the ACTUAL service functions concurrently against the
  // real Prisma transaction machinery — nothing here is mocked. Which side
  // of the race actually wins the competition row lock is decided by
  // PostgreSQL's lock queue at runtime, not by this test, so both orderings
  // described in Phase 6K.3.2 (play-first vs finalize/cancel-first) are
  // covered by a single branching assertion rather than forced separately —
  // forcing a specific winner would require artificial delays that
  // misrepresent genuine concurrency. Both branches are asserted explicitly
  // so neither ordering can silently pass by accident.

  async function forceEnd(competitionId: string) {
    await prisma.groupCompetition.update({
      where: { id: competitionId },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
  }

  it('CONCURRENCY: play racing finalize never lands a score after payout', async () => {
    const comp = await newCompetition('dice', 'Race Play vs Finalize');
    await playCompetition(player.id, comp.id); // one legitimate play up front
    await forceEnd(comp.id);

    const beforeP = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(beforeP!.gamesPlayed).toBe(1);

    const [playResult, finalizeResult] = await Promise.allSettled([
      playCompetition(player.id, comp.id),
      finalizeCompetition(owner.id, comp.id),
    ]);

    // finalize is not blocked by play claiming any terminal state (play never
    // writes competition status), so in this two-party race it always
    // succeeds — the only thing genuinely racing is WHETHER the second play
    // is included in what finalize reads.
    expect(finalizeResult.status).toBe('fulfilled');
    const finalized = (finalizeResult as PromiseFulfilledResult<any>).value;
    expect(finalized.status).toBe('COMPLETED');

    const afterP = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    const resultEntry = finalized.result.participants.find((r: any) => r.userId === player.id);

    if (playResult.status === 'fulfilled') {
      // Ordering 1 (play obtained the lock first): the second play committed
      // before finalize's claim, so finalize's leaderboard read — which
      // happens strictly after finalize takes the row lock — reflects it.
      expect(afterP!.gamesPlayed).toBe(2);
      expect(resultEntry.gamesPlayed).toBe(2);
      expect(resultEntry.score).toBe(afterP!.score);
    } else {
      // Ordering 2 (finalize claimed the terminal state first): play's
      // FOR UPDATE, once unblocked, observed finalizedAt already set and
      // rejected — no score landed after payout.
      expect(afterP!.gamesPlayed).toBe(1);
      expect(resultEntry.gamesPlayed).toBe(1);
    }

    // The competition and participant state are never inconsistent with each
    // other regardless of which ordering occurred.
    expect(resultEntry.score).toBe(afterP!.score);
    expect(resultEntry.gamesPlayed).toBe(afterP!.gamesPlayed);
  });

  it('CONCURRENCY: play racing cancel never survives the cancellation, and the refund is exact', async () => {
    const w = futureWindow();
    const ownerBefore = (await getWalletBalance(owner.id)).gamePointsBalance;
    const playerBeforeJoin = (await getWalletBalance(player.id)).gamePointsBalance;
    const compRaw = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'dice',
      title: 'Race Play vs Cancel',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 30,
      rewardGamePoints: 200,
    });
    await joinCompetition(player.id, compRaw.id);
    const playerAfterJoin = (await getWalletBalance(player.id)).gamePointsBalance;
    expect(playerAfterJoin).toBe(playerBeforeJoin - 30);

    const [playResult, cancelResult] = await Promise.allSettled([
      playCompetition(player.id, compRaw.id),
      cancelCompetition(owner.id, compRaw.id),
    ]);

    // Cancellation refunds entry fees and escrow unconditionally — it never
    // reads score/gamesPlayed — so it always succeeds regardless of whether
    // the racing play committed first.
    expect(cancelResult.status).toBe('fulfilled');

    const finalComp = await prisma.groupCompetition.findUnique({ where: { id: compRaw.id } });
    expect(finalComp!.status).toBe('CANCELLED');

    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: compRaw.id, userId: player.id } },
    });
    if (playResult.status === 'fulfilled') {
      // Ordering 1: the play committed before cancel claimed CANCELLED.
      // Harmless — cancellation's refund does not depend on score, so a
      // "phantom" recorded play on a since-cancelled competition does not
      // affect the accounting invariant.
      expect(p!.gamesPlayed).toBe(1);
    } else {
      // Ordering 2: cancel claimed first; play's FOR UPDATE saw CANCELLED
      // and rejected before touching gamesPlayed/score.
      expect(p!.gamesPlayed).toBe(0);
    }

    // Regardless of ordering: entry fee and prize escrow are both refunded
    // in full, exactly once — no partial or double refund, nothing stranded.
    expect((await getWalletBalance(player.id)).gamePointsBalance).toBe(playerBeforeJoin);
    expect((await getWalletBalance(owner.id)).gamePointsBalance).toBe(ownerBefore);
    expect(await prizeLedgerNet(compRaw.id)).toEqual({ gp: 0, coins: 0 });
  });

  // ── Tests 8-9: forged input cannot bypass the cap ─────────────
  it('forged gamesPlayed in clientData does not bypass the limit', async () => {
    const comp = await newCompetition('dice', 'Forge GamesPlayed');
    for (let i = 0; i < MAX_PLAYS; i++) {
      await playCompetition(player.id, comp.id, { gamesPlayed: 0 } as any);
    }
    await expect(
      playCompetition(player.id, comp.id, { gamesPlayed: 0 } as any)
    ).rejects.toThrow(/maximum/i);

    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(MAX_PLAYS); // forged field had zero effect
  });

  it('forged score in clientData does not bypass the limit or alter the award', async () => {
    const comp = await newCompetition('dice', 'Forge Score');
    for (let i = 0; i < MAX_PLAYS; i++) {
      await playCompetition(player.id, comp.id, { score: 999999999 } as any);
    }
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(MAX_PLAYS);
    expect(p!.score).toBeLessThanOrEqual(MAX_PLAYS * 12); // dice max sum is 12/round
    await expect(
      playCompetition(player.id, comp.id, { score: 999999999 } as any)
    ).rejects.toThrow(/maximum/i);
  });

  // ── NUMBER_CHALLENGE guess validation (6K.3.2 / P2) ───────────
  //
  // These call playCompetition directly — the real service function, not a
  // mocked one — so they exercise the actual validation added to
  // computeScore()'s NUMBER_CHALLENGE branch. NaN and Infinity cannot survive
  // JSON transport over the real HTTP route (JSON.stringify turns both into
  // `null`, which this code treats as "no guess supplied" rather than an
  // invalid one), so the true end-to-end HTTP boundary cannot carry these
  // values at all — the vulnerability the review identified is only reachable
  // by a caller of playCompetition() that bypasses JSON serialization (e.g.
  // a same-process caller, or a future non-HTTP transport). Testing directly
  // against the service function, as done here, is therefore the correct and
  // in fact the ONLY place these two specific values can be exercised at all;
  // this is documented rather than silently assumed.
  it('accepts a valid integer guess', async () => {
    const comp = await newCompetition('number_challenge', 'Guess Integer OK');
    const result = await playCompetition(player.id, comp.id, { guess: 42 });
    expect(result.result.guess).toBe(42);
    expect(result.gamesPlayed).toBe(1);
  });

  it('rejects a fractional guess without consuming a play', async () => {
    const comp = await newCompetition('number_challenge', 'Guess Fractional');
    await expect(playCompetition(player.id, comp.id, { guess: 50.5 })).rejects.toThrow(
      /integer/i
    );
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(0);
  });

  it('rejects a NaN guess without consuming a play (service-boundary test — see note above)', async () => {
    const comp = await newCompetition('number_challenge', 'Guess NaN');
    await expect(
      playCompetition(player.id, comp.id, { guess: Number.NaN })
    ).rejects.toThrow(/integer/i);
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(0);
  });

  it('rejects an Infinity guess without consuming a play (service-boundary test — see note above)', async () => {
    const comp = await newCompetition('number_challenge', 'Guess Infinity');
    await expect(
      playCompetition(player.id, comp.id, { guess: Number.POSITIVE_INFINITY })
    ).rejects.toThrow(/integer/i);
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(0);
  });

  it('a missing guess still defaults to 50 (preserves prior valid behavior)', async () => {
    const comp = await newCompetition('number_challenge', 'Guess Default');
    const result = await playCompetition(player.id, comp.id, {});
    expect(result.result.guess).toBe(50);
  });

  // ── Test 10: trivia is untouched by the cap ───────────────────
  it('trivia competitions are NOT subject to the non-trivia play cap', async () => {
    const w = futureWindow();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title: 'Trivia Unaffected By Cap',
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      entryAmount: 0,
    });
    await joinCompetition(player2.id, comp.id);

    // Phase 1 alone can legitimately be called many more times than
    // MAX_NON_TRIVIA_PLAYS_PER_COMPETITION — it performs no writes and must
    // never be gated by a play-count cap.
    for (let i = 0; i < MAX_PLAYS + 3; i++) {
      const phase1 = await playCompetition(player2.id, comp.id);
      expect(phase1.phase).toBe('question');
    }

    // Per-question anti-replay (Phase 6I) is still intact: answering the
    // same question twice is rejected.
    const phase1 = await playCompetition(player2.id, comp.id);
    const questionId = phase1.question!.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });
    await playCompetition(player2.id, comp.id, { questionId, answerIndex: q!.correctIndex });
    await expect(
      playCompetition(player2.id, comp.id, { questionId, answerIndex: q!.correctIndex })
    ).rejects.toThrow(/already answered/i);
  });

  // ── Test 11: no play on a terminal competition ────────────────
  it('rejects play on a finalized competition (no late score landing after payout)', async () => {
    const comp = await newCompetition('dice', 'No Play After Finalize');
    await playCompetition(player.id, comp.id);
    await prisma.groupCompetition.update({
      where: { id: comp.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    await finalizeCompetition(owner.id, comp.id);

    await expect(playCompetition(player.id, comp.id)).rejects.toThrow();

    // Score is exactly what it was at finalization — nothing landed after.
    const p = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(p!.gamesPlayed).toBe(1);
  });

  it('rejects play on a cancelled competition', async () => {
    const comp = await newCompetition('dice', 'No Play After Cancel');
    await cancelCompetition(owner.id, comp.id);
    await expect(playCompetition(player.id, comp.id)).rejects.toThrow();
  });

  // ── Alternate-path check (Step 2 evidence, pinned as a regression) ──
  it('no path other than playCompetition can advance score or gamesPlayed', async () => {
    const comp = await newCompetition('dice', 'No Alternate Path');
    const before = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(before!.score).toBe(0);
    expect(before!.gamesPlayed).toBe(0);

    // joinCompetition, updateCompetition, cancelCompetition, finalizeCompetition
    // never touch score/gamesPlayed for an existing participant — confirmed by
    // repo-wide grep (competition-service.ts is the only writer, at exactly
    // two sites: the non-trivia branch above and playTriviaCompetitionRound).
    // This test pins that a normal lifecycle call performs no such mutation.
    await updateCompetition(owner.id, comp.id, { title: 'Renamed' });

    const after = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: player.id } },
    });
    expect(after!.score).toBe(0);
    expect(after!.gamesPlayed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// P2 REGRESSION — TRIVIA POST-FINALIZATION SCORING (DEFECT #2)
//
// playCompetition's NON-trivia path takes `SELECT ... FOR UPDATE` on the
// competition row and re-checks status/finalizedAt inside its transaction.
// playTriviaCompetitionRound's Phase 2 did neither: every lifecycle check
// came from the caller's unlocked pre-read, so a finalizeCompetition that
// committed in between could be followed by a score increment and a
// consumed trivia attempt — leaving the stored leaderboard permanently
// inconsistent with the leaderboard that was actually paid out.
//
// The fix gives trivia Phase 2 the identical lock + re-check.
// ═══════════════════════════════════════════════════════════════

describeIf('Trivia post-finalization scoring (P2 regression)', () => {
  let owner: { id: string };
  let player: { id: string };
  let group: { id: string };

  beforeAll(async () => {
    owner = await createUser('tfinal_owner');
    player = await createUser('tfinal_player');
    group = await createGroup(owner.id, 'Comp Trivia Finalize Race');
    await addMember(group.id, owner.id, 'OWNER');
    await addMember(group.id, player.id, 'MEMBER');
    await ensureGameDefinitions();
    await primeCreator(owner.id);
    await primeGamePoints(player.id, 100_000);
  });

  async function makeActiveTriviaComp(title: string) {
    const now = new Date();
    const comp = await createCompetition(owner.id, {
      groupId: group.id,
      gameKey: 'trivia',
      title,
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 3_600_000).toISOString(),
      entryAmount: 0,
      rewardGamePoints: 100,
    });
    await joinCompetition(player.id, comp.id);
    // finalizeCompetition only accepts a SCHEDULED competition once endsAt
    // has passed, OR an ACTIVE one at any time. Flip to ACTIVE so the race
    // can be exercised while the play window is still genuinely open —
    // otherwise the caller's own endsAt pre-check would reject the play
    // before it ever reached the code under test.
    await prisma.groupCompetition.update({
      where: { id: comp.id },
      data: { status: 'ACTIVE' },
    });
    return comp.id;
  }

  it('rejects a trivia answer submitted after the competition is finalized', async () => {
    // Sequential ordering. This exercises the outer guard AND the new
    // in-transaction lock as defence in depth: once finalize has committed,
    // no scoring path may proceed.
    const competitionId = await makeActiveTriviaComp('Trivia Finalize Sequential');

    const phase1 = await playCompetition(player.id, competitionId);
    const questionId = (phase1 as { question: { id: string } }).question.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });

    await finalizeCompetition(owner.id, competitionId);

    await expect(
      playCompetition(player.id, competitionId, { questionId, answerIndex: q!.correctIndex })
    ).rejects.toThrow();

    // No attempt consumed, no score awarded, after the terminal state.
    const attempts = await prisma.competitionTriviaAttempt.findMany({
      where: { competitionId, userId: player.id },
    });
    expect(attempts.length).toBe(0);

    const participant = await prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId: player.id } },
    });
    expect(participant!.score).toBe(0);
    expect(participant!.gamesPlayed).toBe(0);
  });

  it('a trivia answer racing finalize cannot mutate the finalized leaderboard', async () => {
    // THE RACE this fix targets: finalize commits between the caller's
    // pre-read and the scoring transaction. Repeated to widen the window.
    for (let i = 0; i < 5; i++) {
      const competitionId = await makeActiveTriviaComp(`Trivia Finalize Race ${i}`);

      const phase1 = await playCompetition(player.id, competitionId);
      const questionId = (phase1 as { question: { id: string } }).question.id;
      const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });

      await Promise.allSettled([
        playCompetition(player.id, competitionId, { questionId, answerIndex: q!.correctIndex }),
        finalizeCompetition(owner.id, competitionId),
      ]);

      const comp = await prisma.groupCompetition.findUnique({ where: { id: competitionId } });
      expect(comp!.finalizedAt).not.toBeNull();
      expect(comp!.status).toBe('COMPLETED');

      const participant = await prisma.competitionParticipant.findUnique({
        where: { competitionId_userId: { competitionId, userId: player.id } },
      });

      // THE INVARIANT: the participant's stored score must equal the score
      // recorded in the finalized leaderboard. If a trivia answer landed
      // AFTER finalization, the stored score would exceed the paid-out
      // leaderboard entry — which is exactly the divergence DEFECT #2
      // allowed.
      const recorded = (comp!.result as { participants?: { userId: string; score: number; gamesPlayed: number }[] } | null)
        ?.participants?.find((p) => p.userId === player.id);
      expect(recorded).toBeTruthy();
      expect(participant!.score).toBe(recorded!.score);
      expect(participant!.gamesPlayed).toBe(recorded!.gamesPlayed);

      // A consumed attempt must likewise be consistent: an attempt may only
      // exist if the scoring transaction actually won the race.
      const attempts = await prisma.competitionTriviaAttempt.findMany({
        where: { competitionId, userId: player.id },
      });
      expect(attempts.length).toBe(participant!.gamesPlayed);
    }
  });

  it('exactly one payout regardless of who wins the race', async () => {
    const competitionId = await makeActiveTriviaComp('Trivia Finalize Payout');

    const phase1 = await playCompetition(player.id, competitionId);
    const questionId = (phase1 as { question: { id: string } }).question.id;
    const q = await prisma.triviaQuestion.findUnique({ where: { id: questionId } });

    await Promise.allSettled([
      playCompetition(player.id, competitionId, { questionId, answerIndex: q!.correctIndex }),
      finalizeCompetition(owner.id, competitionId),
    ]);

    // The escrowed prize is either paid to a winner or refunded to the
    // funder — exactly once, never both, never twice.
    const claims = await prisma.rewardClaim.findMany({
      where: { sourceType: 'COMPETITION', sourceId: competitionId },
    });
    expect(claims.length).toBeLessThanOrEqual(1);

    // Escrow debited at creation must be exactly offset by the payout or the
    // unawarded-prize refund — net zero, never minted, never stranded.
    expect(await prizeLedgerNet(competitionId)).toEqual({ gp: 0, coins: 0 });
  });
});
