import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `CREATE TYPE "GameType" AS ENUM ('DICE'); CREATE TABLE users(id text PRIMARY KEY);`
  );
  await pg.exec(
    await readFile(
      '../../packages/database/prisma/migrations/20261009010000_sky_crash_practice/migration.sql',
      'utf8'
    )
  );
  await pg.exec(
    `INSERT INTO users VALUES('one'); INSERT INTO sky_crash_accounts(user_id) VALUES('one');`
  );
});
afterAll(async () => {
  await pg.close();
});
it('executes real PostgreSQL balance and immutable-history guards', async () => {
  await expect(
    pg.exec(`UPDATE sky_crash_accounts SET balance=1001 WHERE user_id='one'`)
  ).rejects.toThrow('balance does not match');
  const seed = 'a'.repeat(64);
  await pg.query(
    `WITH t AS(SELECT clock_timestamp() AS n) INSERT INTO sky_crash_rounds(id,opens_at,starts_at,ends_at,crash_cents,seed,commitment) SELECT 'r',n,n+interval '15 seconds',n+interval '60 seconds',200,$1,$1 FROM t`,
    [seed]
  );
  await expect(pg.exec(`UPDATE sky_crash_rounds SET crash_cents=300 WHERE id='r'`)).rejects.toThrow(
    'immutable'
  );
  await expect(pg.exec(`DELETE FROM sky_crash_rounds WHERE id='r'`)).rejects.toThrow('immutable');
  await expect(
    pg.exec(
      `INSERT INTO sky_crash_tickets(id,round_id,user_id,stake,payout,paid_cents,settled_at) VALUES('bad','r','one',25,500,2000,clock_timestamp())`
    )
  ).rejects.toThrow('admission');
  await pg.transaction(async (tx) => {
    await tx.exec(
      `INSERT INTO sky_crash_tickets(id,round_id,user_id,stake,auto_cents) VALUES('t','r','one',25,200); UPDATE sky_crash_accounts SET balance=975 WHERE user_id='one';`
    );
  });
  await expect(pg.exec(`UPDATE sky_crash_tickets SET stake=100 WHERE id='t'`)).rejects.toThrow(
    'immutable'
  );
  expect(
    (await pg.query<{ balance: number }>('SELECT balance FROM sky_crash_accounts')).rows[0].balance
  ).toBe(975);
});
