import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// Disposable PostgreSQL in memory; no external services or credentials.
const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE agent_payment_accounts (
    id text PRIMARY KEY, "agentId" text, "countryId" text, "methodDefId" text,
    "accountDetails" jsonb, status text, "reviewedBy" text, "reviewedAt" timestamp(3),
    "updatedAt" timestamp(3) NOT NULL DEFAULT now());
    CREATE TABLE agent_reservations (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE agent_order_settlements (id text PRIMARY KEY, "orderId" text);
    CREATE TABLE disputes (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE late_payment_cases (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE agent_orders (id text PRIMARY KEY,"agentId" text,"countryId" text,
      "paymentMethodDefId" text,"paymentAccountId" text,"paymentSnapshot" jsonb,status text);
    INSERT INTO agent_payment_accounts VALUES ('legacy','agent','country','method','{"n":"original"}',
      'APPROVED','reviewer',now(),now());
    INSERT INTO agent_orders VALUES ('orphan','agent','country','method','absent','{}','CREATED');
    INSERT INTO agent_orders VALUES ('historical','agent','country','method','legacy','{"n":"older"}','COMPLETED');`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261113060000_deposit_destination_revisions/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
});
afterAll(() => db.close());
async function account(id: string) {
  await db.query(
    `INSERT INTO agent_payment_accounts
    (id,"agentId","countryId","methodDefId","accountDetails",status)
    VALUES ($1,'agent','country','method','{"n":"original"}','APPROVED')`,
    [id]
  );
}
async function order(id: string, accountId: string, status = 'CREATED') {
  await db.query(
    `INSERT INTO agent_orders VALUES ($1,'agent','country','method',$2,'{"n":"original"}',$3,NULL,false)`,
    [id, accountId, status]
  );
}
it('backfills known approval without fabricating historical order provenance', async () => {
  expect((await db.query('SELECT "approvedRevision" FROM agent_payment_accounts')).rows).toEqual([
    { approvedRevision: 1 },
  ]);
  expect(
    (
      await db.query(
        `SELECT "paymentSnapshot","paymentAccountRevision" FROM agent_orders WHERE id='historical'`
      )
    ).rows
  ).toEqual([{ paymentSnapshot: { n: 'older' }, paymentAccountRevision: null }]);
});
it('pins open and paid destinations while edits pause new admission until approval', async () => {
  await account('edit');
  await order('open', 'edit');
  await order('paid', 'edit', 'PAYMENT_SUBMITTED');
  await db.exec(
    `UPDATE agent_payment_accounts SET "accountDetails"='{"n":"replacement"}' WHERE id='edit'`
  );
  expect(
    (await db.query(`SELECT status,"approvedRevision" FROM agent_payment_accounts WHERE id='edit'`))
      .rows
  ).toEqual([{ status: 'PENDING_APPROVAL', approvedRevision: 1 }]);
  await expect(order('blocked', 'edit')).rejects.toThrow(/not approved/);
  await db.exec(
    `UPDATE agent_payment_accounts SET status='APPROVED',"reviewedBy"='reviewer' WHERE id='edit'`
  );
  expect(
    (
      await db.query(
        `SELECT revision,"accountDetails" FROM agent_payment_account_revisions WHERE "accountId"='edit' ORDER BY revision`
      )
    ).rows
  ).toEqual([
    { revision: 1, accountDetails: { n: 'original' } },
    { revision: 2, accountDetails: { n: 'replacement' } },
  ]);
  expect(
    (
      await db.query(
        `SELECT "paymentAccountRevision","paymentSnapshot" FROM agent_orders WHERE "paymentAccountId"='edit'`
      )
    ).rows
  ).toEqual([
    { paymentAccountRevision: 1, paymentSnapshot: { n: 'original' } },
    { paymentAccountRevision: 1, paymentSnapshot: { n: 'original' } },
  ]);
});
it('enforces immutable revisions and order destinations at the database boundary', async () => {
  await expect(
    db.exec(`UPDATE agent_orders SET "paymentSnapshot"='{}' WHERE id='open'`)
  ).rejects.toThrow(/immutable/);
  await expect(
    db.exec(`UPDATE agent_payment_account_revisions SET "accountDetails"='{}'`)
  ).rejects.toThrow(/immutable/);
  await expect(db.exec('DELETE FROM agent_payment_account_revisions')).rejects.toThrow(/immutable/);
  await expect(db.exec('TRUNCATE agent_payment_account_revisions')).rejects.toThrow(/immutable/);
});
it('holds unsafe open orders independently of dispute status and blocks automatic resolution', async () => {
  await account('unsafe');
  await order('held-open', 'unsafe');
  await order('held-dispute', 'unsafe', 'DISPUTE');
  await db.exec(`UPDATE agent_payment_accounts SET status='DISABLED' WHERE id='unsafe'`);
  expect(
    (
      await db.query(
        `SELECT status,"safetyHold" FROM agent_orders WHERE "paymentAccountId"='unsafe' ORDER BY id`
      )
    ).rows
  ).toEqual([
    { status: 'DISPUTE', safetyHold: true },
    { status: 'CREATED', safetyHold: true },
  ]);
  for (const status of ['CANCELLED', 'EXPIRED', 'COMPLETED', 'PAYMENT_SUBMITTED']) {
    await expect(
      db.query('UPDATE agent_orders SET status=$1 WHERE id=$2', [status, 'held-open'])
    ).rejects.toThrow(/safety hold/);
  }
  await db.exec(`UPDATE agent_orders SET status='DISPUTE' WHERE id='held-open'`);
  await expect(
    db.exec(`UPDATE agent_orders SET "safetyHold"=false WHERE id='held-open'`)
  ).rejects.toThrow(/separately approved policy/);
  await expect(
    db.exec(`UPDATE agent_payment_accounts SET "safetyHold"=false WHERE id='unsafe'`)
  ).rejects.toThrow(/separately approved policy/);
});
it('advances timestamp(3) on same-millisecond writes and makes stale edits/reviews lose', async () => {
  await account('version');
  const version = (
    await db.query<{ value: string }>(
      `SELECT "updatedAt"::text AS value FROM agent_payment_accounts WHERE id='version'`
    )
  ).rows[0].value;
  const claim = () =>
    db.query(
      `UPDATE agent_payment_accounts SET status='PENDING_APPROVAL',"updatedAt"=$1::timestamp
    WHERE id='version' AND "updatedAt"=$1::timestamp RETURNING id`,
      [version]
    );
  expect((await claim()).rows).toHaveLength(1);
  expect((await claim()).rows).toHaveLength(0);
  expect(
    (
      await db.query(
        `UPDATE agent_payment_accounts SET status='APPROVED' WHERE id='version' AND "updatedAt"=$1::timestamp RETURNING id`,
        [version]
      )
    ).rows
  ).toHaveLength(0);
  expect(
    (
      await db.query(
        `SELECT revision FROM agent_payment_account_revisions WHERE "accountId"='version'`
      )
    ).rows
  ).toEqual([{ revision: 1 }]);
});
it('rolls back preceding side effects when a held resolution is rejected', async () => {
  await db.exec('CREATE TABLE synthetic_effects (id text)');
  await expect(
    db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO synthetic_effects VALUES ('would-credit')`);
      await tx.exec(`UPDATE agent_orders SET status='COMPLETED' WHERE id='held-dispute'`);
    })
  ).rejects.toThrow(/safety hold/);
  expect((await db.query('SELECT * FROM synthetic_effects')).rows).toEqual([]);
});
it('rejects missing accounts and mismatched new destinations', async () => {
  await expect(order('missing', 'missing')).rejects.toThrow(/missing/);
  await expect(order('wrong', 'edit')).rejects.toThrow(/not approved/);
});

