import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { getOrCreateWallet } from './wallet-service.js';
import {
  allocateWagerDebit,
  allocateWithdrawalDebit,
  createPayoutProvenance,
  getWithdrawableBalance,
  isQualifyingWager,
  requireWithdrawableBalance,
  transferProvenanceOnGift,
  LEGACY_REQUIRED_PLAYTHROUGH,
} from './provenance-service.js';

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
  const email = `provsvc-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `provsvc_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `ProvSvc ${tag}`,
    },
  });
}

/** Creates a CoinProvenance lot directly (bypassing any wallet credit) for
 * precise, deterministic fixture control over amount/status/timing. */
async function makeLot(
  userId: string,
  amount: number,
  opts: Partial<{
    restrictionStatus: 'RESTRICTED' | 'UNRESTRICTED' | 'PLAYING_THROUGH' | 'EXPIRED';
    provenanceType: string;
    requiredPlaythrough: number;
    completedPlaythrough: number;
    createdAt: Date;
    countryPolicyId: string;
    countryPolicyVersion: number;
    giftChainOriginId: string;
    giftChainParentId: string;
    originalSource: string;
  }> = {}
) {
  return prisma.coinProvenance.create({
    data: {
      userId,
      amount,
      provenanceType: (opts.provenanceType as any) ?? 'ADMIN_ADJUSTMENT',
      restrictionStatus: opts.restrictionStatus ?? 'UNRESTRICTED',
      originalSource: (opts.originalSource as any) ?? (opts.provenanceType as any) ?? 'ADMIN_ADJUSTMENT',
      requiredPlaythrough: opts.requiredPlaythrough ?? 0,
      completedPlaythrough: opts.completedPlaythrough ?? 0,
      createdAt: opts.createdAt,
      countryPolicyId: opts.countryPolicyId,
      countryPolicyVersion: opts.countryPolicyVersion,
      giftChainOriginId: opts.giftChainOriginId,
      giftChainParentId: opts.giftChainParentId,
    },
  });
}

/** Creates (or reuses) a real CountryCasinoPolicy row — coin_provenance.countryPolicyId
 * is a genuine foreign key, so fixtures must reference an actual row. */
