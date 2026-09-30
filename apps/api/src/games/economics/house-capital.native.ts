import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/playqube_scheduled_throwaway' ||
    process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') {
  throw new Error('Capital tests require the acknowledged isolated throwaway database');
}
const owner = new PrismaClient();
afterAll(async () => { await owner.$disconnect(); });

const vector = [1332, ...Array(36).fill(0)];
const digest = 'a'.repeat(64);
const ref = () => `bank:${randomUUID()}`;
const rid = () => `round:${randomUUID()}`;
async function state() {
  const [account] = await owner.$queryRaw<Array<{ funded_amount: bigint; reserved_amount: bigint }>>`
    SELECT funded_amount,reserved_amount FROM public.house_capital_accounts WHERE currency='COINS'`;
  const failures = await owner.$queryRaw<Array<{ id: string }>>`SELECT id FROM public.house_capital_failures()`;
  return { account, failures };
}

describe('native operator-capital serial admission', () => {
  it('reserves a single worst-case round when two independent connections race', async () => {
    const before = await state();
    expect(before.failures).toEqual([]);
    expect(before.account.funded_amount - before.account.reserved_amount).toBe(0n);
    await owner.$queryRaw`SELECT public.house_record_capital_funding(${ref()},${1292n},${digest})`;
    const ids = [rid(), rid()];
    const clients = [new PrismaClient(), new PrismaClient()];
    try {
      const outcomes = await Promise.allSettled(clients.map((client, index) =>
        client.$queryRaw`SELECT public.house_reserve_round_loss(${ids[index]},${40n},${JSON.stringify(vector)}::jsonb,${1}::integer)`
      ));
      const diagnostics = outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'fulfilled' : String(outcome.reason));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled'), diagnostics.join(' | ')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect(String((outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason))
        .toContain('capacity exhausted');
      const after = await state();
      expect(after.account).toEqual({
        funded_amount: before.account.funded_amount + 1292n,
        reserved_amount: before.account.reserved_amount + 1292n,
      });
      expect(after.failures).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('rejects unjournaled cache increases at commit and enforces owner-only writes', async () => {
    await expect(owner.$executeRaw`
      UPDATE public.house_capital_accounts SET funded_amount=funded_amount+1 WHERE currency='COINS'`
    ).rejects.toThrow('proof mismatch');
    const role = `capital_probe_${randomUUID().replaceAll('-', '')}`;
    await owner.$executeRawUnsafe(`CREATE ROLE "${role}"`);
    try {
      await owner.$executeRawUnsafe(`GRANT UPDATE (funded_amount) ON public.house_capital_accounts TO "${role}"`);
      await owner.$executeRawUnsafe('SELECT public.ledger_apply_runtime_grants($1)', role);
      for (const table of ['house_capital_accounts', 'house_capital_fundings', 'house_round_reservations']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
          const [grant] = await owner.$queryRawUnsafe<Array<{ allowed: boolean }>>(
            'SELECT has_table_privilege($1,$2,$3) AS allowed', role, `public.${table}`, privilege,
          );
          expect(grant.allowed).toBe(false);
        }
      }
      const [column] = await owner.$queryRawUnsafe<Array<{ allowed: boolean }>>(
        'SELECT has_column_privilege($1,$2,$3,$4) AS allowed',
        role, 'public.house_capital_accounts', 'funded_amount', 'UPDATE',
      );
      expect(column.allowed).toBe(false);
      await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON
        public.house_capital_accounts,public.house_capital_fundings,public.house_round_reservations TO "${role}"`);
      const [check] = await owner.$queryRawUnsafe<Array<{ can_execute: boolean }>>(
        `SELECT has_function_privilege($1,'public.house_record_capital_funding(text,bigint,text)','EXECUTE') AS can_execute`, role
      );
      expect(check.can_execute).toBe(false);
      await expect(owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        await tx.$executeRaw`
          UPDATE public.house_capital_accounts SET funded_amount=funded_amount+1 WHERE currency='COINS'`;
      })).rejects.toThrow('owner-only');
      expect((await state()).failures).toEqual([]);
    } finally {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  });
});
