import { PrismaClient } from '@prisma/client';

// Initialize the requested Birr configuration only. Never creates receiving
// destinations, agents, exchange rates, financial approvals or money balances.
if (
  process.argv.length !== 3 ||
  process.argv[2] !== '--initialize-etb' ||
  process.env.RAILWAY_PROJECT_ID !== '95bd9da5-59ea-4f49-b2b1-9114e8a1a0a2' ||
  process.env.RAILWAY_ENVIRONMENT_ID !== 'e48c2274-6993-446e-8a54-c33e4d6f698e' ||
  process.env.RAILWAY_SERVICE_ID !== 'ffe7dd49-e409-4a46-95a8-7614d2e96095'
) {
  throw Error('PAYMENT_SETUP_TARGET_REFUSED');
}
const db = new PrismaClient({ log: [] });
try {
  await db.$transaction(async (tx) => {
    const country = await tx.country.upsert({
      where: { code: 'ET' },
      update: {},
      create: {
        code: 'ET',
        name: 'Ethiopia',
        currencyCode: 'ETB',
        isActive: true,
        agentPaymentEnabled: false,
        usdPricingEnabled: false,
        displayOrder: 0,
      },
    });
    if (country.currencyCode !== 'ETB') throw Error('PAYMENT_SETUP_CURRENCY_CONFLICT');
    for (const method of [
      { name: 'Telebirr', type: 'MOBILE_PAYMENT' as const, fields: ['accountName', 'phoneNumber'] },
      {
        name: 'Bank transfer',
        type: 'BANK_TRANSFER' as const,
        fields: ['bankName', 'accountName', 'accountNumber'],
      },
    ]) {
      await tx.paymentMethodDefinition.upsert({
        where: {
          countryId_type_name: { countryId: country.id, type: method.type, name: method.name },
        },
        update: {},
        create: {
          countryId: country.id,
          type: method.type,
          name: method.name,
          isActive: true,
          fieldSchema: { requiredFields: method.fields },
        },
      });
    }
  });
  console.log(
    JSON.stringify({ event: 'SALEM_ETB_SETUP_READY', financialServicesActivated: false })
  );
} catch {
  console.error(JSON.stringify({ event: 'SALEM_ETB_SETUP_FAILED' }));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
