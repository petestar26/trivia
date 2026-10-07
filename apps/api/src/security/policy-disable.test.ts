import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(), factor: { findUnique: vi.fn() },
  step: { findFirst: vi.fn(), updateMany: vi.fn() },
  policy: { upsert: vi.fn() }, audit: { create: vi.fn() }, notification: { create: vi.fn() },
}));
vi.mock('@socialplay/database', () => ({ prisma: { $transaction: m.transaction } }));
vi.mock('./totp-service.js', () => ({ verifyTotpForUser: vi.fn() }));
import { setOwnStepUpPolicy, DISABLE_STEP_UP_POLICY_PURPOSE } from './step-up-service.js';
beforeEach(() => {
  vi.resetAllMocks();
  m.transaction.mockImplementation(fn => fn({ userTotpFactor: m.factor,
    stepUpVerification: m.step, userSecurityPolicy: m.policy, auditLog: m.audit,
    notification: m.notification }));
  m.step.findFirst.mockResolvedValue({ id: 'proof' });
  m.step.updateMany.mockResolvedValue({ count: 1 });
  m.policy.upsert.mockResolvedValue({ requiresStepUpForSensitiveOps: false });
});
it('refuses cookie-only downgrade with no token context', async () => {
  await expect(setOwnStepUpPolicy('u', false)).rejects.toMatchObject({ statusCode: 403 });
  expect(m.policy.upsert).not.toHaveBeenCalled();
});
it('refuses missing scoped proof without changing policy or notifying', async () => {
  m.step.findFirst.mockResolvedValue(null);
  await expect(setOwnStepUpPolicy('u', false, {tokenIat: 10})).rejects.toMatchObject({ statusCode: 403 });
  expect(m.policy.upsert).not.toHaveBeenCalled();
  expect(m.notification.create).not.toHaveBeenCalled();
});
it('scopes proof to current user, token, purpose, expiry and unused state', async () => {
  await setOwnStepUpPolicy('u', false, {tokenIat: 10});
  expect(m.step.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
    userId: 'u', tokenIat: 10, purpose: DISABLE_STEP_UP_POLICY_PURPOSE,
    consumedAt: null, expiresAt: {gt: expect.any(Date)},
  }}));
  expect(m.notification.create).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({
    userId: 'u', type: 'SYSTEM', data: {securityEvent: 'STEP_UP_POLICY_DISABLED'},
  })}));
});
it('a lost single-use claim cannot disable the policy', async () => {
  m.step.updateMany.mockResolvedValue({ count: 0 });
  await expect(setOwnStepUpPolicy('u', false, {tokenIat: 10})).rejects.toMatchObject({statusCode: 403});
  expect(m.policy.upsert).not.toHaveBeenCalled();
});
it('notification failure rejects the encompassing transaction', async () => {
  m.notification.create.mockRejectedValue(new Error('notification unavailable'));
  await expect(setOwnStepUpPolicy('u', false, {tokenIat: 10})).rejects.toThrow('notification unavailable');
});