async function makePolicy(code: string) {
  await prisma.country.upsert({
    where: { code },
    update: { name: `Prov Test ${code}`, currencyCode: 'TCN', isActive: true },
    create: { code, name: `Prov Test ${code}`, currencyCode: 'TCN', isActive: true },
  });
  await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: code } });
  return prisma.countryCasinoPolicy.create({
    data: { countryCode: code, version: 1, status: 'ENABLED', enabledAt: new Date(), playthroughMultiplier: 1 },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'provsvc-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: { in: ['P1', 'P9'] } } });
  await prisma.country.deleteMany({ where: { code: { in: ['P1', 'P9'] } } });
}

// ─── isQualifyingWager (pure) ───────────────────────────────────

describe('isQualifyingWager', () => {
  it('rejects a game not in qualifyingGames', () => {
    expect(isQualifyingWager({ qualifyingGames: ['dice'], maxQualifyingStake: 100 }, 'number_challenge', 10)).toBe(false);
  });
  it('rejects when maxQualifyingStake is 0 (unconfigured = qualifies nothing)', () => {
    expect(isQualifyingWager({ qualifyingGames: ['dice'], maxQualifyingStake: 0 }, 'dice', 1)).toBe(false);
  });
  it('rejects a stake above maxQualifyingStake', () => {
    expect(isQualifyingWager({ qualifyingGames: ['dice'], maxQualifyingStake: 50 }, 'dice', 51)).toBe(false);
  });
  it('accepts a qualifying game within the stake cap', () => {
    expect(isQualifyingWager({ qualifyingGames: ['dice'], maxQualifyingStake: 50 }, 'dice', 50)).toBe(true);
  });
  it('treats a non-array qualifyingGames as empty (never qualifies)', () => {
    expect(isQualifyingWager({ qualifyingGames: null, maxQualifyingStake: 100 }, 'dice', 10)).toBe(false);
  });
});

// ─── allocateWagerDebit ──────────────────────────────────────────

describeIf('allocateWagerDebit', () => {
  it('draws FIFO by (createdAt, id) across two lots, never assuming lot creation order', async () => {
    const u = await createUser('fifo');
    await getOrCreateWallet(u.id);
    const older = await makeLot(u.id, 30, { createdAt: new Date(Date.now() - 60_000) });
    const newer = await makeLot(u.id, 100, { createdAt: new Date() });

    // gameSessionId is a real foreign key to GameSession when set; pass
    // null explicitly (CoinAllocation.gameSessionId is nullable) so this
    // allocator-only test needs no GameSession row.
    const result = await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 50, gameSessionId: null as unknown as string,
        isQualifyingWager: false, policy: null,
      })
    );

    // Fully drains the older (30) lot first, then draws 20 from the newer.
    expect(result.lots).toHaveLength(2);
    expect(result.lots[0].provenanceId).toBe(older.id);
    expect(result.lots[0].allocatedAmount).toBe(30);
    expect(result.lots[1].provenanceId).toBe(newer.id);
    expect(result.lots[1].allocatedAmount).toBe(20);
    expect(result.fundedByRestricted).toBe(false);

    await cleanFixtures();
  });

  it('reports fundedByRestricted=true the moment ANY drawn lot was restricted, even if only partially drawn from', async () => {
    const u = await createUser('mixed');
    await getOrCreateWallet(u.id);
    await makeLot(u.id, 40, { restrictionStatus: 'UNRESTRICTED', createdAt: new Date(Date.now() - 60_000) });
    await makeLot(u.id, 100, { restrictionStatus: 'RESTRICTED', requiredPlaythrough: 1000, createdAt: new Date() });

    const result = await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 50, gameSessionId: null as unknown as string,
        isQualifyingWager: false, policy: null,
      })
    );

    // 40 from the unrestricted lot, 10 from the restricted one — mixed
    // funding must be flagged restricted, never treated as clean.
    expect(result.fundedByRestricted).toBe(true);
    expect(result.lots.map((l) => l.allocatedAmount)).toEqual([40, 10]);

    await cleanFixtures();
  });

  it('mints a conservative LEGACY_UNTRACKED lot for a debit exceeding all tracked provenance', async () => {
    const u = await createUser('legacy');
    await getOrCreateWallet(u.id);
    await makeLot(u.id, 20, { restrictionStatus: 'UNRESTRICTED' });

    const result = await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 70, gameSessionId: null as unknown as string,
        isQualifyingWager: false, policy: null,
      })
    );

    expect(result.fundedByRestricted).toBe(true);
    const legacyDraw = result.lots.find((l) => l.provenanceType === 'LEGACY_UNTRACKED');
    expect(legacyDraw?.allocatedAmount).toBe(50);

    const legacyLot = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: legacyDraw!.provenanceId } });
    expect(legacyLot.restrictionStatus).toBe('RESTRICTED');
    expect(legacyLot.requiredPlaythrough).toBe(LEGACY_REQUIRED_PLAYTHROUGH);

    await cleanFixtures();
  });

  it('credits qualifying playthrough only for the portion drawn from each restricted lot, and unlocks once cleared', async () => {
    const u = await createUser('qualify');
    await getOrCreateWallet(u.id);
    const lot = await makeLot(u.id, 100, {
      restrictionStatus: 'RESTRICTED',
      requiredPlaythrough: 30,
      completedPlaythrough: 0,
    });

    // First qualifying wager of 20 — not enough to clear 30.
    await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 20, gameSessionId: null as unknown as string,
        isQualifyingWager: true, policy: null,
      })
    );
    let after = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.restrictionStatus).toBe('PLAYING_THROUGH');
    expect(after.completedPlaythrough).toBe(20);

    // Second qualifying wager of 15 — clears the remaining 10, unlocks.
    await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 15, gameSessionId: null as unknown as string,
        isQualifyingWager: true, policy: null,
      })
    );
    after = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.restrictionStatus).toBe('UNRESTRICTED');
    expect(after.completedPlaythrough).toBe(30); // clamped, never exceeds requiredPlaythrough
    expect(after.unlockedAt).toBeTruthy();

    await cleanFixtures();
  });

  it('a NON-qualifying wager draws from a restricted lot but earns it zero playthrough credit', async () => {
    const u = await createUser('nonqualify');
    await getOrCreateWallet(u.id);
    const lot = await makeLot(u.id, 100, { restrictionStatus: 'RESTRICTED', requiredPlaythrough: 30 });

    await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 20, gameSessionId: null as unknown as string,
        isQualifyingWager: false, policy: null,
      })
    );
    const after = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: lot.id } });
    expect(after.restrictionStatus).toBe('RESTRICTED');
    expect(after.completedPlaythrough).toBe(0);

    await cleanFixtures();
  });

  it('the LEGACY_UNTRACKED gap lot never earns playthrough credit even on a qualifying wager — only an explicit admin action unlocks it', async () => {
    const u = await createUser('legacynoqualify');
    await getOrCreateWallet(u.id);
    // No tracked lots at all — the entire debit falls to the legacy fallback.
    const result = await prisma.$transaction(async (tx) =>
      allocateWagerDebit({
        tx, userId: u.id, amount: 25, gameSessionId: null as unknown as string,
        isQualifyingWager: true, policy: null,
      })
    );
    const legacyLot = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: result.lots[0].provenanceId } });
    expect(legacyLot.provenanceType).toBe('LEGACY_UNTRACKED');
    expect(legacyLot.restrictionStatus).toBe('RESTRICTED');
    expect(legacyLot.completedPlaythrough).toBe(0);

    await cleanFixtures();
  });
});