it('rejects fabricated inserts and delete/recreate version-token reuse', async () => {
  await expect(
    db.exec(`INSERT INTO agent_payment_account_revisions
    ("accountId",revision,"agentId","countryId","methodDefId","accountDetails")
    VALUES ('edit',99,'agent','country','method','{"n":"replacement"}')`)
  ).rejects.toThrow(/current approved destination/);
  await expect(db.exec(`DELETE FROM agent_payment_accounts WHERE id='version'`)).rejects.toThrow(
    /immutable/
  );
  await expect(db.exec('TRUNCATE agent_payment_accounts')).rejects.toThrow(/immutable/);
  for (const status of ['PAYMENT_SUBMITTED', 'DISPUTE', 'COMPLETED']) {
    await expect(order(`missing-${status}`, 'absent', status)).rejects.toThrow(/missing/);
  }
});

it('preserves a disable safety signal even when destination fields change in the same write', async () => {
  await account('combined');
  await order('combined-order', 'combined');
  await db.exec(
    `UPDATE agent_payment_accounts SET status='DISABLED',"accountDetails"='{"n":"changed"}' WHERE id='combined'`
  );
  expect(
    (await db.query(`SELECT "safetyHold" FROM agent_orders WHERE id='combined-order'`)).rows
  ).toEqual([{ safetyHold: true }]);
});

