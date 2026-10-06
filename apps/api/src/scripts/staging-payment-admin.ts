/** Explicit owner-run admin bootstrap for the disposable staging database only. */
import { PrismaClient, type Prisma } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUsdStagingTarget } from './staging-payment-target.js';

const EMAIL = 'playqube@admin.com';
const ACTION = 'STAGING_PAYMENT_ADMIN_BOOTSTRAP_20261005';
class Refused extends Error {}

export async function bootstrapPaymentAdmin(tx: Prisma.TransactionClient, apply: boolean) {
  const [owner] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba
      WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
  if (!owner?.allowed) throw new Refused('DATABASE_OWNER_REQUIRED');
  // Serializes retries and locks the account against concurrent status/role changes.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM public.users WHERE email=${EMAIL} FOR UPDATE`;
  if (rows.length !== 1) throw new Refused('REGISTER_ACCOUNT_FIRST');
  const user = await tx.user.findUnique({ where: { id: rows[0].id } });
  if (!user || user.email !== EMAIL || user.status !== 'ACTIVE' || !user.passwordHash)
    throw new Refused('ACTIVE_PASSWORD_ACCOUNT_REQUIRED');
  const prior = await tx.auditLog.findFirst({ where: { action: ACTION } });
  const elevated = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  // A later deliberate demotion or replacement account must never be undone by redeploy.
  if (prior && (prior.entityId !== user.id || !elevated)) throw new Refused('BOOTSTRAP_ALREADY_CONSUMED');
  if (!apply) return { status: elevated ? 'ADMIN_VERIFIED' : 'READY_TO_GRANT_ADMIN', email: EMAIL };
  if (elevated) return { status: 'ADMIN_VERIFIED', email: EMAIL };
  await tx.user.update({ where: { id: user.id }, data: { role: 'ADMIN', tokenVersion: { increment: 1 } } });
  await tx.session.deleteMany({ where: { userId: user.id } });
  await tx.auditLog.create({ data: {
    userId: null, action: ACTION, entity: 'User', entityId: user.id,
    oldData: { role: user.role },
    newData: { role: 'ADMIN', requestedEmail: EMAIL, authority: 'staging-database-owner', sessionsRevoked: true },
  } });
  return { status: 'ADMIN_GRANTED_SIGN_IN_AGAIN', email: EMAIL };
}

export async function runPaymentAdmin(apply: boolean) {
  assertUsdStagingTarget(process.env);
  const db = new PrismaClient({ log: [] });
  try {
    const result = await db.$transaction((tx) => bootstrapPaymentAdmin(tx, apply));
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--apply', '--verify'].includes(mode ?? '') || process.argv.length !== 3) {
    console.error('Use --apply or --verify'); process.exitCode = 1;
  } else runPaymentAdmin(mode === '--apply').catch((error) => {
    // Never emit driver messages, credentials, account details or password hashes.
    console.error(error instanceof Refused ? error.message : 'STAGING_ADMIN_SETUP_REFUSED_OR_FAILED');
    process.exitCode = 1;
  });
}
