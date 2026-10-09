import type { PrismaClient } from '@prisma/client';

/** Round UPDATE(id) permits PostgreSQL row locks; the immutable trigger rejects edits. */
export async function grantSkyCrashRuntimeTables(db: PrismaClient, role: string) {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(role)) throw Error('RUNTIME_ROLE_REFUSED');
  await db.$executeRawUnsafe(
    `GRANT SELECT,INSERT,UPDATE ON public.sky_crash_accounts,public.sky_crash_tickets TO "${role}"`
  );
  await db.$executeRawUnsafe(`GRANT SELECT,INSERT ON public.sky_crash_rounds TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT UPDATE(id) ON public.sky_crash_rounds TO "${role}"`);
}
