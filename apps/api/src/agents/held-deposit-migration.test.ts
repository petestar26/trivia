import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// Disposable PostgreSQL in memory; no external services or credentials.
// Proves the recovery migration applies on top of its predecessor without
// loosening the existing guards, and that the documented rollback restores the
// original guard functions exactly and refuses to discard recovery records.
const db = new PGlite();
const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const forward = read('packages/database/prisma/migrations/20261117000000_held_deposit_recovery/migration.sql');
const rollback = read('docs/operations/held-deposit-recovery-rollback.sql');
const GUARDS = `SELECT proname, prosrc, proconfig::text AS config FROM pg_proc
  WHERE proname IN ('deposit_order_destination','deposit_financial_safety') ORDER BY proname`;
const recoveryObjects = async () => (await db.query<{ n: number }>(`SELECT
  (SELECT count(*) FROM pg_class WHERE relname LIKE 'held_deposit_%')
  + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'held_deposit_%')
  + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'held_deposit_%') AS n`)).rows[0].n;
/** A failed script leaves its transaction open; close it like psql ON_ERROR_STOP would. */
async function refused(sql: string, message: RegExp) {
  await expect(db.exec(sql)).rejects.toThrow(message);
  await db.exec('ROLLBACK');
}
let original: unknown[];

beforeAll(async () => {
  await db.exec(`CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE agent_payment_accounts (
    id text PRIMARY KEY, "agentId" text, "countryId" text, "methodDefId" text,
    "accountDetails" jsonb, status text, "reviewedBy" text, "reviewedAt" timestamp(3),
    "updatedAt" timestamp(3) NOT NULL DEFAULT now());
    CREATE TABLE agent_reservations (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE agent_order_settlements (id text PRIMARY KEY, "orderId" text);
    CREATE TABLE disputes (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE late_payment_cases (id text PRIMARY KEY, "orderId" text, status text);
    CREATE TABLE late_payment_reference_claims ("methodId" text, reference text, "caseId" text, kind text);
    CREATE TABLE agent_orders (id text PRIMARY KEY,"agentId" text,"countryId" text,
      "paymentMethodDefId" text,"paymentAccountId" text,"paymentSnapshot" jsonb,status text);
    INSERT INTO users VALUES ('admin');
    INSERT INTO agent_payment_accounts VALUES ('acct','agent','country','method','{"n":"original"}',
      'APPROVED','reviewer',now(),now());`);
  await db.exec(read('packages/database/prisma/migrations/20261113060000_deposit_destination_revisions/migration.sql'));
  await db.exec(`INSERT INTO agent_orders VALUES ('held','agent','country','method','acct','{"n":"original"}','PAYMENT_SUBMITTED',NULL,false);
    INSERT INTO agent_reservations VALUES ('res','held','ACTIVE');
    UPDATE agent_payment_accounts SET status='DISABLED' WHERE id='acct';`);
  original = (await db.query(GUARDS)).rows;
  expect(await recoveryObjects()).toBe(0);
  await db.exec(forward);
});
afterAll(() => db.close());

async function expectHeldOrderStillFrozen() {
  expect((await db.query(`SELECT status,"safetyHold" FROM agent_orders WHERE id='held'`)).rows)
    .toEqual([{ status: 'PAYMENT_SUBMITTED', safetyHold: true }]);
  for (const status of ['CANCELLED', 'EXPIRED', 'COMPLETED'])
    await expect(db.query(`UPDATE agent_orders SET status=$1 WHERE id='held'`, [status])).rejects.toThrow(/safety hold/);
  await expect(db.exec(`UPDATE agent_orders SET "safetyHold"=false WHERE id='held'`)).rejects.toThrow(/separately approved policy/);
  await expect(db.exec(`UPDATE agent_orders SET "paymentSnapshot"='{}' WHERE id='held'`)).rejects.toThrow(/immutable/);
  for (const status of ['RELEASED', 'CONSUMED'])
    await expect(db.query(`UPDATE agent_reservations SET status=$1 WHERE id='res'`, [status])).rejects.toThrow(/safety hold/);
  await expect(db.exec(`INSERT INTO agent_order_settlements VALUES ('s','held')`)).rejects.toThrow(/safety hold/);
}

it('applies on top of the destination-revision release with every outcome disabled and no hold loosened', async () => {
  expect((await db.query('SELECT * FROM held_deposit_recovery_policy')).rows).toMatchObject([{
    unpaidReleaseEnabled: false, coinCreditEnabled: false, externalReturnEnabled: false, admissionExceptionMax: 0,
    approvedBy: null, approvalReference: null }]);
  for (const table of ['held_deposit_cases', 'held_deposit_case_events', 'held_deposit_adjudications', 'held_deposit_reference_claims'])
    expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  // Migrating touches no order, account or reservation.
  await expectHeldOrderStillFrozen();
  // Enabling anything needs a recorded approval, and the exception is capped.
  await expect(db.exec('UPDATE held_deposit_recovery_policy SET "coinCreditEnabled"=true')).rejects.toThrow();
  await expect(db.exec(`UPDATE held_deposit_recovery_policy SET "admissionExceptionMax"=4,"approvedBy"='a',"approvalReference"='b'`)).rejects.toThrow();
  // No application role receives anything from the migration itself.
  expect(forward).not.toMatch(/\bGRANT\b/i);
  expect(forward).not.toMatch(/"safetyHold"\s*=\s*false|SET\s+"safetyHold"/i);
});

it('refuses rollback while a policy is enabled or investigation cases would be discarded', async () => {
  await db.exec(`UPDATE held_deposit_recovery_policy SET "externalReturnEnabled"=true,"approvedBy"='synthetic',"approvalReference"='TEST-ONLY'`);
  await refused(rollback, /disable the recovery policy first/);
  await db.exec(`UPDATE held_deposit_recovery_policy SET "externalReturnEnabled"=false,"approvedBy"=NULL,"approvalReference"=NULL`);
  await db.exec(`INSERT INTO held_deposit_cases ("orderId") VALUES ('held')`);
  await refused(rollback, /export the investigation cases/);
  expect(await recoveryObjects()).toBeGreaterThan(0);
  expect((await db.query(`SELECT count(*)::int AS n FROM held_deposit_cases`)).rows).toEqual([{ n: 1 }]);
});

it('rolls back to the exact original guards, keeps every hold, and can be applied again', async () => {
  await db.exec(`SET held_recovery.discard_cases = 'exported-and-acknowledged'`);
  await db.exec(rollback);
  await db.exec('RESET held_recovery.discard_cases');
  expect(await recoveryObjects()).toBe(0);
  expect((await db.query(GUARDS)).rows).toEqual(original);
  await expectHeldOrderStillFrozen();
  await db.exec(forward);
  expect(await recoveryObjects()).toBeGreaterThan(0);
  await expectHeldOrderStillFrozen();
});
