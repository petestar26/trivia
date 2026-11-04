import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  platformGate: { findMany: vi.fn() },
  cryptoAddress: { findFirst: vi.fn() },
}));
vi.mock('@socialplay/database', async (original) => ({
  ...(await original<typeof import('@socialplay/database')>()),
  prisma: db,
}));
import { options } from './service.js';
const keys = [
  'CRYPTO_DEPOSIT_CREATE',
  'CRYPTO_DEPOSIT_CREDIT',
  'CRYPTO_WITHDRAWAL_CREATE',
  'WITHDRAWAL_CREATE',
];
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((fn) => fn(db));
  db.$queryRaw.mockImplementation(async (strings) =>
    strings.join('').includes('FROM users')
      ? [{ status: 'ACTIVE', role: 'USER' }]
      : [{ id: 'et', name: 'Ethiopia' }]
  );
  db.platformGate.findMany.mockResolvedValue(keys.map((key) => ({ key, enabled: true })));
  db.cryptoAddress.findFirst.mockResolvedValue({ address: 'private-unassigned-address' });
});
it('reports availability without exposing any unassigned receiving address', async () => {
  const result = await options('member');
  expect(result).toMatchObject({
    depositEnabled: true,
    withdrawalEnabled: true,
    countries: [{ id: 'et', name: 'Ethiopia' }],
  });
  expect(JSON.stringify(result)).not.toContain('private-unassigned-address');
});
it.each(['CRYPTO_DEPOSIT_CREATE', 'CRYPTO_DEPOSIT_CREDIT'])(
  'does not offer deposits without %s',
  async (key) => {
    db.platformGate.findMany.mockResolvedValue(keys.map((k) => ({ key: k, enabled: k !== key })));
    expect(await options('member')).toMatchObject({
      depositEnabled: false,
      depositUnavailableReason: expect.stringMatching(/activation/),
    });
  }
);
it('does not offer deposits without an unused receiving address', async () => {
  db.cryptoAddress.findFirst.mockResolvedValue(null);
  expect(await options('member')).toMatchObject({
    depositEnabled: false,
    depositUnavailableReason: expect.stringMatching(/No receiving address/),
  });
});
it.each(['CRYPTO_WITHDRAWAL_CREATE', 'WITHDRAWAL_CREATE'])(
  'requires %s before offering withdrawals',
  async (key) => {
    db.platformGate.findMany.mockResolvedValue(keys.map((k) => ({ key: k, enabled: k !== key })));
    expect(await options('member')).toMatchObject({ withdrawalEnabled: false });
  }
);
