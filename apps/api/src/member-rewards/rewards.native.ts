import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { prisma } from '@socialplay/database';
import { PRACTICE_GIFT_POLICY } from '@socialplay/shared';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import {
  readConfig,
  saveConfig,
  checkIn,
  claimEntitlement,
  rewardSummary,
  rewardDay,
  recordPaidGiftRewards,
  ensureReferralCode,
} from './service.js';
import { memberProfileRoutes, memberRewardRoutes } from './routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  mintTestPurchasedCoins,
  activateTestWithdrawalPolicy,
  nextTestCountryCode,
} from '../test/financial-policy-fixtures.js';
import { sendGift } from '../economy/gift-service.js';
import { settleWagerCoins, debitCoins } from '../economy/coin-ledger-service.js';
import { createPracticeGiftCollectionService } from '../gift-collection/practice-service.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Disposable local database required');
const app = Fastify({ logger: false });
let adminId: string, countryId: string, methodId: string, policyId: string;
const user = () => prisma.user.create({ data: { username: `mr_${randomUUID()}` } });
async function configure(patch: Record<string, unknown> = {}) {
  const c = await readConfig();
  const {
    version,
    daily_enabled,
    daily_amount,
    gift_enabled,
    gift_amount,
    gift_daily_limit,
    referral_enabled,
    referral_amount,
    gift_minimum,
  } = c;
  return saveConfig(adminId, {
    version,
    daily_enabled,
    daily_amount,
    gift_enabled,
    gift_amount,
    gift_daily_limit,
    referral_enabled,
    referral_amount,
    gift_minimum,
    ...patch,
  });
}
async function eligible(userId: string) {
  await prisma.userPayoutAccount.create({
    data: { userId, countryId, methodDefId: methodId, accountDetails: {} },
  });
}
beforeAll(async () => {
  adminId = (
    await prisma.user.create({ data: { username: `mr_admin_${randomUUID()}`, role: 'ADMIN' } })
  ).id;
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Reward test country',
      currencyCode: 'ETB',
      isActive: true,
    },
  });
  countryId = country.id;
  methodId = (
    await prisma.paymentMethodDefinition.create({
      data: {
        countryId,
        type: 'BANK_TRANSFER',
        name: 'Test payment',
        fieldSchema: {},
        isActive: true,
      },
    })
  ).id;
  await activateTestWithdrawalPolicy(countryId, adminId);
  policyId = (
    await prisma.countryJurisdiction.findUniqueOrThrow({ where: { countryCode: country.code } })
  ).activePolicyId!;
  const run = (await prisma.platformGate.findUniqueOrThrow({ where: { key: 'WITHDRAWAL_CREATE' } }))
    .lastInvariantRunId;
  await prisma.platformGate.update({
    where: { key: 'BONUS_GRANT' },
    data: { enabled: true, lastInvariantRunId: run },
  });
  await app.register(jwt, { secret: 'isolated-member-rewards-test-secret-only' });
  app.setErrorHandler(errorHandler);
  await app.register(memberRewardRoutes, { prefix: '/member-rewards' });
  await app.register(memberProfileRoutes, { prefix: '/member-profile' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
const headers = (id: string) => ({
  authorization: `Bearer ${app.jwt.sign({ sub: id, roles: ['SUPER_ADMIN'] })}`,
});

it('uses Addis Ababa midnight for daily uniqueness', () => {
  expect(rewardDay(new Date('2026-11-05T20:59:59.999Z'))).toBe('2026-11-05');
  expect(rewardDay(new Date('2026-11-05T21:00:00.000Z'))).toBe('2026-11-06');
});
it('starts disabled and rejects invalid, unauthorized, and stale admin settings', async () => {
  await configure({ daily_enabled: false, gift_enabled: false, referral_enabled: false });
  const member = await user();
  await expect(checkIn(member.id)).rejects.toThrow('not been enabled');
  const old = await readConfig();
  await expect(
    saveConfig(member.id, {
      version: old.version,
      daily_enabled: true,
      daily_amount: 100,
      gift_enabled: false,
      gift_amount: 0,
      gift_daily_limit: 0,
      referral_enabled: false,
      referral_amount: 0,
      gift_minimum: 0,
    })
  ).rejects.toThrow('administrator');
  await expect(configure({ daily_enabled: true, daily_amount: 0 })).rejects.toThrow(
    'positive daily'
  );
  await expect(configure({ daily_amount: 0.5 })).rejects.toThrow();
  const args = {
    version: old.version,
    daily_enabled: true,
    daily_amount: 250,
    gift_enabled: false,
    gift_amount: 0,
    gift_daily_limit: 0,
    referral_enabled: false,
    referral_amount: 0,
    gift_minimum: 0,
  };
  const edits = await Promise.allSettled([saveConfig(adminId, args), saveConfig(adminId, args)]);
  expect(edits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(
    await prisma.auditLog.count({
      where: { userId: adminId, action: 'MEMBER_REWARD_CONFIG_UPDATED' },
    })
  ).toBeGreaterThan(0);
});
it('concurrent daily claims pay once, stay pending without eligibility, and preserve old amounts', async () => {
  const member = await user(),
    stranger = await user();
  await configure({ daily_enabled: true, daily_amount: 250 });
  const earned = await Promise.all(Array.from({ length: 6 }, () => checkIn(member.id)));
  expect(new Set(earned.map((e) => e.id)).size).toBe(1);
  const id = earned[0].id;
  await expect(claimEntitlement(stranger.id, id)).rejects.toThrow('not found');
  await expect(claimEntitlement(member.id, id)).rejects.toThrow('remains pending');
  expect(
    await prisma.rewardClaim.count({ where: { userId: member.id, sourceType: 'MEMBER_PROMOTION' } })
  ).toBe(0);
  expect((await rewardSummary(member.id)).pendingMinor).toBe(250);
  await configure({ daily_enabled: false, daily_amount: 900 });
  await eligible(member.id);
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => claimEntitlement(member.id, id))
  );
  expect(claims.filter((c) => !c.alreadyClaimed)).toHaveLength(1);
  const summary = await rewardSummary(member.id);
  expect(summary.pendingMinor).toBe(0);
  expect(summary.wallet.coinAvailability).toMatchObject({ betOnly: 250, spendable: 0 });
  await expect(
    prisma.$executeRaw`UPDATE member_reward_entitlements SET amount=900 WHERE id=${id}`
  ).rejects.toThrow('immutable');
  await expect(
    prisma.$transaction((tx) =>
      debitCoins(tx, member.id, 10, {
        type: 'GIFT_SPEND',
        scopeType: 'GIFT_TRANSACTION',
        scopeId: randomUUID(),
        referenceType: 'GIFT',
        description: 'Rejected reward-funded gift',
      })
    )
  ).rejects.toThrow('Bonus balance');
  await prisma.$transaction((tx) =>
    settleWagerCoins(tx, member.id, {
      sessionId: randomUUID(),
      gameKey: 'trivia_quiz',
      stake: 100,
      payout: 180,
      idempotencyKey: randomUUID(),
      policy: { id: policyId, version: 1 },
      responseSnapshot: (coinsBalance) => ({ coinsBalance }),
    })
  );
  expect((await rewardSummary(member.id)).wallet.coinAvailability).toMatchObject({
    betOnly: 250,
    spendable: 80,
  });
});
it('rewards only committed paid gifts, caps gift rewards, and qualifies each referral once despite retries', async () => {
  await configure({
    gift_enabled: true,
    gift_amount: 100,
    gift_daily_limit: 200,
    referral_enabled: true,
    referral_amount: 500,
    gift_minimum: 1000,
  });
  const buyer = await user(),
    inviter = await user(),
    recipient = await user();
  await eligible(buyer.id);
  await prisma.referral.create({
    data: { referredUserId: buyer.id, referrerUserId: inviter.id, referralCode: 'TESTCODE' },
  });
  const gift = await prisma.gift.create({
    data: {
      name: 'Paid test gift',
      description: 'Fixture',
      coinPrice: 1000,
      recipientPointValue: 2,
    },
  });
  await mintTestPurchasedCoins(buyer.id, 10000);
  const args = {
    senderId: buyer.id,
    recipientId: recipient.id,
    giftId: gift.id,
    quantity: 1,
    idempotencyKey: randomUUID(),
  };
  const sends = await Promise.all(Array.from({ length: 5 }, () => sendGift(args)));
  expect(sends.filter((s) => !s.isReplay)).toHaveLength(1);
  expect((await rewardSummary(buyer.id)).pendingMinor).toBe(100);
  expect((await rewardSummary(inviter.id)).pendingMinor).toBe(500);
  await Promise.all([
    sendGift({ ...args, idempotencyKey: randomUUID() }),
    sendGift({ ...args, idempotencyKey: randomUUID() }),
  ]);
  expect((await rewardSummary(buyer.id)).pendingMinor).toBe(200);
  expect((await rewardSummary(inviter.id)).qualifiedReferrals).toBe(1);
  await expect(
    sendGift({ ...args, recipientId: buyer.id, idempotencyKey: randomUUID() })
  ).rejects.toThrow('yourself');
  const lowGift = await prisma.gift.create({
    data: {
      name: 'Small paid gift',
      description: 'Fixture',
      coinPrice: 500,
      recipientPointValue: 1,
    },
  });
  const lowBuyer = await user();
  await eligible(lowBuyer.id);
  await mintTestPurchasedCoins(lowBuyer.id, 2000);
  await prisma.referral.create({
    data: { referredUserId: lowBuyer.id, referrerUserId: inviter.id, referralCode: 'TESTCODE' },
  });
  await sendGift({
    ...args,
    senderId: lowBuyer.id,
    giftId: lowGift.id,
    idempotencyKey: randomUUID(),
  });
  expect((await rewardSummary(lowBuyer.id)).pendingMinor).toBe(0);
  expect((await rewardSummary(inviter.id)).qualifiedReferrals).toBe(1);
});
it('practice gift purchases and invented gift IDs cannot earn real-Birr rewards', async () => {
  const buyer = await user(),
    inviter = await user();
  await prisma.referral.create({
    data: { referredUserId: buyer.id, referrerUserId: inviter.id, referralCode: 'TESTCODE' },
  });
  const shop = createPracticeGiftCollectionService(prisma);
  const catalog = (await shop.snapshot(null, buyer.id)).catalog[0];
  await shop.act(buyer.id, randomUUID(), {
    kind: 'BUY',
    catalogId: catalog.id,
    faceValue: catalog.faceValue,
    policyId: PRACTICE_GIFT_POLICY,
    recipientId: buyer.id,
    groupId: null,
  });
  await prisma.$transaction((tx) => recordPaidGiftRewards(tx, {} as never, randomUUID()));
  expect((await rewardSummary(buyer.id)).pendingMinor).toBe(0);
  expect((await rewardSummary(inviter.id)).qualifiedReferrals).toBe(0);
});
it('protects profile contact data and role changes, checks current admin authority, and persists referral codes', async () => {
  const member = await user();
  const phone = '+2519' + Date.now().toString().slice(-8);
  await prisma.userAuthIdentity.create({
    data: { userId: member.id, provider: 'PHONE', providerSubject: phone },
  });
  await prisma.userAuthIdentity.create({
    data: {
      userId: member.id,
      provider: 'GOOGLE',
      providerSubject: `private-oauth-subject-${member.id}`,
    },
  });
  expect((await app.inject({ url: '/member-profile' })).statusCode).toBe(401);
  const profile = await app.inject({ url: '/member-profile', headers: headers(member.id) });
  expect(profile.statusCode).toBe(200);
  expect(profile.headers['cache-control']).toContain('no-store');
  expect(profile.json().data).toMatchObject({ id: member.id, phone, phoneVerified: false });
  expect(profile.body).not.toContain('private-oauth-subject');
  expect(profile.body).not.toContain('passwordHash');
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/member-profile',
        headers: headers(member.id),
        payload: { displayName: 'New name', bio: '', role: 'ADMIN' },
      })
    ).statusCode
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: '/member-profile',
        headers: headers(member.id),
        payload: { displayName: 'New name', bio: 'Hello' },
      })
    ).statusCode
  ).toBe(200);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).role).toBe('USER');
  expect(
    (await app.inject({ url: '/member-rewards/admin', headers: headers(member.id) })).statusCode
  ).toBe(403);
  expect(
    (await app.inject({ url: '/member-rewards/admin', headers: headers(adminId) })).statusCode
  ).toBe(200);
  const codes = await Promise.all([ensureReferralCode(member.id), ensureReferralCode(member.id)]);
  expect(codes[0].code).toBe(codes[1].code);
  await prisma.user.update({ where: { id: member.id }, data: { status: 'SUSPENDED' } });
  expect(
    (await app.inject({ url: '/member-profile', headers: headers(member.id) })).statusCode
  ).toBe(403);
});

it('readiness still rejects removal of a strict database guard pin', async () => {
  const rollback = new Error('ROLLBACK_READINESS_PROBE');
  await expect(
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('ALTER FUNCTION public.bj_total(jsonb) RESET search_path');
        const scan = await runLedgerInvariantCheckInTransaction(tx, null);
        expect(scan.passed).toBe(false);
        expect(scan.violations.some((v) => v.sample.some((s) => s.includes('bj_total')))).toBe(
          true
        );
        throw rollback;
      },
      { timeout: 30000 }
    )
  ).rejects.toBe(rollback);
});
