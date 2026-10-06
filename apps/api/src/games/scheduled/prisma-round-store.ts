import type { PrismaClient } from '@prisma/client';
import type { RoundDatabase, RoundTransaction } from './round-store.js';

export function prismaRoundDatabase(client: PrismaClient): RoundDatabase {
  const wrap = (tx: Pick<PrismaClient, '$queryRawUnsafe'>): RoundTransaction => ({
    query: <T extends object>(sql: string, values: unknown[] = []) => tx.$queryRawUnsafe<T[]>(sql, ...values),
  });
  return {
    ...wrap(client),
    transaction: (run) => client.$transaction((tx) => run(wrap(tx)), {
      isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 5_000,
    }),
  };
}
