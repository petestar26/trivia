import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  country: { findUnique: vi.fn() },
  paymentMethodDefinition: { findUnique: vi.fn() },
  userPayoutAccount: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  withdrawalQuote: { create: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: db,
}));
import { createUserPayoutAccount } from './payout-account-service.js';
import { createWithdrawalQuote } from './quote-service.js';
const body = {
  countryId: 'et',
  methodDefId: 'telebirr',
  accountDetails: { phoneNumber: 'test-only' },
};
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((fn) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.country.findUnique.mockResolvedValue({ id: 'et', isActive: true, agentPaymentEnabled: false });
  db.paymentMethodDefinition.findUnique.mockResolvedValue({
    id: 'telebirr',
    countryId: 'et',
    isActive: true,
    fieldSchema: { requiredFields: ['phoneNumber'] },
  });
  db.userPayoutAccount.create.mockResolvedValue({ id: 'destination' });
});
it('allows a member to prepare their own destination while payments are paused', async () => {
  await expect(createUserPayoutAccount('member', body)).resolves.toEqual({ id: 'destination' });
  expect(db.userPayoutAccount.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      userId: 'member',
      countryId: 'et',
      status: 'ACTIVE',
      accountDetails: body.accountDetails,
    }),
  });
  expect(db.auditLog.create).toHaveBeenCalledOnce();
  expect(db.withdrawalQuote.create).not.toHaveBeenCalled();
});
it('still refuses withdrawal quotes in that paused country', async () => {
  await expect(
    createWithdrawalQuote('member', { countryId: 'et', coinAmount: 500 })
  ).rejects.toThrow(/not available/);
  expect(db.withdrawalQuote.create).not.toHaveBeenCalled();
});
it('refuses inactive countries', async () => {
  db.country.findUnique.mockResolvedValue({ isActive: false, agentPaymentEnabled: false });
  await expect(createUserPayoutAccount('member', body)).rejects.toThrow(/not available/);
  expect(db.userPayoutAccount.create).not.toHaveBeenCalled();
});
it.each([
  { countryId: 'other', isActive: true },
  { countryId: 'et', isActive: false },
])('refuses invalid methods %j', async (method) => {
  db.paymentMethodDefinition.findUnique.mockResolvedValue(method);
  await expect(createUserPayoutAccount('member', body)).rejects.toThrow();
  expect(db.userPayoutAccount.create).not.toHaveBeenCalled();
});
