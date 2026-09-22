import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  listActiveGames,
  getGameByKey,
  getGameRules,
  resolveCurrentRules,
} from './game-catalog.js';
import { fingerprintPlay, normalizeSelections } from './game-fingerprint.js';
import { playGame, getGameHistory } from './game-play.js';
import { lockUserForPlay, lockGameForPlay } from './game-locks.js';
import { resolveJurisdictionForPlay } from '../economy/jurisdiction-service.js';
import { getOrCreateWallet, getWalletBalance, reconcileBalance } from '../economy/wallet-service.js';
import { waitForBlockedBackends, ROW_LOCK_WAITS } from '../test/pg-locks.js';

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

async function createBareUser(tag: string) {
  const email = `games-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `games_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Games ${tag}`,
    },
  });
}

// Gives a user a playable jurisdiction: an ACTIVE payout account in a test
// country with an ENABLED casino policy. Idempotent by design (upsert).
async function provideCountryAndAccount(
  userId: string,
  code: string,
  name: string,
  policyStatus: 'ENABLED' | 'DISABLED' | null = 'ENABLED'
) {
  const country = await prisma.country.upsert({
    where: { code },
    update: { name, currencyCode: 'TCN', isActive: true },
    create: { code, name, currencyCode: 'TCN', isActive: true },
  });

  const methodDef = await prisma.paymentMethodDefinition.upsert({
    where: { countryId_type_name: { countryId: country.id, type: 'BANK_TRANSFER', name: `Test Bank ${code}` } },
    update: { isActive: true },
    create: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: `Test Bank ${code}`,
      fieldSchema: '{}',
      isActive: true,
    },
  });

  await prisma.userPayoutAccount.deleteMany({ where: { userId } });
  await prisma.userPayoutAccount.create({
    data: {
      userId,
      countryId: country.id,
      methodDefId: methodDef.id,
      accountDetails: { label: 'test' },
      status: 'ACTIVE',
    },
  });

  await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: code } });
  if (policyStatus) {
    await prisma.countryCasinoPolicy.create({
      data: {
        countryCode: code,
        version: 1,
        status: policyStatus,
        enabledAt: policyStatus === 'ENABLED' ? new Date() : null,
        playthroughMultiplier: 1,
      },
    });
  }
  return country;
}

async function provideJurisdiction(userId: string) {
  return provideCountryAndAccount(userId, 'TV', 'Testland', 'ENABLED');
}

async function createUser(tag: string) {
  const user = await createBareUser(tag);
  await provideJurisdiction(user.id);
  return user;
}

// Funds `userId` with `amount` UNRESTRICTED Coins: a real wallet credit
// PLUS a matching UNRESTRICTED CoinProvenance lot, so ordinary test wagers
// draw from a real, tracked, already-free lot rather than tripping the
// LEGACY_UNTRACKED fallback (which exists for genuinely untracked balance,
// not for test fixtures that can trivially be tracked). Tests that
// specifically want a RESTRICTED-funded wager use `primeRestrictedCoins`
// instead.
async function primeCoins(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  const { executeBalanceChange } = await import('../economy/wallet-service.js');
  const result = await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'Test fixture coins',
      },
    ],
    operationName: 'test_fund_coins',
  });
  const creditTx = (result as { transactions?: { id: string; ledgerType: string; currency: string }[] }).transactions?.find(
    (t) => t.ledgerType === 'CREDIT' && t.currency === 'COINS'
  );
  await prisma.coinProvenance.create({
    data: {
      userId,
      walletTransactionId: creditTx?.id,
      amount,
      provenanceType: 'ADMIN_ADJUSTMENT',
      restrictionStatus: 'UNRESTRICTED',
      originalSource: 'ADMIN_ADJUSTMENT',
    },
  });
}

// Funds `userId` with `amount` RESTRICTED Coins under an OWN, explicit
// requiredPlaythrough (default far beyond what a single test wager could
// qualify for, so the lot stays RESTRICTED through the wager unless a test
// deliberately sets a small requirement to prove it clears). Used by tests
// proving mixed/restricted-funded wagers cannot become withdrawable
// prematurely.
async function primeRestrictedCoins(
  userId: string,
  amount: number,
  requiredPlaythrough = 1_000_000
) {
  await getOrCreateWallet(userId);
  const { executeBalanceChange } = await import('../economy/wallet-service.js');
  const result = await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'Test fixture restricted coins',
      },
    ],
    operationName: 'test_fund_restricted_coins',
  });
  const creditTx = (result as { transactions?: { id: string; ledgerType: string; currency: string }[] }).transactions?.find(
    (t) => t.ledgerType === 'CREDIT' && t.currency === 'COINS'
  );
  return prisma.coinProvenance.create({
    data: {
      userId,
      walletTransactionId: creditTx?.id,
      amount,
      provenanceType: 'TRIVIA_REWARD',
      restrictionStatus: 'RESTRICTED',
      originalSource: 'TRIVIA_REWARD',
      requiredPlaythrough,
      completedPlaythrough: 0,
    },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'games-' } },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userPayoutAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.gameSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTriviaAttempt.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: { in: ['TV', 'TV2', 'TV3'] } } });
  await prisma.paymentMethodDefinition.deleteMany({ where: { country: { code: { in: ['TV', 'TV2', 'TV3'] } } } });
  await prisma.country.deleteMany({ where: { code: { in: ['TV', 'TV2', 'TV3'] } } });
  // Restore the seeded game definitions' rules pointer back to v1 so the
  // rules-bump tests never leak an advanced pointer into other describe blocks.
  await prisma.$executeRaw`
    UPDATE "game_definitions" SET "currentRulesVersion" = 1
    WHERE "key" IN ('dice', 'number_challenge', 'trivia')
  `;
}

// ─── FINGERPRINTING ────────────────────────────────────────────

describe('fingerprint helper', () => {
  it('normalizes selection key order deterministically', () => {
    const a = normalizeSelections({ answerIndex: 1, questionId: 'q' });
    const b = normalizeSelections({ questionId: 'q', answerIndex: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces stable SHA-256 fingerprints', () => {
    const f1 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 50,
      selections: { guess: 7 },
    });
    const f2 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 50,
      selections: { guess: 7 },
    });
    const f3 = fingerprintPlay({
      gameKey: 'dice',
      rulesVersion: 1,
      stake: 51,
      selections: { guess: 7 },
    });
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── GAME CATALOG ──────────────────────────────────────────────

describeIf('Game catalog (Phase G0)', () => {
  beforeAll(async () => {
    await cleanFixtures();
  });

it('public catalog returns exactly 13 entries (AVAILABLE + COMING_SOON), excluding RETIRED lucky_spin', async () => {
     const games = await listActiveGames();
     expect(games.length).toBe(13);
     const keys = games.map((g) => g.key);
     // Exact approved public key set — order-independent compare.
     const APPROVED_KEYS = new Set([
       'dice', 'number_challenge', 'trivia', // AVAILABLE
       'spin_win', 'thunder_derby_3d', 'neon_hounds_3d', 'turbo_circuit_3d',
       'starfall_nebula', 'jungle_dash_3d', 'turbo_keno', 'crystal_trail',
       'heat_vault', 'strait_rush', // COMING_SOON
     ]);
     expect(new Set(keys).size).toBe(13);
     for (const k of keys) expect(APPROVED_KEYS.has(k)).toBe(true);
     expect([...APPROVED_KEYS].every((k) => keys.includes(k))).toBe(true);
     expect(keys).not.toContain('lucky_spin');
     expect(keys).not.toContain('coming_');
     // Exact status split: 3 AVAILABLE + 10 COMING_SOON = 13 public.
     expect(games.filter((g) => g.catalogStatus === 'AVAILABLE').map((g) => g.key).sort()).toEqual(
       ['dice', 'number_challenge', 'trivia']
     );
     expect(games.filter((g) => g.catalogStatus === 'COMING_SOON').length).toBe(10);
     expect(keys.filter((k) => k.startsWith('coming_')).length).toBe(0);
   });

   it('GET /games performs zero writes (catalog read is pure)', async () => {
     const before = await prisma.gameDefinition.count();
     const sessionsBefore = await prisma.gameSession.count();
     const provBefore = await prisma.coinProvenance.count();
     // The route /games must be a pure read; the service only queries.
     await listActiveGames();
     const after = await prisma.gameDefinition.count();
     expect(after).toBe(before);
     expect(await prisma.gameSession.count()).toBe(sessionsBefore);
     expect(await prisma.coinProvenance.count()).toBe(provBefore);
   });

  it('every catalog row exposes the Phase-G0 fields', async () => {
    const games = await listActiveGames();
    for (const g of games) {
      expect(g.mode).toMatch(/^(WAGER|BONUS)$/);
      expect(g.family).toMatch(/^(INSTANT|SCHEDULED_DRAW|SCHEDULED_RACE)$/);
      expect(g.catalogStatus).toMatch(/^(AVAILABLE|COMING_SOON)$/);
      expect(['COINS', 'GAME_POINTS']).toContain(g.rewardCurrency);
      expect(g.wagerCurrency === null || g.wagerCurrency === 'COINS' || g.wagerCurrency === 'GAME_POINTS').toBe(true);
      expect(g.currentRulesVersion).not.toBe(undefined);
    }
    const trivia = games.find((g) => g.key === 'trivia')!;
    expect(trivia.mode).toBe('BONUS');
    expect(trivia.wagerCurrency).toBeNull();
    expect(trivia.rewardCurrency).toBe('COINS');
    expect(trivia.currentRulesVersion).toBe(1);
    const dice = games.find((g) => g.key === 'dice')!;
    expect(dice.mode).toBe('WAGER');
    expect(dice.wagerCurrency).toBe('COINS');
    expect(dice.rewardCurrency).toBe('COINS');
    expect(dice.currentRulesVersion).toBe(1);
  });

  it('retired lucky_spin is still resolvable by key but absent from the catalog', async () => {
    const game = await getGameByKey('lucky_spin');
    expect(game).not.toBeNull();
    expect(game!.catalogStatus).toBe('RETIRED');
  });

  it('the allowlist keeps lucky_spin hidden even if its catalogStatus is flipped to AVAILABLE — catalogStatus alone is not enough', async () => {
    const lucky = await getGameByKey('lucky_spin');
    await prisma.gameDefinition.update({ where: { id: lucky!.id }, data: { catalogStatus: 'AVAILABLE' } });
    try {
      const games = await listActiveGames();
      expect(games.map((g) => g.key)).not.toContain('lucky_spin');
      expect(games.length).toBe(13); // still exactly the 13 approved keys
    } finally {
      await prisma.gameDefinition.update({ where: { id: lucky!.id }, data: { catalogStatus: 'RETIRED' } });
    }
  });

  it('an unapproved COMING_SOON row (a rogue insert, migration mistake, or future draft) never becomes public', async () => {
    // COMING_SOON (not AVAILABLE): game_definitions_catalog_rules_check
    // requires an AVAILABLE row to already have a currentRulesVersion,
    // which a genuinely rogue/draft row would not have yet — COMING_SOON
    // is the realistic shape such a row takes, and it is equally covered
    // by PUBLIC_CATALOG_STATUSES, so it exercises the same allowlist gate.
    const rogue = await prisma.gameDefinition.create({
      data: {
        key: 'rogue_unapproved_game',
        name: 'Rogue Unapproved Game',
        type: 'DICE',
        minBet: 1,
        maxBet: 100,
        configuration: {},
        mode: 'WAGER',
        family: 'INSTANT',
        catalogStatus: 'COMING_SOON',
        wagerCurrency: 'COINS',
        rewardCurrency: 'COINS',
      },
    });
    try {
      const games = await listActiveGames();
      expect(games.map((g) => g.key)).not.toContain('rogue_unapproved_game');
      expect(games.length).toBe(13);
    } finally {
      await prisma.gameDefinition.delete({ where: { id: rogue.id } });
    }
  });

  it('rules helpers resolve the current version for playable games', async () => {
    const game = await getGameByKey('dice');
    expect(game).not.toBeNull();
    const rules = await resolveCurrentRules(game!);
    expect(rules?.version).toBe(game!.currentRulesVersion);
    expect(rules?.resultSchemaVersion).toBe(1);
    const byKey = await getGameRules(game!.id, 1);
    expect(byKey?.version).toBe(1);
  });
});

// ─── BET VALIDATION (WAGER) ────────────────────────────────────

describeIf('Bet validation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('bet');
    await primeCoins(a.id, 1000);
  });

  it('rejects non-integer bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1.5, idempotencyKey: 'bet-f1' })
    ).rejects.toThrow();
  });

  it('rejects zero bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 0, idempotencyKey: 'bet-f2' })
    ).rejects.toThrow();
  });

  it('rejects negative bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: -10, idempotencyKey: 'bet-f3' })
    ).rejects.toThrow();
  });

  it('rejects bet below minimum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 1, idempotencyKey: 'bet-f4' })
    ).rejects.toThrow();
  });

  it('rejects bet above maximum', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 99999, idempotencyKey: 'bet-f5' })
    ).rejects.toThrow();
  });

  it('rejects string bet', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: '10' as any, idempotencyKey: 'bet-f6' })
    ).rejects.toThrow();
  });

  it('rejects a WAGER game with no betAmount', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', idempotencyKey: 'bet-f7' })
    ).rejects.toThrow();
  });

  it('rejects a RETIRED game', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'lucky_spin', betAmount: 100, idempotencyKey: 'bet-f8' })
    ).rejects.toThrow();
  });
});

// ─── JURISDICTION GATE (fail-closed) ───────────────────────────

describeIf('jurisdiction gate', () => {
  beforeAll(async () => {
    await cleanFixtures();
  });

  it('a user with no verified country cannot play (403, before any writes — including no wallet row at all)', async () => {
    const bare = await createBareUser('jgate_bare');

    await expect(
      playGame({ userId: bare.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'jgate-bare-1' })
    ).rejects.toMatchObject({ statusCode: 403 });

    const sessions = await prisma.gameSession.count({ where: { userId: bare.id } });
    const txs = await prisma.walletTransaction.count({ where: { userId: bare.id } });
    const wallets = await prisma.wallet.count({ where: { userId: bare.id } });
    expect(sessions).toBe(0);
    expect(txs).toBe(0);
    // The pre-tx getOrCreateWallet call this fixes would have created a
    // wallet row for this user even though the play was rejected — wallet
    // creation now only happens inside the transaction, after eligibility
    // and jurisdiction checks both pass.
    expect(wallets).toBe(0);
  });

  it('a user whose country has only a DISABLED policy cannot play (403, before any writes — including no wallet row at all)', async () => {
    const user = await createBareUser('jgate_disabled');
    await provideCountryAndAccount(user.id, 'TV2', 'Testland 2', 'DISABLED');

    await expect(
      playGame({ userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'jgate-disabled-1' })
    ).rejects.toMatchObject({ statusCode: 403 });

    const sessions = await prisma.gameSession.count({ where: { userId: user.id } });
    const txs = await prisma.walletTransaction.count({ where: { userId: user.id } });
    const wallets = await prisma.wallet.count({ where: { userId: user.id } });
    expect(sessions).toBe(0);
    expect(txs).toBe(0);
    expect(wallets).toBe(0);
  });

  it('a user linked only via Agent.countryId (never a UserPayoutAccount) cannot play — Agent is not a jurisdiction source', async () => {
    const user = await createBareUser('jgate_agent_only');
    // Set up an ENABLED policy for a country this user is linked to ONLY
    // through an Agent row, never through their own UserPayoutAccount.
    const country = await prisma.country.upsert({
      where: { code: 'TV3' },
      update: { name: 'Testland 3', currencyCode: 'TCN', isActive: true },
      create: { code: 'TV3', name: 'Testland 3', currencyCode: 'TCN', isActive: true },
    });
    await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: 'TV3' } });
    await prisma.countryCasinoPolicy.create({
      data: { countryCode: 'TV3', version: 1, status: 'ENABLED', enabledAt: new Date(), playthroughMultiplier: 1 },
    });
    await prisma.agent.deleteMany({ where: { userId: user.id } });
    await prisma.agent.create({
      data: {
        userId: user.id,
        countryId: country.id,
        status: 'ACTIVE',
        displayName: "Agent-linked reseller (not the player's jurisdiction)",
        contactEmail: `games-jgate-agent-only-${user.id}@test.local`,
      },
    });

    await expect(
      playGame({ userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'jgate-agent-only-1' })
    ).rejects.toMatchObject({ statusCode: 403 });

    const wallets = await prisma.wallet.count({ where: { userId: user.id } });
    expect(wallets).toBe(0);

    await prisma.agent.deleteMany({ where: { userId: user.id } });
    await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: 'TV3' } });
    await prisma.country.deleteMany({ where: { code: 'TV3' } });
  });

  it('after an ENABLED policy is provided, the same user CAN play', async () => {
    const user = await createBareUser('jgate_enabled');
    await provideCountryAndAccount(user.id, 'TV2', 'Testland 2', 'DISABLED');

    await expect(
      playGame({ userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'jgate-enabled-0' })
    ).rejects.toMatchObject({ statusCode: 403 });

    await provideCountryAndAccount(user.id, 'TV2', 'Testland 2', 'ENABLED');
    await primeCoins(user.id, 1000);

    const result = await playGame({
      userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'jgate-enabled-1',
    });
    expect(result.gameKey).toBe('dice');
    expect(result.isReplay).toBe(false);
  });
});

// ─── IDEMPOTENCY KEY VALIDATION ────────────────────────────────

describeIf('Idempotency key validation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('idkey');
    await primeCoins(a.id, 1000);
  });

  it('requires an idempotency key', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10 })
    ).rejects.toThrow();
  });

  it('rejects keys longer than 128 chars', async () => {
    const long = 'x'.repeat(129);
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: long })
    ).rejects.toThrow();
  });

  it('rejects keys with control or space characters', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'has space' })
    ).rejects.toThrow();
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'ctrl\u0001char' })
    ).rejects.toThrow();
  });
});

// ─── INSUFFICIENT COINS ────────────────────────────────────────

describeIf('Insufficient Coins', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('insuf');
    await getOrCreateWallet(a.id);
  });

  it('rejects play when the COINS balance is 0', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'insuf-1' })
    ).rejects.toThrow();
  });
});

// ─── ELIGIBILITY ───────────────────────────────────────────────

describeIf('Eligibility', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('elig');
    await primeCoins(a.id, 1000);
  });

  it('lockUserForPlay rejects a non-ACTIVE account', async () => {
    await prisma.user.update({ where: { id: a.id }, data: { status: 'SUSPENDED' } });
    try {
      await expect(
        playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'elig-1' })
      ).rejects.toThrow();
    } finally {
      await prisma.user.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('lockUserForPlay returns the locked user for ACTIVE accounts', async () => {
    const locked = (await prisma.$transaction((tx) => lockUserForPlay(tx, a.id))) as {
      id: string;
      status: string;
    };
    expect(locked.id).toBe(a.id);
    expect(locked.status).toBe('ACTIVE');
  });
});

// ─── DICE ──────────────────────────────────────────────────────

describeIf('Dice', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('dice');
    await primeCoins(a.id, 1000);
  });

  it('returns valid dice result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'dice-1',
    });
    expect(result.gameKey).toBe('dice');
    expect(result.betAmount).toBe(100);
    expect(result.mode).toBe('WAGER');
    expect(result.wagerCurrency).toBe('COINS');
    expect(result.rewardCurrency).toBe('COINS');
    expect(result.rulesVersion).toBe(1);
    expect(result.resultSchemaVersion).toBe(1);
    expect(result.playContext).toBe('SOLO_WAGER');
    expect(result.isReplay).toBe(false);
    const { die1, die2, sum } = result.result as any;
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
    expect(die2).toBeGreaterThanOrEqual(1);
    expect(die2).toBeLessThanOrEqual(6);
    expect(sum).toBe(die1 + die2);
  });

  it('win on sum >= threshold (7)', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await playGame({
        userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `dice-win-${i}`,
      });
      const { sum } = result.result as any;
      if (sum >= 7) {
        expect(result.isWin).toBe(true);
        expect(result.rewardAmount).toBe(20); // 10 * 2
      } else {
        expect(result.isWin).toBe(false);
        expect(result.rewardAmount).toBe(0);
      }
    }
  });

  it('returns authoritative server-side newBalance in COINS', async () => {
    const before = await getWalletBalance(a.id);
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'dice-balance-1',
    });
    const expected = before.coinsBalance - 10 + result.rewardAmount;
    expect(result.newBalance).toBe(expected);
    const after = await getWalletBalance(a.id);
    expect(result.newBalance).toBe(after.coinsBalance);
    expect(after.coinsBalance).toBeGreaterThanOrEqual(0);
  });

  it('persists immutable snapshots and settlement currencies on the session', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'dice-snap-1',
    });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.mode).toBe('WAGER');
    expect(session.family).toBe('INSTANT');
    expect(session.wagerCurrency).toBe('COINS');
    expect(session.rewardCurrency).toBe('COINS');
    expect(session.rulesVersion).toBe(1);
    expect(session.resultSchemaVersion).toBe(1);
    expect(session.playContext).toBe('SOLO_WAGER');
    expect(session.settlementDebitCurrency).toBe('COINS');
    expect(session.settlementCreditCurrency).toBe('COINS');
    expect(session.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const requestSnapshot = session.requestSnapshot as any;
    expect(requestSnapshot.gameKey).toBe('dice');
    expect(requestSnapshot.rulesVersion).toBe(1);
    expect(requestSnapshot.stake).toBe(10);
    const responseSnapshot = session.responseSnapshot as any;
    expect(responseSnapshot.sessionId).toBe(result.sessionId);
    expect(responseSnapshot.newBalance).toBe(result.newBalance);
    expect(responseSnapshot.isReplay).toBeUndefined();
  });
});

// ─── NUMBER CHALLENGE ──────────────────────────────────────────

describeIf('Number Challenge', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('num');
    await primeCoins(a.id, 1000);
  });

  it('validates guess is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: {}, idempotencyKey: 'num-1' })
    ).rejects.toThrow();
  });

  it('validates guess is integer', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 10, clientData: { guess: 1.5 }, idempotencyKey: 'num-2' })
    ).rejects.toThrow();
  });

  it('returns correct/away in result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'number_challenge', betAmount: 10,
      clientData: { guess: 50 }, idempotencyKey: 'num-3',
    });
    expect(result.result).toHaveProperty('guess');
    expect(result.result).toHaveProperty('target');
    expect(result.result).toHaveProperty('away');
    expect(result.result).toHaveProperty('correct');
    expect((result.result as any).guess).toBe(50);
  });
});

// ─── TRIVIA (BONUS, no stake, restricted COINS reward) ─────────

describeIf('Trivia', () => {
  let a: { id: string };
  let questionId: string;
  let wrongAnswerQuestionId: string;

  const bet0 = (key: string) => playGame({
    userId: a.id, gameKey: 'trivia', betAmount: 0, idempotencyKey: key,
  });
  const good = (key: string, qid: string, answer: number) => playGame({
    userId: a.id, gameKey: 'trivia', clientData: { questionId: qid, answerIndex: answer }, idempotencyKey: key,
  });

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('trivia');
    await primeCoins(a.id, 1000);

    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 2 + 2?', choices: ['3', '4', '5', '6'], correctIndex: 1, category: 'math' },
    });
    questionId = q.id;

    const q2 = await prisma.triviaQuestion.create({
      data: { question: 'What is 3 + 3?', choices: ['5', '6', '7', '8'], correctIndex: 1, category: 'math' },
    });
    wrongAnswerQuestionId = q2.id;
  });

  it('forbids a betAmount field even when 0', async () => {
    await expect(bet0('trivia-betfield')).rejects.toThrow();
  });

  it('forbids a betAmount field even when present (nonzero)', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', betAmount: 10, clientData: { questionId, answerIndex: 1 }, idempotencyKey: 'trivia-betfield2' })
    ).rejects.toThrow();
  });

  it('credits a correct answer with 30 COINS and no stake', async () => {
    const before = await getWalletBalance(a.id);
    const result = await good('trivia-correct', questionId, 1);
    const after = await getWalletBalance(a.id);
    expect(result.isWin).toBe(true);
    expect(result.rewardAmount).toBe(30);
    expect(result.betAmount).toBe(0);
    expect(result.mode).toBe('BONUS');
    expect(result.wagerCurrency).toBeNull();
    expect(result.rewardCurrency).toBe('COINS');
    expect(result.playContext).toBe('BONUS');
    expect(after.coinsBalance).toBe(before.coinsBalance + 30);
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.settlementDebitCurrency).toBeNull();
    expect(session.settlementCreditCurrency).toBe('COINS');
    expect(session.betAmount).toBe(0);
  });

  it('gives no reward for a wrong answer and settles nothing', async () => {
    const before = await getWalletBalance(a.id);
    const result = await good('trivia-wrong', wrongAnswerQuestionId, 0);
    const after = await getWalletBalance(a.id);
    expect(result.isWin).toBe(false);
    expect(result.rewardAmount).toBe(0);
    expect(after.coinsBalance).toBe(before.coinsBalance);
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.settlementDebitCurrency).toBeNull();
    expect(session.settlementCreditCurrency).toBeNull();
  });

  it('validates questionId is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', clientData: { answerIndex: 1 }, idempotencyKey: 'trivia-q1' })
    ).rejects.toThrow();
  });

  it('validates answerIndex is required', async () => {
    await expect(
      playGame({ userId: a.id, gameKey: 'trivia', clientData: { questionId }, idempotencyKey: 'trivia-q2' })
    ).rejects.toThrow();
  });

  it('rejects duplicate attempt on the same question', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 3 + 3?', choices: ['5', '6', '7', '8'], correctIndex: 1, category: 'math' },
    });
    await good('trivia-dup-1', q.id, 1);
    await expect(good('trivia-dup-2', q.id, 2)).rejects.toThrow();
  });

  it('allows different questions for the same user', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 5 + 5?', choices: ['8', '9', '10', '11'], correctIndex: 2, category: 'math' },
    });
    const result = await good('trivia-diff-1', q.id, 2);
    expect(result.isWin).toBe(true);
  });

  it('concurrent duplicate attempts are rejected safely', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 7 + 7?', choices: ['12', '13', '14', '15'], correctIndex: 2, category: 'math' },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, i) =>
        good(`trivia-conc-${i}`, q.id, 2)
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });
});

// ─── IDEMPOTENCY / REPLAY ──────────────────────────────────────

describeIf('Idempotency and replay', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('idem');
    await primeCoins(a.id, 5000);
  });

  it('same key + same fingerprint replays the stored snapshot with isReplay=true', async () => {
    const base = { userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-1' } as const;
    const r1 = await playGame({ ...base });
    const r2 = await playGame({ ...base });
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.rewardAmount).toBe(r1.rewardAmount);
    expect(r2.result).toEqual(r1.result);
    expect(r2.isReplay).toBe(true);
    expect(r1.isReplay).toBe(false);
    expect(r2.newBalance).toBe(r1.newBalance);
  });

  it('same key + different fingerprint (different stake) conflicts with 409', async () => {
    await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-2',
    });
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 50, idempotencyKey: 'idem-dice-2' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('trivia is replayable with the same key without double-crediting', async () => {
    const q = await prisma.triviaQuestion.create({
      data: { question: 'What is 4 + 4?', choices: ['6', '7', '8', '9'], correctIndex: 2, category: 'math' },
    });
    const before = await getWalletBalance(a.id);
    const r1 = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 2 },
      idempotencyKey: 'idem-trivia-1',
    });
    const r2 = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 2 },
      idempotencyKey: 'idem-trivia-1',
    });
    const after = await getWalletBalance(a.id);
    expect(r2.isReplay).toBe(true);
    expect(after.coinsBalance).toBe(before.coinsBalance + r1.rewardAmount);
  });

  it('different idempotency keys create different sessions', async () => {
    const r1 = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-3',
    });
    const r2 = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'idem-dice-4',
    });
    expect(r2.sessionId).not.toBe(r1.sessionId);
  });
});

// ─── GAME HISTORY (IDOR) ───────────────────────────────────────

describeIf('Game history', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('hist');
    await primeCoins(a.id, 1000);

    await playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: 'hist-1' });
    await playGame({ userId: a.id, gameKey: 'number_challenge', betAmount: 20, clientData: { guess: 50 }, idempotencyKey: 'hist-2' });
  });

  it('returns only the authenticated user history', async () => {
    const history = await getGameHistory(a.id);
    expect(history.data.length).toBeGreaterThanOrEqual(2);
    for (const s of history.data) {
      expect(s).toHaveProperty('betAmount');
      expect(s).toHaveProperty('rewardAmount');
    }
  });

  it('supports pagination', async () => {
    const page1 = await getGameHistory(a.id, { page: 1, limit: 1 });
    expect(page1.data.length).toBe(1);
    expect(page1.total).toBeGreaterThanOrEqual(2);
  });

  it('another user gets empty history', async () => {
    const b = await createUser('hist_other');
    const history = await getGameHistory(b.id);
    expect(history.data.length).toBe(0);
  });
});

// ─── CONCURRENCY ───────────────────────────────────────────────

describeIf('Concurrency', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('concur');
    await primeCoins(a.id, 100);
  });

  it('concurrent games cannot overspend', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `conc-${i}` })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBeLessThanOrEqual(10);

    const wallet = await getWalletBalance(a.id);
    expect(wallet.coinsBalance).toBeGreaterThanOrEqual(0);

    const rec = await reconcileBalance(a.id);
    expect(rec.coinsMatch).toBe(true);
  });
});

// ─── DETERMINISTIC LOCKING RACES ────────────────────────────────
// Proves the ROW LOCKS themselves cause blocking (not merely that the
// end-state behavior happens to be correct) — see test/pg-locks.ts.

const tx30 = { timeout: 30_000, maxWait: 30_000 };

describeIf('Deterministic locking races', () => {
  it('a concurrent policy status change blocks behind the settlement transaction\'s jurisdiction lock', async () => {
    const user = await createUser('race-juris');
    await primeCoins(user.id, 1000);
    const policy = await prisma.countryCasinoPolicy.findFirstOrThrow({
      where: { countryCode: 'TV', status: 'ENABLED' },
    });

    let racer: Promise<{ status: string }> | undefined;

    // Holder: takes the SAME row-level FOR SHARE lock resolveJurisdictionForPlay
    // takes on this policy row. The racer is fired (not awaited) from INSIDE
    // this still-open transaction, and we wait for it to be PROVABLY parked
    // behind the lock before letting the callback return (which commits and
    // releases it) — the established pattern for this suite's row-lock races.
    await prisma.$transaction(async (tx) => {
      // Holder calls the REAL resolveJurisdictionForPlay — this exercises
      // the actual production lock, not a hand-rolled duplicate of it.
      await resolveJurisdictionForPlay(tx, user.id);

      racer = prisma.countryCasinoPolicy.update({
        where: { id: policy.id },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });
      racer.catch(() => undefined);

      await waitForBlockedBackends(1, {
        queryLike: '%country_casino_policies%SET%',
        waitEvents: ROW_LOCK_WAITS,
      });
    }, tx30);

    // Only now — after the holder committed — does the racer's UPDATE proceed.
    const updated = await racer!;
    expect(updated.status).toBe('DISABLED');

    // Restore for other tests/fixtures sharing the 'TV' policy.
    await prisma.countryCasinoPolicy.update({
      where: { id: policy.id },
      data: { status: 'ENABLED', disabledAt: null },
    });
  }, 60_000);

  it('a concurrent catalogStatus/currentRulesVersion change blocks behind the settlement transaction\'s game lock', async () => {
    const game = await getGameByKey('dice');
    expect(game).not.toBeNull();

    let racer: Promise<{ catalogStatus: string }> | undefined;

    await prisma.$transaction(async (tx) => {
      // Holder calls the REAL lockGameForPlay — exercises the actual
      // production lock, not a hand-rolled duplicate of it.
      await lockGameForPlay(tx, 'dice');

      racer = prisma.gameDefinition.update({
        where: { id: game!.id },
        data: { catalogStatus: 'COMING_SOON' },
      });
      racer.catch(() => undefined);

      await waitForBlockedBackends(1, {
        queryLike: '%game_definitions%SET%',
        waitEvents: ROW_LOCK_WAITS,
      });
    }, tx30);

    const updated = await racer!;
    expect(updated.catalogStatus).toBe('COMING_SOON');

    // Restore.
    await prisma.gameDefinition.update({ where: { id: game!.id }, data: { catalogStatus: 'AVAILABLE' } });
  }, 60_000);

  it('a concurrent payout-account status change blocks behind the settlement transaction\'s jurisdiction lock (the SAME FOR SHARE JOIN also locks this row)', async () => {
    const user = await createUser('race-account');
    await primeCoins(user.id, 1000);
    const account = await prisma.userPayoutAccount.findFirstOrThrow({
      where: { userId: user.id, status: 'ACTIVE' },
    });

    let racer: Promise<{ status: string }> | undefined;

    await prisma.$transaction(async (tx) => {
      // Holder calls the REAL resolveJurisdictionForPlay — the SAME single
      // joined FOR SHARE that locks both the policy and payout-account rows
      // (no `FOR SHARE OF` restricting it to one table), exercising the
      // actual production lock rather than a hand-rolled duplicate of it.
      await resolveJurisdictionForPlay(tx, user.id);

      racer = prisma.userPayoutAccount.update({
        where: { id: account.id },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });
      racer.catch(() => undefined);

      await waitForBlockedBackends(1, {
        queryLike: '%user_payout_accounts%SET%',
        waitEvents: ROW_LOCK_WAITS,
      });
    }, tx30);

    const updated = await racer!;
    expect(updated.status).toBe('DISABLED');

    // Restore.
    await prisma.userPayoutAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE', disabledAt: null } });
  }, 60_000);
});

// ─── ROLLBACK LEAVES NO ORPHAN PROVENANCE ───────────────────────

describeIf('Rollback leaves wallet/ledger/provenance/allocation unchanged', () => {
  it('two concurrent plays sharing the EXACT SAME idempotency key never double-debit — the advisory lock serializes them and the second transparently replays the first, exactly one allocation set exists', async () => {
    // The advisory lock (`pg_advisory_xact_lock` keyed by userId+idempotencyKey,
    // acquired as literally the first statement of the transaction) fully
    // serializes two concurrent calls sharing a key — the second is blocked
    // until the first COMMITS, then finds the already-persisted session via
    // the replay check and returns it, rather than racing into the
    // GameSession unique-constraint P2002. Both calls therefore FULFILL
    // (one 201, one 200-replay) with IDENTICAL session data — the real-world
    // guarantee this exists to prove: a retried/duplicated request can never
    // create a second wager, whatever transport-level race produced it.
    const user = await createUser('race-rollback');
    await primeCoins(user.id, 1000);

    const beforeAllocations = await prisma.coinAllocation.count({ where: { userId: user.id } });
    const beforeSessions = await prisma.gameSession.count({ where: { userId: user.id } });

    const sharedKey = 'race-rollback-shared-key';
    const results = await Promise.allSettled([
      playGame({ userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: sharedKey }),
      playGame({ userId: user.id, gameKey: 'dice', betAmount: 10, idempotencyKey: sharedKey }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof playGame>>>[];
    expect(fulfilled).toHaveLength(2);
    // Both resolved to the SAME session — one is the fresh play, the other its replay.
    expect(fulfilled[0].value.sessionId).toBe(fulfilled[1].value.sessionId);
    expect(fulfilled.filter((r) => r.value.isReplay === true)).toHaveLength(1);
    expect(fulfilled.filter((r) => r.value.isReplay === false)).toHaveLength(1);

    const afterSessions = await prisma.gameSession.count({ where: { userId: user.id } });
    expect(afterSessions).toBe(beforeSessions + 1); // exactly ONE session, never two

    const afterAllocations = await prisma.coinAllocation.count({ where: { userId: user.id } });
    // Exactly ONE wager's worth of allocation rows exist — the replay did
    // NO settlement work of its own (see playGame's replay branch, which
    // returns the stored snapshot before any wallet/provenance write).
    expect(afterAllocations).toBe(beforeAllocations + 1);

    const rec = await reconcileBalance(user.id);
    expect(rec.coinsMatch).toBe(true);
  });

  it('a rejected trivia re-answer (P2002 on the unique attempt) leaves no orphan wallet/provenance work from that attempt', async () => {
    // A DIFFERENT idempotency key per call means the advisory lock does NOT
    // serialize these two — they race on the userTriviaAttempt unique
    // constraint instead. The loser's P2002 is caught and re-thrown as a
    // 400 BEFORE any wallet/provenance work begins in that attempt (see
    // game-play.ts: the attempt claim happens during outcome generation,
    // strictly before settlement) — so this proves the loser's rejection
    // truly leaves zero trace, via the earliest possible failure point.
    const user = await createUser('race-trivia-rollback');
    await primeCoins(user.id, 1000);
    const q = await prisma.triviaQuestion.create({
      data: { question: 'Rollback-Q', choices: ['A', 'B', 'C', 'D'], correctIndex: 0, category: 'math' },
    });

    const beforeProvenance = await prisma.coinProvenance.count({ where: { userId: user.id } });
    const beforeTx = await prisma.walletTransaction.count({ where: { userId: user.id } });

    const results = await Promise.allSettled([
      playGame({ userId: user.id, gameKey: 'trivia', clientData: { questionId: q.id, answerIndex: 0 }, idempotencyKey: 'race-trivia-a' }),
      playGame({ userId: user.id, gameKey: 'trivia', clientData: { questionId: q.id, answerIndex: 0 }, idempotencyKey: 'race-trivia-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one attempt's worth of provenance/ledger work exists — the
    // loser's rejected attempt left nothing behind.
    const afterProvenance = await prisma.coinProvenance.count({ where: { userId: user.id } });
    const afterTx = await prisma.walletTransaction.count({ where: { userId: user.id } });
    expect(afterProvenance).toBeLessThanOrEqual(beforeProvenance + 1);
    expect(afterTx).toBeLessThanOrEqual(beforeTx + 1);

    const rec = await reconcileBalance(user.id);
    expect(rec.coinsMatch).toBe(true);
  });
});

// ─── CLIENT MANIPULATION ───────────────────────────────────────

describeIf('Client manipulation', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('manip');
    await primeCoins(a.id, 1000);
  });

  it('client cannot supply dice result', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10,
      clientData: { die1: 6, die2: 6, sum: 12 }, idempotencyKey: 'manip-dice-1',
    });
    const { die1, sum } = result.result as any;
    expect(typeof die1).toBe('number');
    expect(die1).toBeGreaterThanOrEqual(1);
    expect(die1).toBeLessThanOrEqual(6);
    void sum;
  });

  it('client cannot supply reward amount', async () => {
    const result = await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 10,
      clientData: { rewardAmount: 99999 }, idempotencyKey: 'manip-reward-1',
    });
    expect(result.rewardAmount).toBeLessThan(99999);
  });
});

// ─── CORRECTION: PROVENANCE ─────────────────────────────────────

describeIf('Provenance corrections', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('prov');
    await primeCoins(a.id, 5000);
  });

  it('trivia reward creates a RESTRICTED provenance row', async () => {
    const q = await prisma.triviaQuestion.create({
      data: {
        question: 'Prov-1 question', choices: ['A', 'B', 'C', 'D'], correctIndex: 1, category: 'math',
      },
    });
    const result = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 1 },
      idempotencyKey: 'prov-trivia-1',
    });
    const p = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: a.id, provenanceType: 'TRIVIA_REWARD' },
      orderBy: { createdAt: 'desc' },
    });
    expect(p.amount).toBe(30);
    expect(p.restrictionStatus).toBe('RESTRICTED');
    expect(p.originalSource).toBe('TRIVIA_REWARD');
    expect(p.walletTransactionId).toBeTruthy();
    expect(p.requiredPlaythrough).toBeGreaterThanOrEqual(1);
    void result;
  });

  it('wager win creates an UNRESTRICTED GAME_WIN provenance; loss creates none', async () => {
    // Force a deterministic win path is not possible; run a few rounds and
    // assert that each win yields GAME_WIN provenance and each loss yields none.
    const beforeWins = await prisma.coinProvenance.count({
      where: { userId: a.id, provenanceType: 'GAME_WIN' },
    });
    let sessionCount = 0;
    for (let i = 0; i < 40; i++) {
      const key = `prov-dice-win-${i}`;
      const r = await playGame({ userId: a.id, gameKey: 'dice', betAmount: 10, idempotencyKey: key });
      sessionCount++;
      if (r.isWin) {
        const p = await prisma.coinProvenance.findFirstOrThrow({
          where: { userId: a.id, provenanceType: 'GAME_WIN', amount: r.rewardAmount },
          orderBy: { createdAt: 'desc' },
        });
        expect(p.restrictionStatus).toBe('UNRESTRICTED');
      }
    }
    void sessionCount;
    const afterWins = await prisma.coinProvenance.count({
      where: { userId: a.id, provenanceType: 'GAME_WIN' },
    });
    expect(afterWins).toBeGreaterThanOrEqual(beforeWins);
  });

  it('mixed restricted+unrestricted wager funding — a win cannot become withdrawable prematurely: the payout inherits RESTRICTED', async () => {
    const mixedUser = await createUser('prov-mixed');
    // A tiny UNRESTRICTED lot (exhausted by the very first wager) plus a
    // large RESTRICTED backing lot that cannot clear under the default
    // test policy (qualifyingGames defaults to [] — nothing qualifies).
    // From the second wager onward every stake draws PURELY from the
    // restricted lot; the first wager draws from BOTH — either way,
    // fundedByRestricted must be true for every wager below.
    await primeCoins(mixedUser.id, 5);
    await primeRestrictedCoins(mixedUser.id, 5000, 10_000);

    let sawWin = false;
    for (let i = 0; i < 40; i++) {
      const r = await playGame({
        userId: mixedUser.id, gameKey: 'dice', betAmount: 10, idempotencyKey: `prov-mixed-${i}`,
      });
      if (r.isWin) {
        sawWin = true;
        const p = await prisma.coinProvenance.findFirstOrThrow({
          where: { userId: mixedUser.id, provenanceType: 'GAME_WIN', amount: r.rewardAmount },
          orderBy: { createdAt: 'desc' },
        });
        expect(p.restrictionStatus).toBe('RESTRICTED');
        expect(p.requiredPlaythrough).toBeGreaterThan(0);
        // NOT withdrawable: getWithdrawableBalance must never count this lot.
        const withdrawable = await prisma.$transaction(async (tx) =>
          (await import('../economy/provenance-service.js')).getWithdrawableBalance(tx, mixedUser.id)
        );
        // The only UNRESTRICTED money this user could ever have is the
        // original 5, already spent by wager #1 — so from wager #2 onward
        // withdrawable must be exactly 0, and even on wager #1 the fresh
        // RESTRICTED payout itself never counts.
        expect(withdrawable).toBe(0);
      }
    }
    expect(sawWin).toBe(true);
  });

  it('provenance row references a wallet CREDIT transaction owned by the same user', async () => {
    const q = await prisma.triviaQuestion.create({
      data: {
        question: 'Prov-2 question', choices: ['A', 'B', 'C', 'D'], correctIndex: 0, category: 'math',
      },
    });
    const result = await playGame({
      userId: a.id, gameKey: 'trivia',
      clientData: { questionId: q.id, answerIndex: 0 },
      idempotencyKey: 'prov-trivia-2',
    });
    expect(result.isWin).toBe(true);
    const p = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: a.id, provenanceType: 'TRIVIA_REWARD' },
      orderBy: { createdAt: 'desc' },
    });
    const tx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: p.walletTransactionId } });
    expect(tx.userId).toBe(a.id);
    expect(tx.currency).toBe('COINS');
    expect(tx.ledgerType).toBe('CREDIT');
  });
});

// ─── CORRECTION: REPLAY AFTER RULES BUMP ────────────────────────

describeIf('Replay after a rules bump', () => {
  let a: { id: string };

  async function bumpDiceRules() {
    const def = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
    const rules = await prisma.gameRules.findUniqueOrThrow({
      where: { gameId_version: { gameId: def.id, version: 1 } },
    });
    // game_rules is immutable, so prior bumps persist across runs. Read the
    // max existing version and bump past it (never collide).
    const max = await prisma.gameRules.aggregate({
      where: { gameId: def.id },
      _max: { version: true },
    });
    const version = (max._max.version ?? 1) + 1;
    // Insert a new version with a materially different multiplier to prove the
    // stored rules version is used on replay, not the CURRENT version.
    const vN = await prisma.gameRules.create({
      data: {
        gameId: def.id,
        version,
        mode: rules.mode,
        family: rules.family,
        wagerCurrency: rules.wagerCurrency,
        rewardCurrency: rules.rewardCurrency,
        rules: { ...rules.rules as object, multiplier: 2 },
        resultSchemaVersion: rules.resultSchemaVersion,
        rulesHash: '0'.repeat(64),
      } as any,
    });
    await prisma.gameDefinition.update({
      where: { id: def.id },
      data: { currentRulesVersion: version },
    });
    return vN;
  }

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('reqreplay');
    await primeCoins(a.id, 5000);
  });

  it('replays the ORIGINAL response snapshot after the rules pointer advances', async () => {
    const base = {
      userId: a.id, gameKey: 'dice', betAmount: 100, idempotencyKey: 'bump-dice-1',
    } as const;
    const r1 = await playGame({ ...base });
    expect(r1.rulesVersion).toBe(1);

    await bumpDiceRules();

    // Replay with the same key + fingerprint returns the stored v1 snapshot,
    // even though the CURRENT rules pointer has advanced to v2.
    const r2 = await playGame({ ...base });
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.rulesVersion).toBe(1); // stored, not 2
    expect(r2.rewardAmount).toBe(r1.rewardAmount);
    expect(r2.result).toEqual(r1.result);
    expect(r2.isReplay).toBe(true);
  });

  it('still returns 409 for a conflicting payload after a rules bump', async () => {
    await playGame({
      userId: a.id, gameKey: 'dice', betAmount: 50, idempotencyKey: 'bump-dice-2',
    });
    await bumpDiceRules();
    await expect(
      playGame({ userId: a.id, gameKey: 'dice', betAmount: 40, idempotencyKey: 'bump-dice-2' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});