import type { PrismaClient } from '@socialplay/database';
/** Explicit staging/operator step, never invoked by normal API requests. */
export async function grantDerbyRuntimeTables(db: PrismaClient, role: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(role)) throw Error('Invalid runtime role');
  await db.$executeRawUnsafe(
    `GRANT SELECT,INSERT,UPDATE ON public.derby_accounts,public.derby_tickets TO "${role}"`
  );
  await db.$executeRawUnsafe(`GRANT SELECT,INSERT ON public.derby_rounds TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT UPDATE(id) ON public.derby_rounds TO "${role}"`);
}
