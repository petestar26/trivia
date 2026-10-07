import { pathToFileURL } from 'node:url';
import { prisma } from '@socialplay/database';
import { TronGrid } from '../crypto-payments/tron.js';
import { verifyOnce } from '../crypto-payments/verifier.js';

export async function main() {
  if (process.env.CRYPTO_VERIFIER_ENABLED !== 'true')
    throw new Error('Crypto verifier is disabled');
  // Deployment must supply the separate verifier DATABASE_URL; API identity may
  // read evidence but must never manufacture it. No signing keys are accepted.
  const [role] = await prisma.$queryRaw<
    Array<{ canInsert: boolean; canMutate: boolean; privileged: boolean }>
  >`
    SELECT has_table_privilege(current_user,'public.crypto_receipts','INSERT') AS "canInsert",
      has_table_privilege(current_user,'public.crypto_receipts','UPDATE,DELETE,TRUNCATE,TRIGGER') AS "canMutate",
      (SELECT rolsuper OR rolbypassrls OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged`;
  if (!role?.canInsert || role.canMutate || role.privileged)
    throw new Error('Restricted crypto verifier database identity required');
  const provider = new TronGrid(process.env.TRONGRID_API_KEY ?? '');
  let stopping = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });
  do {
    const result = await verifyOnce(provider);
    console.log(JSON.stringify({ event: 'crypto_scan', ...result }));
    if (process.argv.includes('--once') || stopping) break;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } while (!stopping);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .catch(() => {
      console.error('Crypto verifier stopped; check configuration and database access');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
