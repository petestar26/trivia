import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { creditCoins } from './coin-ledger-service.js';
import { sweepExpiredCoinLots } from './coin-expiry-service.js';

afterAll(async () => prisma.$disconnect());

async function createExpiryCountry(): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = `Z${randomUUID().replaceAll('-', '').slice(0, 2).toUpperCase()}`;
    try {
      await prisma.country.create({ data: {
        code, name: `Expiry ${code}`, currencyCode: 'USD', isActive: true,
      } });
      return code;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  throw new Error('Could not reserve an expiry-test country code');
}

it('forfeits an expired restricted lot exactly once with matching wallet debit and immutable operation', async () => {
  const tag = randomUUID().replaceAll('-', '');
  const user = await prisma.user.create({ data: {
    email: `expiry-${tag}@test.local`, username: `ex${tag.slice(0, 14)}`,
    passwordHash: 'fixture-only',
  } });
  const code = await createExpiryCountry();
  const policy = await prisma.countryCasinoPolicy.create({ data: { countryCode: code, version: 1 } });
  const lot = await prisma.$transaction((tx) => creditCoins(tx, user.id, 30, {
    type: 'BONUS_GRANT', scopeType: 'GAME_SESSION', scopeId: randomUUID(),
    referenceType: 'GAME', description: 'Expiry test grant',
    policy: { id: policy.id, version: policy.version },
    requirementAmount: 150, expiresAt: new Date(Date.now() - 60_000),
  }));
  const first = await sweepExpiredCoinLots();
  expect(first.expired).toBe(1);
  const second = await sweepExpiredCoinLots();
  expect(second.expired).toBe(0);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } });
  const expired = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: lot.lotId } });
  expect(wallet.coinsBalance).toBe(0);
  expect(expired.state).toBe('EXPIRED');
  expect(expired.availableAmount).toBe(0);
  const operations = await prisma.economicOperation.findMany({ where: {
    type: 'BONUS_EXPIRY', userId: user.id, scopeType: 'LOT', scopeId: lot.lotId,
  } });
  expect(operations).toHaveLength(1);
  expect(operations[0].walletTransactionIds).toHaveLength(1);
  const entries = await prisma.coinLotEntry.findMany({ where: { operationId: operations[0].id } });
  expect(entries).toHaveLength(1);
  expect(entries[0].entryType).toBe('FORFEIT');
  expect(entries[0].availableDelta).toBe(-30);
});
