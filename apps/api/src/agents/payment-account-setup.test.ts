import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  country: { findUnique: vi.fn() },
  agent: { findUnique: vi.fn() },
  paymentMethodDefinition: { findUnique: vi.fn() },
  agentPaymentAccount: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
  agentOrder: { findUnique: vi.fn(), create: vi.fn() },
  withdrawal: { findUnique: vi.fn(), create: vi.fn() },
  withdrawalQuote: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  selectPaymentRate: vi.fn(),
  lockUserEconomicScope: vi.fn(),
  reserveWithdrawalCoins: vi.fn(),
}));

vi.mock('@socialplay/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@socialplay/database')>()),
  prisma: m,
}));
vi.mock('./usd-config-service.js', () => ({ selectPaymentRate: m.selectPaymentRate }));
vi.mock('../economy/coin-ledger-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../economy/coin-ledger-service.js')>()),
  lockUserEconomicScope: m.lockUserEconomicScope,
  reserveWithdrawalCoins: m.reserveWithdrawalCoins,
}));

import { createAgentPaymentAccount, updateAgentPaymentAccount } from './payment-account-service.js';
import { createAgentOrder } from './order-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { createWithdrawal } from '../withdrawals/withdrawal-service.js';

const country = { id: 'et', isActive: true, agentPaymentEnabled: false, currencyCode: 'ETB' };
const method = {
  id: 'telebirr', countryId: 'et', isActive: true,
  fieldSchema: { requiredFields: ['accountName', 'accountNumber'] },
};
const details = { accountName: 'Fixture Agent', accountNumber: 'fixture-only-number' };
const args = { countryId: country.id, methodDefId: method.id, accountDetails: details };
const existing = {
  id: 'account', agentId: 'agent', countryId: country.id, methodDefId: method.id,
  accountDetails: details, status: 'APPROVED', reviewedBy: 'admin', reviewedAt: new Date(),
};

beforeEach(() => {
  vi.resetAllMocks();
  m.agent.findUnique.mockResolvedValue({ id: 'agent', userId: 'agent-user', countryId: 'et', status: 'ACTIVE' });
  m.country.findUnique.mockResolvedValue({ ...country });
  m.paymentMethodDefinition.findUnique.mockResolvedValue({ ...method });
  m.$transaction.mockImplementation(async (fn) => fn(m));
  m.agentPaymentAccount.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data }));
  m.agentPaymentAccount.findUnique.mockResolvedValue({ ...existing });
  m.agentPaymentAccount.updateMany.mockResolvedValue({ count: 1 });
  m.auditLog.create.mockResolvedValue({ id: 'audit' });
  m.agentOrder.findUnique.mockResolvedValue(null);
  m.withdrawal.findUnique.mockResolvedValue(null);
  m.withdrawalQuote.findUnique.mockResolvedValue({ id: 'quote', userId: 'member', countryId: 'et' });
  m.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
    const query = sql.join('?');
    if (query.includes('FROM users')) return [{ status: 'ACTIVE' }];
    if (query.includes('FROM user_payout_accounts')) {
      return [{ id: 'payout', userId: 'member', countryId: 'et', methodDefId: method.id, status: 'ACTIVE' }];
    }
    if (query.includes('FROM payment_method_definitions')) return [{ ...method, type: 'MOBILE_PAYMENT' }];
    if (query.includes('FROM countries')) return [{ ...country }];
    throw new Error(`Unexpected query in payment admission test: ${query}`);
  });
});