// ─── createPayoutProvenance ──────────────────────────────────────

describeIf('createPayoutProvenance', () => {
  it('fundedByRestricted=true creates a RESTRICTED payout with its OWN fresh requiredPlaythrough under the current policy', async () => {
    const u = await createUser('payout-restricted');
    await getOrCreateWallet(u.id);
    const policy = await makePolicy('P1');
    await prisma.$transaction(async (tx) => {
      await createPayoutProvenance({
        tx, userId: u.id, walletTransactionId: undefined as unknown as string,
        amount: 40, fundedByRestricted: true,
        policy: { id: policy.id, version: policy.version, playthroughMultiplier: 2.5 },
      });
    });
    const p = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: u.id, provenanceType: 'GAME_WIN' },
      orderBy: { createdAt: 'desc' },
    });
    expect(p.restrictionStatus).toBe('RESTRICTED');
    expect(p.requiredPlaythrough).toBe(100); // 40 * 2.5
    expect(p.countryPolicyId).toBe(policy.id);

    await cleanFixtures();
  });

  it('fundedByRestricted=false creates an UNRESTRICTED payout with zero playthrough — never assumed just because it won', async () => {
    const u = await createUser('payout-clean');
    await getOrCreateWallet(u.id);
    const policy = await makePolicy('P1');
    await prisma.$transaction(async (tx) => {
      await createPayoutProvenance({
        tx, userId: u.id, walletTransactionId: undefined as unknown as string,
        amount: 40, fundedByRestricted: false,
        policy: { id: policy.id, version: policy.version, playthroughMultiplier: 2.5 },
      });
    });
    const p = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: u.id, provenanceType: 'GAME_WIN' },
      orderBy: { createdAt: 'desc' },
    });
    expect(p.restrictionStatus).toBe('UNRESTRICTED');
    expect(p.requiredPlaythrough).toBe(0);

    await cleanFixtures();
  });
});

// ─── transferProvenanceOnGift ─────────────────────────────────────

