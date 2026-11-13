import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { fixtureEtbPolicy } from './payment-policy-fixture.js';

afterAll(() => prisma.$disconnect());

it('refuses unbounded rate fixture purges', async () => {
  for (const countryId of [undefined, '', {}, { not: '' }, { notIn: [] }, { in: [] }]) {
    await expect(prisma.exchangeRateConfig.deleteMany({ where: { countryId } } as any))
      .rejects.toThrow('Unscoped ExchangeRateConfig fixture purge refused');
  }
});

it('purges only named fixture countries and restores append-only enforcement', async () => {
  const tag = randomUUID();
  const user = await prisma.user.create({ data: { email: `${tag}@test.local`, username: tag, passwordHash: 'fixture-only' } });
  const country = await prisma.country.create({ data: { code: tag.slice(0, 8), name: 'Rate cleanup fixture', currencyCode: 'ETB' } });
  const rate = await prisma.exchangeRateConfig.create({ data: { countryId: country.id, fiatCurrency: 'ETB', coinsPerUnit: 1, setBy: user.id, pricingPolicy: fixtureEtbPolicy() } });
  try {
    await expect(prisma.$executeRaw`DELETE FROM exchange_rate_configs WHERE id = ${rate.id}`).rejects.toThrow(/append-only/);
    expect(await prisma.exchangeRateConfig.deleteMany({ where: { countryId: country.id } })).toEqual({ count: 1 });
    const next = await prisma.exchangeRateConfig.create({ data: { countryId: country.id, fiatCurrency: 'ETB', coinsPerUnit: 1, setBy: user.id, pricingPolicy: fixtureEtbPolicy() } });
    await expect(prisma.$executeRaw`DELETE FROM exchange_rate_configs WHERE id = ${next.id}`).rejects.toThrow(/append-only/);
  } finally {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: country.id } });
    await prisma.country.delete({ where: { id: country.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
