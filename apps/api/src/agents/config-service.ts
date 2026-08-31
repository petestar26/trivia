import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { assertPlatformAdmin } from './agent-service';

// Phase H scope: admin configuration management for Country,
// PaymentMethodDefinition, and ExchangeRateConfig — the "─── Configuration
// ───" section of the Agent Payment System schema. No production code in
// Phases D–G ever created these rows outside of test fixtures; without
// this, no agent can apply, no payment method can be offered, and no order
// can compute a coin amount through the application itself.

const COUNTRY_CODE_RE = /^[A-Z]{2}$/; // ISO 3166-1 alpha-2, per the schema's own comment
const CURRENCY_CODE_RE = /^[A-Z]{3}$/; // ISO 4217, per the schema's own comment
export type PaymentMethodTypeValue = 'BANK_TRANSFER' | 'MOBILE_PAYMENT';
const VALID_PAYMENT_METHOD_TYPES: PaymentMethodTypeValue[] = ['BANK_TRANSFER', 'MOBILE_PAYMENT'];

// ─── Country ────────────────────────────────────────────────────

export interface CreateCountryArgs {
  code: string;
  name: string;
  currencyCode: string;
  displayOrder?: number;
}

export async function createCountry(
  adminId: string,
  args: CreateCountryArgs,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  if (!COUNTRY_CODE_RE.test(args.code)) {
    throw ApiError.badRequest('code must be a 2-letter ISO 3166-1 alpha-2 code (e.g. "NG")');
  }
  if (!args.name || args.name.trim().length === 0) {
    throw ApiError.badRequest('name is required');
  }
  if (!CURRENCY_CODE_RE.test(args.currencyCode)) {
    throw ApiError.badRequest('currencyCode must be a 3-letter ISO 4217 code (e.g. "NGN")');
  }
  if (args.displayOrder !== undefined && !Number.isInteger(args.displayOrder)) {
    throw ApiError.badRequest('displayOrder must be an integer');
  }

  try {
    const country = await prisma.country.create({
      data: {
        code: args.code,
        name: args.name.trim(),
        currencyCode: args.currencyCode,
        displayOrder: args.displayOrder ?? 0,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_CONFIG_COUNTRY_CREATED',
        entity: 'Country',
        entityId: country.id,
        newData: { code: country.code, name: country.name, currencyCode: country.currencyCode },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return country;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw ApiError.conflict(`A country with code "${args.code}" already exists`);
    }
    throw err;
  }
}

/**
 * Toggles Country.isActive / Country.agentPaymentEnabled independently —
 * these are two distinct schema flags (a country can exist and be visible
 * without agent payments being enabled yet), so they are never conflated
 * into one "enabled" concept.
 */
export async function setCountryFlags(
  adminId: string,
  countryId: string,
  flags: { isActive?: boolean; agentPaymentEnabled?: boolean },
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);
  if (flags.isActive === undefined && flags.agentPaymentEnabled === undefined) {
    throw ApiError.badRequest('At least one of isActive or agentPaymentEnabled must be supplied');
  }

  const before = await prisma.country.findUnique({ where: { id: countryId } });
  if (!before) throw ApiError.notFound('Country not found');

  const country = await prisma.country.update({
    where: { id: countryId },
    data: {
      ...(flags.isActive !== undefined ? { isActive: flags.isActive } : {}),
      ...(flags.agentPaymentEnabled !== undefined ? { agentPaymentEnabled: flags.agentPaymentEnabled } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: adminId,
      action: 'AGENT_CONFIG_COUNTRY_UPDATED',
      entity: 'Country',
      entityId: countryId,
      oldData: { isActive: before.isActive, agentPaymentEnabled: before.agentPaymentEnabled },
      newData: { isActive: country.isActive, agentPaymentEnabled: country.agentPaymentEnabled },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return country;
}

export async function listCountries(includeInactive: boolean) {
  return prisma.country.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
}

// ─── PaymentMethodDefinition ────────────────────────────────────

export interface CreatePaymentMethodArgs {
  countryId: string;
  type: PaymentMethodTypeValue;
  name: string;
  requiredFields: string[];
}

export async function createPaymentMethod(
  adminId: string,
  args: CreatePaymentMethodArgs,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  const country = await prisma.country.findUnique({ where: { id: args.countryId } });
  if (!country) throw ApiError.badRequest('Invalid countryId');

  if (!VALID_PAYMENT_METHOD_TYPES.includes(args.type)) {
    throw ApiError.badRequest(`type must be one of: ${VALID_PAYMENT_METHOD_TYPES.join(', ')}`);
  }
  if (!args.name || args.name.trim().length === 0) {
    throw ApiError.badRequest('name is required');
  }
  // Validated against the exact shape payment-account-service.ts's
  // validateAccountDetails already requires — a misconfigured fieldSchema
  // created here would silently break every payment-account submission
  // against this method.
  if (
    !Array.isArray(args.requiredFields) ||
    args.requiredFields.length === 0 ||
    args.requiredFields.some((f) => typeof f !== 'string' || f.trim().length === 0)
  ) {
    throw ApiError.badRequest('requiredFields must be a non-empty array of non-empty field names');
  }

  try {
    const method = await prisma.paymentMethodDefinition.create({
      data: {
        countryId: args.countryId,
        type: args.type,
        name: args.name.trim(),
        fieldSchema: { requiredFields: args.requiredFields },
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_CONFIG_PAYMENT_METHOD_CREATED',
        entity: 'PaymentMethodDefinition',
        entityId: method.id,
        newData: { countryId: args.countryId, type: args.type, name: method.name, requiredFields: args.requiredFields },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return method;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw ApiError.conflict('A payment method with this type and name already exists for this country');
    }
    throw err;
  }
}

export async function setPaymentMethodActive(
  adminId: string,
  methodId: string,
  isActive: boolean,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  const before = await prisma.paymentMethodDefinition.findUnique({ where: { id: methodId } });
  if (!before) throw ApiError.notFound('Payment method not found');

  const method = await prisma.paymentMethodDefinition.update({ where: { id: methodId }, data: { isActive } });

  await prisma.auditLog.create({
    data: {
      userId: adminId,
      action: 'AGENT_CONFIG_PAYMENT_METHOD_UPDATED',
      entity: 'PaymentMethodDefinition',
      entityId: methodId,
      oldData: { isActive: before.isActive },
      newData: { isActive: method.isActive },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return method;
}

export async function listPaymentMethods(countryId: string, includeInactive: boolean) {
  const country = await prisma.country.findUnique({ where: { id: countryId } });
  if (!country) throw ApiError.notFound('Country not found');

  return prisma.paymentMethodDefinition.findMany({
    where: { countryId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  });
}

// ─── ExchangeRateConfig ─────────────────────────────────────────

export interface CreateExchangeRateArgs {
  countryId: string;
  fiatCurrency: string;
  coinsPerUnit: number;
  effectiveAt?: Date;
}

/**
 * Always creates a NEW row — never edits an existing one. This matches the
 * append-only, versioned design the schema itself documents: the order
 * service selects "isActive=true, effectiveAt <= now(), ORDER BY
 * effectiveAt DESC, take 1" and copies the result into the order forever.
 * Old rows remain as an immutable historical record, superseded only by a
 * newer effectiveAt, never overwritten.
 */
export async function createExchangeRate(
  adminId: string,
  args: CreateExchangeRateArgs,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  const country = await prisma.country.findUnique({ where: { id: args.countryId } });
  if (!country) throw ApiError.badRequest('Invalid countryId');
  if (!CURRENCY_CODE_RE.test(args.fiatCurrency)) {
    throw ApiError.badRequest('fiatCurrency must be a 3-letter ISO 4217 code (e.g. "NGN")');
  }
  if (typeof args.coinsPerUnit !== 'number' || !Number.isFinite(args.coinsPerUnit) || args.coinsPerUnit <= 0) {
    throw ApiError.badRequest('coinsPerUnit must be a positive number');
  }

  const rate = await prisma.exchangeRateConfig.create({
    data: {
      countryId: args.countryId,
      fiatCurrency: args.fiatCurrency,
      coinsPerUnit: args.coinsPerUnit,
      setBy: adminId,
      effectiveAt: args.effectiveAt ?? new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: adminId,
      action: 'AGENT_CONFIG_EXCHANGE_RATE_CREATED',
      entity: 'ExchangeRateConfig',
      entityId: rate.id,
      newData: { countryId: args.countryId, fiatCurrency: args.fiatCurrency, coinsPerUnit: args.coinsPerUnit },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return rate;
}

export async function deactivateExchangeRate(
  adminId: string,
  rateId: string,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  const before = await prisma.exchangeRateConfig.findUnique({ where: { id: rateId } });
  if (!before) throw ApiError.notFound('Exchange rate not found');
  if (!before.isActive) throw ApiError.conflict('This exchange rate is already inactive');

  const rate = await prisma.exchangeRateConfig.update({ where: { id: rateId }, data: { isActive: false } });

  await prisma.auditLog.create({
    data: {
      userId: adminId,
      action: 'AGENT_CONFIG_EXCHANGE_RATE_DEACTIVATED',
      entity: 'ExchangeRateConfig',
      entityId: rateId,
      oldData: { isActive: true },
      newData: { isActive: false },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return rate;
}

/** Read-only: the exact selection query documented on ExchangeRateConfig
 * (Phase C correction D), exposed so a caller can preview the rate an
 * order would actually use — never a second selection algorithm. */
export async function getActiveExchangeRate(countryId: string, fiatCurrency: string) {
  const country = await prisma.country.findUnique({ where: { id: countryId } });
  if (!country) throw ApiError.notFound('Country not found');

  return prisma.exchangeRateConfig.findFirst({
    where: { countryId, fiatCurrency, isActive: true, effectiveAt: { lte: new Date() } },
    orderBy: { effectiveAt: 'desc' },
  });
}

export async function listExchangeRates(countryId: string) {
  const country = await prisma.country.findUnique({ where: { id: countryId } });
  if (!country) throw ApiError.notFound('Country not found');

  return prisma.exchangeRateConfig.findMany({ where: { countryId }, orderBy: { effectiveAt: 'desc' } });
}