describe('receiving-account preparation while customer payments are paused', () => {
  it('creates an account for review without enabling country payments', async () => {
    const account = await createAgentPaymentAccount('agent-user', {
      ...args, accountDetails: { accountName: ' Fixture Agent ', accountNumber: ' fixture-only-number ' },
    });
    expect(account).toMatchObject({ agentId: 'agent', status: 'PENDING_APPROVAL', accountDetails: details });
    expect(m.agent.findUnique).toHaveBeenCalledWith({ where: { userId: 'agent-user' } });
    expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'AGENT_PAYMENT_ACCOUNT_CREATED', entityId: 'created' }),
    }));
    expect(country.agentPaymentEnabled).toBe(false);
  });

  it.each(['APPROVED', 'PENDING_APPROVAL', 'REJECTED'])(
    'allows editing a %s account and clears its previous review', async (status) => {
      m.agentPaymentAccount.findUnique
        .mockResolvedValueOnce({ ...existing, status })
        .mockResolvedValueOnce({ ...existing, status: 'PENDING_APPROVAL', reviewedBy: null, reviewedAt: null });
      const account = await updateAgentPaymentAccount('agent-user', 'account', args);
      expect(account).toMatchObject({ id: 'account', status: 'PENDING_APPROVAL', reviewedBy: null, reviewedAt: null });
      expect(m.agentPaymentAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'account', agentId: 'agent' }),
        data: expect.objectContaining({ status: 'PENDING_APPROVAL', reviewedBy: null, reviewedAt: null }),
      }));
      expect(m.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'AGENT_PAYMENT_ACCOUNT_MODIFIED',
          oldData: { status, countryId: 'et', methodDefId: method.id },
          newData: { status: 'PENDING_APPROVAL', countryId: 'et', methodDefId: method.id },
        }),
      }));
    }
  );

  const operations = [
    ['create', () => createAgentPaymentAccount('agent-user', args)],
    ['edit', () => updateAgentPaymentAccount('agent-user', 'account', args)],
  ] as const;

  describe.each(operations)('%s validation', (_name, operation) => {
    it('rejects an inactive country before attempting any mutation', async () => {
      m.country.findUnique.mockResolvedValue({ ...country, isActive: false });
      await expect(operation()).rejects.toMatchObject({ statusCode: 400 });
      expect(m.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an inactive method', async () => {
      m.paymentMethodDefinition.findUnique.mockResolvedValue({ ...method, isActive: false });
      await expect(operation()).rejects.toThrow('not currently active');
      expect(m.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a method belonging to a different country', async () => {
      m.paymentMethodDefinition.findUnique.mockResolvedValue({ ...method, countryId: 'other-country' });
      await expect(operation()).rejects.toThrow('does not belong to the selected country');
      expect(m.$transaction).not.toHaveBeenCalled();
    });

    it.each(['TEMPORARILY_SUSPENDED', 'UNDER_REVIEW', 'DISABLED'])(
      'rejects a %s agent before reading destination configuration', async (status) => {
        m.agent.findUnique.mockResolvedValue({ id: 'agent', status });
        await expect(operation()).rejects.toMatchObject({ statusCode: 403 });
        expect(m.country.findUnique).not.toHaveBeenCalled();
        expect(m.$transaction).not.toHaveBeenCalled();
      }
    );

    it('still requires the method-defined fields', async () => {
      m.paymentMethodDefinition.findUnique.mockResolvedValue({
        ...method, fieldSchema: { requiredFields: ['accountName', 'accountNumber', 'requiredReference'] },
      });
      await expect(operation()).rejects.toThrow('accountDetails.requiredReference is required');
      expect(m.$transaction).not.toHaveBeenCalled();
    });
  });

  it('does not let an agent edit another agent’s account', async () => {
    m.agentPaymentAccount.findUnique.mockResolvedValue({ ...existing, agentId: 'other-agent' });
    await expect(updateAgentPaymentAccount('agent-user', 'account', args)).rejects.toMatchObject({ statusCode: 403 });
    expect(m.agentPaymentAccount.updateMany).not.toHaveBeenCalled();
  });

  it('preserves a disabled account as historical and refuses to re-enable it by editing', async () => {
    m.agentPaymentAccount.findUnique.mockResolvedValue({ ...existing, status: 'DISABLED' });
    m.agentPaymentAccount.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateAgentPaymentAccount('agent-user', 'account', args)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.agentPaymentAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['APPROVED', 'PENDING_APPROVAL', 'REJECTED'] } }),
    }));
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('paused country still blocks new customer financial requests', () => {
  it('rejects a new deposit order before reserving inventory or writing an order', async () => {
    await expect(createAgentOrder('member', {
      agentId: 'agent', countryId: 'et', paymentAccountId: 'account', fiatAmount: 100,
      idempotencyKey: 'paused-deposit',
    })).rejects.toThrow('Agent payments are not available for this country');
    expect(m.$transaction).not.toHaveBeenCalled();
    expect(m.agentOrder.create).not.toHaveBeenCalled();
    expect(m.selectPaymentRate).not.toHaveBeenCalled();
  });

  it('rejects a new withdrawal quote before pricing or persisting it', async () => {
    await expect(createWithdrawalQuote('member', { countryId: 'et', coinAmount: 100 }))
      .rejects.toThrow('Withdrawals are not available for this country');
    expect(m.withdrawalQuote.create).not.toHaveBeenCalled();
    expect(m.selectPaymentRate).not.toHaveBeenCalled();
  });

  it('rejects a withdrawal using an earlier quote before claiming the quote or holding funds', async () => {
    await expect(createWithdrawal('member', {
      quoteId: 'quote', payoutAccountId: 'payout', idempotencyKey: 'paused-withdrawal',
    }, 1)).rejects.toThrow('Withdrawals are not available for this country');
    expect(m.withdrawalQuote.updateMany).not.toHaveBeenCalled();
    expect(m.withdrawal.create).not.toHaveBeenCalled();
    expect(m.reserveWithdrawalCoins).not.toHaveBeenCalled();
  });
});