describeIf('transferProvenanceOnGift', () => {
  it('preserves restriction status, lineage, scaled remaining playthrough and policy version across a transfer', async () => {
    const sender = await createUser('gift-sender');
    const recipient = await createUser('gift-recipient');
    await getOrCreateWallet(sender.id);
    await getOrCreateWallet(recipient.id);

    const policy = await makePolicy('P9');
    const lot = await makeLot(sender.id, 100, {
      restrictionStatus: 'PLAYING_THROUGH',
      requiredPlaythrough: 200,
      completedPlaythrough: 50, // 150 remaining
      provenanceType: 'TRIVIA_REWARD',
      countryPolicyId: policy.id,
      countryPolicyVersion: policy.version,
    });

    const drawn = await prisma.$transaction(async (tx) =>
      transferProvenanceOnGift({
        tx, fromUserId: sender.id, toUserId: recipient.id, amount: 40,
        walletTransactionId: undefined as unknown as string,
      })
    );
    expect(drawn).toHaveLength(1);
    expect(drawn[0].allocatedAmount).toBe(40);

    const received = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: recipient.id, provenanceType: 'GIFT_RECEIVED' },
    });
    expect(received.restrictionStatus).toBe('PLAYING_THROUGH');
    expect(received.amount).toBe(40);
    // remaining = 150, scaled by 40/100 = 60, rounded up.
    expect(received.requiredPlaythrough).toBe(60);
    expect(received.completedPlaythrough).toBe(0);
    expect(received.originalSource).toBe('TRIVIA_REWARD');
    expect(received.giftChainOriginId).toBe(lot.id);
    expect(received.giftChainParentId).toBe(lot.id);
    expect(received.countryPolicyId).toBe(policy.id);
    expect(received.countryPolicyVersion).toBe(policy.version);

    await cleanFixtures();
  });

  it('a second hop propagates giftChainOriginId from the FIRST lot in the chain, not the immediate parent', async () => {
    const a = await createUser('gift-a');
    const b = await createUser('gift-b');
    const c = await createUser('gift-c');
    await getOrCreateWallet(a.id);
    await getOrCreateWallet(b.id);
    await getOrCreateWallet(c.id);

    const origin = await makeLot(a.id, 50, { restrictionStatus: 'UNRESTRICTED' });
    await prisma.$transaction(async (tx) =>
      transferProvenanceOnGift({ tx, fromUserId: a.id, toUserId: b.id, amount: 50, walletTransactionId: undefined as unknown as string })
    );
    const bLot = await prisma.coinProvenance.findFirstOrThrow({ where: { userId: b.id, provenanceType: 'GIFT_RECEIVED' } });
    expect(bLot.giftChainOriginId).toBe(origin.id);

    await prisma.$transaction(async (tx) =>
      transferProvenanceOnGift({ tx, fromUserId: b.id, toUserId: c.id, amount: 50, walletTransactionId: undefined as unknown as string })
    );
    const cLot = await prisma.coinProvenance.findFirstOrThrow({ where: { userId: c.id, provenanceType: 'GIFT_RECEIVED' } });
    expect(cLot.giftChainOriginId).toBe(origin.id); // still the FIRST lot, not bLot.id
    expect(cLot.giftChainParentId).toBe(bLot.id); // but parent IS the immediate hop

    await cleanFixtures();
  });

  it('an UNRESTRICTED lot transfers as UNRESTRICTED with zero playthrough', async () => {
    const sender = await createUser('gift-clean-sender');
    const recipient = await createUser('gift-clean-recipient');
    await getOrCreateWallet(sender.id);
    await getOrCreateWallet(recipient.id);
    await makeLot(sender.id, 50, { restrictionStatus: 'UNRESTRICTED' });

    await prisma.$transaction(async (tx) =>
      transferProvenanceOnGift({ tx, fromUserId: sender.id, toUserId: recipient.id, amount: 50, walletTransactionId: undefined as unknown as string })
    );
    const received = await prisma.coinProvenance.findFirstOrThrow({ where: { userId: recipient.id, provenanceType: 'GIFT_RECEIVED' } });
    expect(received.restrictionStatus).toBe('UNRESTRICTED');
    expect(received.requiredPlaythrough).toBe(0);

    await cleanFixtures();
  });
});

