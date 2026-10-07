import { prisma } from '@socialplay/database';
import { TronGrid, type Transfer } from './tron.js';
import { settleDeposit, type Deposit } from './service.js';

export async function scanTransfers(
  provider: Pick<TronGrid, 'discover' | 'transfers'>,
  deposit: Pick<Deposit, 'address' | 'createdAt'>,
  until = new Date()
): Promise<Transfer[]> {
  const result: Transfer[] = [];
  const seen = new Set<string>();
  let fingerprint: string | undefined;
  // Keep the query window identical across pages. An incomplete scan never credits.
  for (let page = 0; page < 20; page++) {
    const data = await provider.discover(deposit.address, deposit.createdAt, until, fingerprint);
    for (const hash of data.hashes)
      if (!seen.has(hash)) {
        seen.add(hash);
        result.push(...(await provider.transfers(hash, deposit.address)));
      }
    if (!data.next) return result;
    if (data.next === fingerprint) throw new Error('Provider pagination did not advance');
    fingerprint = data.next;
  }
  throw new Error('Deposit history exceeds automatic verification limit; operator review required');
}
export async function verifyOnce(provider: TronGrid) {
  // Do not call the provider while activation remains blocked.
  const gate = await prisma.platformGate.findUnique({ where: { key: 'CRYPTO_DEPOSIT_CREDIT' } });
  if (!gate?.enabled) return { checked: 0, paused: true };
  // Old expired addresses remain monitored and permanently reserved. Rotate fairly
  // rather than repeatedly scanning only the newest invoices after an outage.
  const deposits = await prisma.$queryRaw<
    Deposit[]
  >`SELECT * FROM crypto_deposits WHERE status IN ('WAITING','EXPIRED') AND ("lastCheckedAt" IS NULL OR "lastCheckedAt"<now()-interval '30 seconds') ORDER BY "lastCheckedAt" NULLS FIRST,id LIMIT 20`;
  for (const d of deposits) {
    try {
      await settleDeposit(d.id, await scanTransfers(provider, d));
    } catch {
      // Do not persist provider payloads or secrets in member-visible errors.
      await prisma.$executeRaw`UPDATE crypto_deposits SET "lastCheckedAt"=now(),"checkError"='Verification delayed; no credit issued' WHERE id=${d.id} AND status IN ('WAITING','EXPIRED')`;
    }
  }
  return { checked: deposits.length, paused: false };
}
