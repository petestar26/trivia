import { PrismaClient } from '@prisma/client';
import {
  activationTarget,
  practiceReadiness,
  practiceDiagnostics,
  provisionPractice,
  type ActivationDb,
} from '../practice-activation/provision.js';

async function main() {
  const mode = process.argv[2];
  if (!['--check', '--apply', '--diagnose'].includes(mode ?? '') || process.argv.length !== 3)
    throw Error('PRACTICE_ARGUMENTS_REFUSED');
  activationTarget(process.env, mode === '--apply');
  const db = new PrismaClient({ log: [] });
  try {
    const result = await db.$transaction(
      async (tx) => {
        const adapter: ActivationDb = {
          query: (sql, values = []) => tx.$queryRawUnsafe(sql, ...values),
          execute: (sql) => tx.$executeRawUnsafe(sql),
        };
        return mode === '--apply'
          ? provisionPractice(adapter, process.env)
          : mode === '--diagnose'
            ? practiceDiagnostics(adapter)
            : practiceReadiness(adapter);
      },
      { timeout: 30_000 }
    );
    console.log(
      JSON.stringify({ event: mode === '--diagnose' ? 'SALEM_PRACTICE_DIAGNOSTIC' : 'SALEM_PRACTICE_READY', mode, ...result, coinsAccepted: false })
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((error) => {
  const reason =
    error instanceof Error && /^PRACTICE_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'PRACTICE_OPERATION_REFUSED';
  console.error(JSON.stringify({ event: 'SALEM_PRACTICE_REFUSED', reason }));
  process.exitCode = 1;
});
