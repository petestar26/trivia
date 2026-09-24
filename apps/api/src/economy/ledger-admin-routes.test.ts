import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { executeTestAdjustment } from '../test/adjustment-fixtures.js';

let dbAvailable = true;
try { await prisma.$queryRaw`SELECT 1`; } catch { dbAvailable = false; }
const describeIf = dbAvailable ? describe : describe.skip;
let server: Awaited<ReturnType<typeof buildServer>>;
const endpoint = `${config.API_PREFIX}/ledger-admin`;
const tag = () => randomUUID().replaceAll('-', '');
async function makeUser(role: 'USER' | 'SUPER_ADMIN') {
  const suffix = tag();
  return prisma.user.create({ data: {
    username: `la_${suffix.slice(0, 14)}`, email: `la-${suffix}@test.local`,
    displayName: 'Ledger administration fixture', passwordHash: 'fixture-only', role,
  } });
}
function headers(user: { id: string; role: string; username: string; email: string | null }) {
  const token = server.jwt.sign({ sub: user.id, roles: [user.role],
    username: user.username, ...(user.email ? { email: user.email } : {}) });
  return { authorization: `Bearer ${token}` };
}
/** A Coin adjustment through the administration API: request, first
 * approval, then the second approval that settles it. */
async function adjustViaApi(targetUserId: string, delta: number, evidence: string,
  first: Parameters<typeof headers>[0], second: Parameters<typeof headers>[0]) {
  const requested = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`, headers: headers(first),
    payload: { targetUserId, caseId: `la-adjust-${tag()}`, delta,
      rationale: 'Documented historical balance correction', supportingEvidence: [evidence] } });
  expect(requested.statusCode, requested.body).toBe(201);
  const approvalId = requested.json().data.approvalId as string;
  const approved = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/first-approval`,
    headers: headers(first) });
  expect(approved.statusCode, approved.body).toBe(200);
  const executed = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/second-approval`,
    headers: headers(second) });
  expect(executed.statusCode, executed.body).toBe(201);
  return executed.json().data as { approvalId: string; operationId: string; reviewLotId: string | null };
}

async function expectCoinBalance(userId: string, expected: number) {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  const lots = await prisma.coinProvenance.findMany({ where: { userId } });
  expect(wallet.coinsBalance).toBe(expected);
  expect(lots.reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0)).toBe(expected);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});
afterAll(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});

describeIf('ledger administration API', () => {
  it('requires SUPER_ADMIN and two distinct administrators for a reviewed U balance', async () => {
    const owner = await makeUser('USER');
    const regular = await makeUser('USER');
    const first = await makeUser('SUPER_ADMIN');
    const second = await makeUser('SUPER_ADMIN');
    const credit = await executeTestAdjustment(owner.id, 27, { first, second });
    const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: credit.reviewLotId! } });
    const denied = await server.inject({ method: 'GET', url: `${endpoint}/reviews`, headers: headers(regular) });
    expect(denied.statusCode).toBe(403);
    const queue = await server.inject({ method: 'GET', url: `${endpoint}/reviews`, headers: headers(first) });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.some((item: { id: string }) => item.id === review.id)).toBe(true);
    const terms = { decision: 'WITHDRAWABLE', rationale: 'Two independent administrators verified source',
      supportingEvidence: ['case-ledger-001'] };
    const firstApproval = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/first-approval`, headers: headers(first), payload: terms });
    expect(firstApproval.statusCode).toBe(200);
    const sameAdmin = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/second-approval`, headers: headers(first) });
    expect(sameAdmin.statusCode).toBe(409);
    const resolved = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/second-approval`, headers: headers(second) });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.idempotent).toBe(false);
    const retry = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/second-approval`, headers: headers(second) });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data).toMatchObject({ operationId: resolved.json().data.operationId, idempotent: true });
    const lots = await prisma.coinProvenance.findMany({ where: { userId: owner.id } });
    expect(lots.reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0)).toBe(27);
    expect(lots.filter((lot) => lot.lotClass === 'WITHDRAWABLE')
      .reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0)).toBe(27);
  });

  it('restarts dual approval when review-required Coins are spent between approvals', async () => {
    const owner = await makeUser('USER');
    const first = await makeUser('SUPER_ADMIN');
    const second = await makeUser('SUPER_ADMIN');
    const credit = await adjustViaApi(owner.id, 27, 'case-review-stale-001', first, second);
    await expectCoinBalance(owner.id, 27);
    const review = await prisma.legacyBalanceReview.findFirstOrThrow({
      where: { lotId: credit.reviewLotId! },
    });
    const terms = { decision: 'WITHDRAWABLE',
      rationale: 'Independent administrators verified this balance',
      supportingEvidence: ['case-review-stale-001'] };
    const approval = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/first-approval`,
      headers: headers(first), payload: terms });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().data.evidence.proposal.amount).toBe(27);
    await expectCoinBalance(owner.id, 27);

    // A real negative admin adjustment consumes seven Coins from the U lot.
    // The two requests are ordered by completion, without timing sleeps.
    await adjustViaApi(owner.id, -7, 'case-review-stale-002', first, second);
    await expectCoinBalance(owner.id, 20);
    const stale = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/second-approval`, headers: headers(second) });
    expect(stale.statusCode).toBe(409);
    const reopened = await prisma.legacyBalanceReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(reopened.status).toBe('OPEN');
    expect(reopened.resolvedBy).toBeNull();
    expect(reopened.resolutionOperationId).toBeNull();
    expect((reopened.evidence as { invalidatedApprovals?: unknown[] }).invalidatedApprovals).toHaveLength(1);
    await expectCoinBalance(owner.id, 20);
    expect(await prisma.economicOperation.count({ where: {
      type: 'LEGACY_RESOLVE', scopeType: 'REVIEW', scopeId: review.id,
    } })).toBe(0);

    const renewed = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/first-approval`,
      headers: headers(first), payload: terms });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().data.evidence.proposal.amount).toBe(20);
    await expectCoinBalance(owner.id, 20);
    const resolved = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${review.id}/second-approval`, headers: headers(second) });
    expect(resolved.statusCode).toBe(200);
    await expectCoinBalance(owner.id, 20);
    const lots = await prisma.coinProvenance.findMany({ where: { userId: owner.id } });
    expect(lots.filter((lot) => lot.lotClass === 'WITHDRAWABLE')
      .reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0)).toBe(20);
  });

  it('exposes configured draft activation/deactivation and evidence-bearing adjustments', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const independentAdmin = await makeUser('SUPER_ADMIN');
    const owner = await makeUser('USER');
    let code = '';
    for (let i = 0; i < 676; i++) {
      const candidate = `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`;
      if (!await prisma.country.findUnique({ where: { code: candidate } })) { code = candidate; break; }
    }
    expect(code).not.toBe('');
    await prisma.country.create({ data: { code, name: `Ledger admin ${tag()}`, currencyCode: 'USD', isActive: true } });
    const policy = {
      minWithdrawal: 10, maxWithdrawal: 1000, dailyWithdrawalLimit: 1000,
      monthlyWithdrawalLimit: 10000, playthroughMultiplier: 2,
      qualifyingGames: ['spin_win'], maxQualifyingStake: 100,
      holdingPeriodHours: 1, giftDailyLimit: 100, kycTierRequired: 0,
      supportedPaymentMethods: ['BANK_TRANSFER'], withdrawalFeePercent: 0,
      manualReviewThreshold: 1000, maxConversionMultiple: null,
      bonusExpiryHours: null,
    };
    const draft = await server.inject({ method: 'POST', url: `${endpoint}/policies/${code}/drafts`,
      headers: headers(admin), payload: policy });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().data.state).toBe('DRAFT');
    const activated = await server.inject({ method: 'POST',
      url: `${endpoint}/policies/${code}/versions/1/activate`, headers: headers(admin) });
    expect(activated.statusCode).toBe(200);
    const pointer = await prisma.countryJurisdiction.findUniqueOrThrow({ where: { countryCode: code } });
    expect(pointer.activePolicyId).toBe(activated.json().data.policyId);
    const reviewCredit = await executeTestAdjustment(owner.id, 13, { first: admin, second: await makeUser('SUPER_ADMIN') });
    const restrictedReview = await prisma.legacyBalanceReview.findFirstOrThrow({
      where: { lotId: reviewCredit.reviewLotId! },
    });
    const restrictedTerms = { decision: 'RESTRICTED', countryCode: code,
      rationale: 'Independent administrators verified restricted origin',
      supportingEvidence: ['case-ledger-restricted-001'] };
    const firstRestricted = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${restrictedReview.id}/first-approval`,
      headers: headers(admin), payload: restrictedTerms });
    expect(firstRestricted.statusCode).toBe(200);
    const replacement = await server.inject({ method: 'POST',
      url: `${endpoint}/policies/${code}/drafts`,
      headers: headers(admin), payload: policy });
    expect(replacement.statusCode).toBe(201);
    const activatedReplacement = await server.inject({ method: 'POST',
      url: `${endpoint}/policies/${code}/versions/2/activate`, headers: headers(admin) });
    expect(activatedReplacement.statusCode).toBe(200);
    const stalePolicyApproval = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${restrictedReview.id}/second-approval`,
      headers: headers(independentAdmin) });
    expect(stalePolicyApproval.statusCode).toBe(409);
    expect((await prisma.legacyBalanceReview.findUniqueOrThrow({
      where: { id: restrictedReview.id },
    })).status).toBe('OPEN');
    const renewedRestricted = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${restrictedReview.id}/first-approval`,
      headers: headers(admin), payload: restrictedTerms });
    expect(renewedRestricted.statusCode).toBe(200);
    expect(renewedRestricted.json().data.evidence.proposal.policyId)
      .toBe(activatedReplacement.json().data.policyId);
    const resolvedRestricted = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${restrictedReview.id}/second-approval`,
      headers: headers(independentAdmin) });
    expect(resolvedRestricted.statusCode).toBe(200);
    const off = await server.inject({ method: 'POST',
      url: `${endpoint}/policies/${code}/deactivate`, headers: headers(admin) });
    expect(off.statusCode).toBe(200);
    const replayAfterDeactivation = await server.inject({ method: 'POST',
      url: `${endpoint}/reviews/${restrictedReview.id}/second-approval`,
      headers: headers(independentAdmin) });
    expect(replayAfterDeactivation.statusCode).toBe(200);
    expect(replayAfterDeactivation.json().data).toMatchObject({
      operationId: resolvedRestricted.json().data.operationId, idempotent: true,
    });
    const adjustmentCase = `la-adjust-${tag()}`;
    const adjustmentsBefore = await prisma.economicOperation.count({ where: { userId: owner.id, type: 'ADMIN_ADJUST' } });
    const terms = { targetUserId: owner.id, caseId: adjustmentCase, delta: 9,
      rationale: 'Documented historical credit correction', supportingEvidence: ['case-ledger-002'] };
    const adjust = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
      headers: headers(admin), payload: terms });
    expect(adjust.statusCode, adjust.body).toBe(201);
    expect(adjust.json().data).toMatchObject({ status: 'PENDING', idempotent: false });
    const approvalId = adjust.json().data.approvalId as string;
    const replay = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
      headers: headers(admin), payload: terms });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({ approvalId, idempotent: true });
    const changedTerms = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
      headers: headers(admin), payload: { ...terms, delta: 10 } });
    expect(changedTerms.statusCode).toBe(409);
    const queue = await server.inject({ method: 'GET', url: `${endpoint}/adjustments`, headers: headers(independentAdmin) });
    expect(queue.json().data.map((row: { id: string }) => row.id)).toContain(approvalId);
    const first = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/first-approval`,
      headers: headers(admin) });
    expect(first.statusCode, first.body).toBe(200);
    const sameAdmin = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/second-approval`,
      headers: headers(admin) });
    expect(sameAdmin.statusCode).toBe(409);
    expect(await prisma.economicOperation.count({ where: { userId: owner.id, type: 'ADMIN_ADJUST' } })).toBe(adjustmentsBefore);
    const executed = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/second-approval`,
      headers: headers(independentAdmin) });
    expect(executed.statusCode, executed.body).toBe(201);
    const executedReplay = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${approvalId}/second-approval`,
      headers: headers(independentAdmin) });
    expect(executedReplay.statusCode).toBe(200);
    expect(executedReplay.json().data).toMatchObject({ operationId: executed.json().data.operationId, idempotent: true });
    expect(await prisma.economicOperation.count({ where: { userId: owner.id, type: 'ADMIN_ADJUST' } })).toBe(adjustmentsBefore + 1);
    const review = await prisma.legacyBalanceReview.findFirst({ where: { lotId: executed.json().data.reviewLotId } });
    expect(review?.status).toBe('OPEN');
  });

  it('refuses malformed adjustment requests before anything is recorded', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const owner = await makeUser('USER');
    const valid = { targetUserId: owner.id, caseId: `la-adjust-${tag()}`, delta: 5,
      rationale: 'Documented historical credit correction', supportingEvidence: ['case-ledger-003'] };
    for (const change of [
      { delta: 1.5 }, { delta: '5' }, { delta: 0 }, { delta: -0.25 }, { delta: 1_000_000_001 },
      { delta: -1_000_000_001 }, { delta: 2 ** 53 }, { delta: null }, { delta: undefined },
      { rationale: '' }, { rationale: '          ' }, { rationale: 'too short' },
      { supportingEvidence: [] }, { supportingEvidence: [''] }, { supportingEvidence: ['   '] },
      { supportingEvidence: [7] }, { supportingEvidence: 'case-ledger-003' }, { supportingEvidence: {} },
      { caseId: '' }, { targetUserId: '' }, { extra: true },
    ]) {
      const response = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
        headers: headers(admin), payload: { ...valid, ...change } });
      expect(response.statusCode, JSON.stringify(change)).toBe(400);
    }
    const selfAdjust = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
      headers: headers(admin), payload: { ...valid, targetUserId: admin.id } });
    expect(selfAdjust.statusCode).toBe(403);
    const regular = await makeUser('USER');
    const notAdmin = await server.inject({ method: 'POST', url: `${endpoint}/adjustments`,
      headers: headers(regular), payload: valid });
    expect(notAdmin.statusCode).toBe(403);
    const noReason = await server.inject({ method: 'POST', url: `${endpoint}/adjustments/${tag()}/reject`,
      headers: headers(admin), payload: { reason: '   ' } });
    expect(noReason.statusCode).toBe(400);
    expect(await prisma.adminAdjustmentApproval.count({ where: { userId: { in: [owner.id, admin.id] } } })).toBe(0);
  });

  it('rejects a stale SUPER_ADMIN token after the database role is removed', async () => {
    const admin = await makeUser('SUPER_ADMIN');
    const owner = await makeUser('USER');
    const staleHeaders = headers(admin);
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    const before = await prisma.economicOperation.count({ where: { userId: owner.id } });
    const requests = [
      { method: 'GET' as const, url: `${endpoint}/reviews` },
      { method: 'POST' as const, url: `${endpoint}/legacy-classifications/${owner.id}/preview` },
      { method: 'POST' as const, url: `${endpoint}/legacy-classifications/${owner.id}/apply` },
    ];
    for (const request of requests) {
      const response = await server.inject({ ...request, headers: staleHeaders });
      expect(response.statusCode).toBe(403);
    }
    expect(await prisma.economicOperation.count({ where: { userId: owner.id } })).toBe(before);
  });
});
