import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  new URL('../../../../../packages/database/prisma/migrations/20260930160000_house_capital_reservations/migration.sql', import.meta.url),
  'utf8',
);
const digest = 'a'.repeat(64);
const numberVector = [1332, ...Array(36).fill(0)];
let db: PGlite;

async function state() {
  const account = (await db.query<{ funded_amount: bigint; reserved_amount: bigint }>(
    'SELECT funded_amount,reserved_amount FROM public.house_capital_accounts WHERE currency=\'COINS\'',
  )).rows[0];
  return {
    funded: BigInt(account.funded_amount),
    reserved: BigInt(account.reserved_amount),
    fundingCount: (await db.query('SELECT 1 FROM public.house_capital_fundings')).rows.length,
    reservationCount: (await db.query('SELECT 1 FROM public.house_round_reservations')).rows.length,
    failures: (await db.query('SELECT id FROM public.house_capital_failures()')).rows,
  };
}
async function fund(ref: string, amount: bigint) {
  return db.query<{ accepted: string | number | bigint }>(
    'SELECT public.house_record_capital_funding($1,$2,$3) AS accepted', [ref, amount.toString(), digest]);
}
async function reserve(id: string, stake = 40n, vector = numberVector, draws = 1) {
  return db.query<{ loss: string | number | bigint }>('SELECT public.house_reserve_round_loss($1,$2,$3::jsonb,$4) AS loss',
    [id, stake.toString(), JSON.stringify(vector), draws]);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(migration);
});
afterEach(async () => { await db.close(); });

describe('dormant owner capital journal', () => {
  it('starts with zero backing and rejects an unfunded loss reserve', async () => {
    expect(await state()).toEqual({ funded: 0n, reserved: 0n, fundingCount: 0, reservationCount: 0, failures: [] });
    await expect(reserve('round-1')).rejects.toThrow('capacity exhausted');
    expect((await state()).reservationCount).toBe(0);
  });

  it('records external evidence once, locks full Spin exposure and returns the same entry on replay', async () => {
    expect(BigInt((await fund('bank:receipt-1', 1292n)).rows[0].accepted as string)).toBe(1292n);
    expect(BigInt((await reserve('round-1')).rows[0].loss as string)).toBe(1292n);
    expect(await state()).toEqual({ funded: 1292n, reserved: 1292n, fundingCount: 1, reservationCount: 1, failures: [] });
    await fund('bank:receipt-2', 200n);
    expect(BigInt((await fund('bank:receipt-1', 1292n)).rows[0].accepted as string)).toBe(1292n);
    expect(BigInt((await reserve('round-1')).rows[0].loss as string)).toBe(1292n);
    const before = await state();
    await expect(fund('bank:receipt-1', 1293n)).rejects.toThrow('different terms');
    await expect(reserve('round-1', 80n)).rejects.toThrow('different terms');
    expect(await state()).toEqual(before);
  });

  it('cannot accept two different rounds against the same capital', async () => {
    await fund('bank:receipt-1', 1292n);
    await reserve('round-1');
    await expect(reserve('round-2')).rejects.toThrow('capacity exhausted');
    expect(await state()).toEqual({ funded: 1292n, reserved: 1292n, fundingCount: 1, reservationCount: 1, failures: [] });
  });

  it('sums the twenty largest liabilities for an 80-pocket Keno draw', async () => {
    await fund('bank:receipt-1', 260n);
    const vector = [...Array(20).fill(18), ...Array(60).fill(0)];
    expect(BigInt((await reserve('keno-1', 100n, vector, 20)).rows[0].loss as string)).toBe(260n);
    const row = (await db.query<{ max_gross_payout: bigint }>(
      'SELECT max_gross_payout FROM public.house_round_reservations WHERE round_id=\'keno-1\'',
    )).rows[0];
    expect(BigInt(row.max_gross_payout)).toBe(360n);
    expect((await state()).failures).toEqual([]);
  });

  it('rejects fractional, negative, oversized and contradictory vectors before reservation', async () => {
    await fund('bank:receipt-1', 10_000n);
    const before = await state();
    for (const vector of [[0.5, 5], [-1, 5], ['5', 0], [Number.MAX_SAFE_INTEGER * 10, 0], [1]]) {
      await expect(reserve('invalid', 40n, vector as number[], 1)).rejects.toThrow();
    }
    expect(await state()).toEqual(before);
  });

  it('rolls back the journal and cache together on a later failure', async () => {
    await db.exec('BEGIN');
    try {
      await fund('bank:rollback-1', 1292n);
      await reserve('round-rollback');
      await db.exec('SELECT 1/0');
      await db.exec('COMMIT');
      throw new Error('expected division failure');
    } catch (error) {
      expect(String(error)).toContain('division by zero');
      await db.exec('ROLLBACK');
    }
    expect(await state()).toEqual({ funded: 0n, reserved: 0n, fundingCount: 0, reservationCount: 0, failures: [] });
  });

  it('rejects direct cache forgery, reservation forgery and deletion at commit', async () => {
    await expect(db.exec("UPDATE public.house_capital_accounts SET funded_amount=10 WHERE currency='COINS'"))
      .rejects.toThrow('proof mismatch');
    await expect(db.exec("INSERT INTO public.house_capital_fundings(external_reference,amount,evidence_sha256) VALUES ('bank:forged-1',100,'" + digest + "')"))
      .rejects.toThrow('proof mismatch');
    await fund('bank:receipt-1', 1292n);
    await reserve('round-1');
    await expect(db.query(
      `INSERT INTO public.house_round_reservations
        (round_id,stake_total,payout_vector,draw_count,max_gross_payout,reserved_loss)
       VALUES ($1,100,$2::jsonb,20,18,0)`,
      ['keno-forged', JSON.stringify([...Array(20).fill(18), ...Array(60).fill(0)])],
    )).rejects.toThrow('proof mismatch');
    await expect(db.exec("UPDATE public.house_capital_fundings SET amount=100 WHERE external_reference='bank:receipt-1'"))
      .rejects.toThrow('append-only');
    await expect(db.exec('TRUNCATE public.house_round_reservations')).rejects.toThrow('append-only');
    await expect(db.exec("DELETE FROM public.house_capital_accounts WHERE currency='COINS'"))
      .rejects.toThrow('append-only');
    expect((await state()).failures).toEqual([]);
  });
});
