import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  factor: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  policy: { upsert: vi.fn() },
  audit: { create: vi.fn() },
  notification: { create: vi.fn() },
  transaction: vi.fn(),
  consume: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({
  prisma: {
    userTotpFactor: m.factor,
    auditLog: m.audit,
    notification: m.notification,
    $transaction: m.transaction,
  },
}));
vi.mock('./crypto.js', () => ({
  decryptSecret: () => 'fixture',
  encryptSecret: vi.fn(),
  isTotpEncryptionConfigured: () => true,
}));
vi.mock('./totp.js', () => ({
  verifyTotpCode: m.verify,
  generateTotpSecret: vi.fn(),
  buildOtpAuthUri: vi.fn(),
  TOTP_DIGITS: 6,
}));
vi.mock('./challenge-service.js', () => ({ consumeChallenge: m.consume, issueChallenge: vi.fn() }));
import { activateTotpFactor } from './totp-service.js';
beforeEach(() => {
  vi.resetAllMocks();
  m.factor.findUnique.mockResolvedValue({
    status: 'PENDING_ACTIVATION',
    encryptedSecret: 'fixture',
    lastUsedTimeStep: null,
  });
  m.verify.mockReturnValue({ valid: true, timeStep: 5 });
  m.factor.updateMany.mockResolvedValue({ count: 1 });
  m.factor.findUniqueOrThrow.mockResolvedValue({ status: 'ACTIVE' });
  m.transaction.mockImplementation((fn) =>
    fn({ userTotpFactor: m.factor, userSecurityPolicy: m.policy })
  );
});
it('enables sensitive-operation policy inside factor activation transaction', async () => {
  await activateTotpFactor('u', 'challenge', '123456');
  expect(m.policy.upsert).toHaveBeenCalledWith({
    where: { userId: 'u' },
    create: { userId: 'u', requiresStepUpForSensitiveOps: true },
    update: { requiresStepUpForSensitiveOps: true },
  });
  expect(m.consume).toHaveBeenCalledWith(
    'u',
    'TOTP_ENROLLMENT',
    'challenge',
    expect.objectContaining({ userSecurityPolicy: m.policy })
  );
});
it('does not enable policy when the activation claim is lost', async () => {
  m.factor.updateMany.mockResolvedValue({ count: 0 });
  await expect(activateTotpFactor('u', 'challenge', '123456')).rejects.toThrow();
  expect(m.policy.upsert).not.toHaveBeenCalled();
});
it('fails activation if policy persistence fails, without a success notification', async () => {
  m.policy.upsert.mockRejectedValue(new Error('policy unavailable'));
  await expect(activateTotpFactor('u', 'challenge', '123456')).rejects.toThrow(
    'policy unavailable'
  );
  expect(m.notification.create).not.toHaveBeenCalled();
  expect(m.audit.create).not.toHaveBeenCalled();
});