// ─── Withdrawable balance ─────────────────────────────────────────

describeIf('withdrawable balance', () => {
  it('getWithdrawableBalance sums ONLY UNRESTRICTED remaining balance, ignoring RESTRICTED/PLAYING_THROUGH/EXPIRED', async () => {
    const u = await createUser('withdrawable-sum');
    await getOrCreateWallet(u.id);
    await makeLot(u.id, 30, { restrictionStatus: 'UNRESTRICTED' });
    await makeLot(u.id, 999, { restrictionStatus: 'RESTRICTED' });
    await makeLot(u.id, 999, { restrictionStatus: 'PLAYING_THROUGH' });
    await makeLot(u.id, 999, { restrictionStatus: 'EXPIRED' });

    const balance = await prisma.$transaction(async (tx) => getWithdrawableBalance(tx, u.id));
    expect(balance).toBe(30);

    await cleanFixtures();
  });

  it('requireWithdrawableBalance throws when the eligible balance is insufficient, even though the wallet total would cover it', async () => {
    const u = await createUser('withdrawable-guard');
    await getOrCreateWallet(u.id);
    await makeLot(u.id, 10, { restrictionStatus: 'UNRESTRICTED' });
    await makeLot(u.id, 500, { restrictionStatus: 'RESTRICTED' });

    await expect(
      prisma.$transaction(async (tx) => requireWithdrawableBalance(tx, u.id, 50))
    ).rejects.toMatchObject({ statusCode: 400 });

    // But withdrawing within the eligible balance succeeds.
    await expect(
      prisma.$transaction(async (tx) => requireWithdrawableBalance(tx, u.id, 10))
    ).resolves.toBeUndefined();

    await cleanFixtures();
  });

  it('allocateWithdrawalDebit draws EXCLUSIVELY from UNRESTRICTED lots, never an older RESTRICTED one, even though it is chronologically first', async () => {
    const u = await createUser('withdrawal-alloc');
    await getOrCreateWallet(u.id);
    const restrictedOlder = await makeLot(u.id, 1000, {
      restrictionStatus: 'RESTRICTED',
      createdAt: new Date(Date.now() - 120_000),
    });
    const unrestrictedNewer = await makeLot(u.id, 40, {
      restrictionStatus: 'UNRESTRICTED',
      createdAt: new Date(),
    });

    const drawn = await prisma.$transaction(async (tx) => allocateWithdrawalDebit(tx, u.id, 25));
    expect(drawn).toHaveLength(1);
    expect(drawn[0].provenanceId).toBe(unrestrictedNewer.id);
    expect(drawn[0].allocatedAmount).toBe(25);

    // The restricted lot must be completely untouched.
    const restrictedAllocations = await prisma.coinAllocation.count({ where: { provenanceId: restrictedOlder.id } });
    expect(restrictedAllocations).toBe(0);

    await cleanFixtures();
  });

  it('allocateWithdrawalDebit throws (rolling back) rather than falling back to the legacy gap lot', async () => {
    const u = await createUser('withdrawal-no-fallback');
    await getOrCreateWallet(u.id);
    await makeLot(u.id, 10, { restrictionStatus: 'UNRESTRICTED' });

    await expect(
      prisma.$transaction(async (tx) => allocateWithdrawalDebit(tx, u.id, 50))
    ).rejects.toMatchObject({ statusCode: 400 });

    // No legacy lot must have been minted as a side effect of the failed attempt.
    const legacyCount = await prisma.coinProvenance.count({ where: { userId: u.id, provenanceType: 'LEGACY_UNTRACKED' } });
    expect(legacyCount).toBe(0);

    await cleanFixtures();
  });
});