it('blocks financial side-table operations without requiring an order status update', async () => {
  await db.exec(`INSERT INTO agent_reservations VALUES ('held-reservation','held-open','ACTIVE');
    INSERT INTO disputes VALUES ('held-appeal','held-open','ASSIGNED');`);
  await expect(
    db.exec(`UPDATE agent_reservations SET status='RELEASED' WHERE id='held-reservation'`)
  ).rejects.toThrow(/safety hold/);
  await expect(
    db.exec(`INSERT INTO agent_order_settlements VALUES ('held-settlement','held-open')`)
  ).rejects.toThrow(/safety hold/);
  await expect(
    db.exec(`UPDATE disputes SET status='RESOLVED' WHERE id='held-appeal'`)
  ).rejects.toThrow(/safety hold/);
});

it('blocks recovery resolution for terminal orders on an unsafe account without changing historical status', async () => {
  await account('recovery');
  await order('recovery-order', 'recovery', 'EXPIRED');
  await db.exec(`INSERT INTO late_payment_cases VALUES ('recovery-case','recovery-order','ASSIGNED');
    UPDATE agent_payment_accounts SET status='DISABLED' WHERE id='recovery';`);
  for (const status of ['REFUNDED', 'REJECTED']) {
    await expect(
      db.query(`UPDATE late_payment_cases SET status=$1 WHERE id='recovery-case'`, [status])
    ).rejects.toThrow(/safety hold/);
  }
  expect(
    (await db.query(`SELECT status FROM agent_orders WHERE id='recovery-order'`)).rows
  ).toEqual([{ status: 'EXPIRED' }]);
  expect(
    (await db.query(`SELECT status FROM late_payment_cases WHERE id='recovery-case'`)).rows
  ).toEqual([{ status: 'ASSIGNED' }]);
});

it('holds pre-existing open orders whose receiving account cannot be verified', async () => {
  expect((await db.query(`SELECT "safetyHold" FROM agent_orders WHERE id='orphan'`)).rows).toEqual([
    { safetyHold: true },
  ]);
  await expect(
    db.exec(`UPDATE agent_orders SET status='EXPIRED' WHERE id='orphan'`)
  ).rejects.toThrow(/safety hold/);
});

it('pins deposit guards to their respective I3 cascade and ordinary-invoker paths', async () => {
  const result = await db.query<{ proname: string; proconfig: string[]; prosecdef: boolean }>(`
    SELECT p.proname, p.proconfig, p.prosecdef FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'deposit_%'`);
  expect(result.rows).toHaveLength(8);
  for (const row of result.rows) {
    const ordinaryInvoker = ['deposit_revision_insert', 'deposit_recovery_safety'].includes(row.proname);
    expect(row.proconfig, row.proname).toContain(
      ordinaryInvoker ? 'search_path=public, pg_temp' : 'search_path=pg_catalog, pg_temp'
    );
    expect(row.prosecdef, row.proname).toBe(false);
  }
});
