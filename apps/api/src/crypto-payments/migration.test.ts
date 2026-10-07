import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, it, expect } from 'vitest';
// Focused real PostgreSQL trigger tests. Native CI separately applies the full history.
const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id text PRIMARY KEY); CREATE TABLE countries(id text PRIMARY KEY); CREATE TABLE withdrawals(id text PRIMARY KEY);
 CREATE TABLE platform_gates(key text PRIMARY KEY,enabled boolean,"changedAt" timestamp);
 CREATE TABLE wallet_transactions(id text PRIMARY KEY,"userId" text,currency text,type text,"ledgerType" text,status text,"referenceType" text,"referenceId" text,amount int,"balanceBefore" int,"balanceAfter" int);
 CREATE TABLE economic_operations(id text PRIMARY KEY,type text,"userId" text,"scopeType" text,"scopeId" text,"walletTransactionIds" text[],"reversesOperationId" text);
 CREATE TABLE coin_provenance(id text PRIMARY KEY,"userId" text,"lotClass" text,"sourceOperationId" text,"walletTransactionId" text);
 CREATE TABLE coin_lot_entries(id text PRIMARY KEY,"operationId" text,"userId" text,"entryType" text,"lotId" text,"availableDelta" int,"reservedDelta" int);
 CREATE FUNCTION financial_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append only'; END $$;
 CREATE FUNCTION ledger_apply_runtime_grants(text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
 INSERT INTO users VALUES ('member'),('admin');INSERT INTO countries VALUES ('country');`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261008010000_usdt_tron_payments/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  await db.exec(`INSERT INTO crypto_addresses(address,label,"addedBy") VALUES ('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7','fixture','admin');
 INSERT INTO crypto_deposits(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","expiresAt") VALUES ('deposit','member','country','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,960,'{}','key',now()+interval '15 minutes');`);
});
afterAll(() => db.close());
it('installs all three crypto gates disabled', async () => {
  expect(
    (
      await db.query(
        `SELECT key,enabled FROM platform_gates WHERE key LIKE 'CRYPTO_%' ORDER BY key`
      )
    ).rows
  ).toEqual([
    { key: 'CRYPTO_DEPOSIT_CREATE', enabled: false },
    { key: 'CRYPTO_DEPOSIT_CREDIT', enabled: false },
    { key: 'CRYPTO_WITHDRAWAL_CREATE', enabled: false },
  ]);
});
it('prevents term edits, address reassignment, deletion, and invented credits', async () => {
  for (const sql of [
    `UPDATE crypto_deposits SET "amountMicro"=11000000 WHERE id='deposit'`,
    `DELETE FROM crypto_deposits WHERE id='deposit'`,
    `UPDATE crypto_deposits SET status='CREDITED' WHERE id='deposit'`,
    `UPDATE crypto_addresses SET label='replacement'`,
    `INSERT INTO crypto_deposits SELECT 'copy',"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot",'key2',"createdAt","expiresAt",'EXPIRED',NULL,NULL,NULL FROM crypto_deposits`,
  ])
    await expect(db.exec(sql)).rejects.toThrow();
  expect((await db.query(`SELECT status FROM crypto_deposits`)).rows).toEqual([
    { status: 'WAITING' },
  ]);
});
it('accepts an exact receipt and mint graph once; protects the evidence afterward', async () => {
  await db.exec(`BEGIN;
 INSERT INTO crypto_receipts VALUES ('receipt','deposit','${'ab'.repeat(32)}',0,'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,100,now(),now());
 INSERT INTO wallet_transactions VALUES ('wt','member','COINS','COIN_CREDIT','CREDIT','SUCCEEDED','PURCHASE','deposit',960,0,960);
 INSERT INTO economic_operations VALUES ('op','PURCHASE','member','CRYPTO_DEPOSIT','deposit',ARRAY['wt'],NULL);
 INSERT INTO coin_provenance VALUES ('lot','member','WITHDRAWABLE','op','wt');
 INSERT INTO coin_lot_entries VALUES ('entry','op','member','MINT','lot',960,0);
 UPDATE crypto_deposits SET status='CREDITED' WHERE id='deposit';
 INSERT INTO crypto_deposit_settlements VALUES ('settlement','deposit','receipt','wt',now());
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`);
  for (const sql of [
    `UPDATE crypto_receipts SET "amountMicro"=1`,
    `DELETE FROM crypto_receipts`,
    `UPDATE crypto_deposit_settlements SET "receiptId"='fake'`,
    `UPDATE crypto_deposits SET status='WAITING'`,
    `INSERT INTO crypto_receipts SELECT 'copy',"depositId","txHash","logIndex",contract,address,"amountMicro","blockNumber","blockTime","verifiedAt" FROM crypto_receipts`,
  ])
    await expect(db.exec(sql)).rejects.toThrow();
});
it('rejects completed withdrawal without exact hold backing', async () => {
  await expect(
    db.exec(
      `INSERT INTO crypto_withdrawals(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","holdOperationId") VALUES ('w','member','country','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,960,'{}','w','op')`
    )
  ).rejects.toThrow('exact hold');
});
it('refuses reusing an existing P2P withdrawal scope in the crypto channel', async () => {
  await db.exec(`INSERT INTO withdrawals VALUES('existing-p2p')`);
  await expect(
    db.exec(
      `INSERT INTO crypto_withdrawals(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","holdOperationId") VALUES ('existing-p2p','member','country','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,960,'{}','w2','op')`
    )
  ).rejects.toThrow('another payment channel');
});
