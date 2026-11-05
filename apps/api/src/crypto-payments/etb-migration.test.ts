import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, it, expect } from 'vitest';
const db = new PGlite();
const sql = (name: string) =>
  readFileSync(
    new URL(
      `../../../../packages/database/prisma/migrations/${name}/migration.sql`,
      import.meta.url
    ),
    'utf8'
  );
const etbMigration = sql('20261104150000_native_etb_wallet');
const policy = {
  version: 'ETB_V1',
  walletCurrency: 'ETB',
  minorDigits: 2,
  localPerUsd: '182.16377894',
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
};
const snapshot = { ...policy, usdtPerUsd: '1', rateId: 'rate' };
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id text PRIMARY KEY); CREATE TABLE countries(id text PRIMARY KEY); CREATE TABLE withdrawals(id text PRIMARY KEY);
 CREATE TABLE platform_gates(key text PRIMARY KEY,enabled boolean,"changedAt" timestamp);
 CREATE TABLE wallets(id text PRIMARY KEY,"coinsBalance" int);
 CREATE TABLE wallet_transactions(id text PRIMARY KEY,"userId" text,currency text,type text,"ledgerType" text,status text,"referenceType" text,"referenceId" text,amount int,"balanceBefore" int,"balanceAfter" int);
 CREATE TABLE economic_operations(id text PRIMARY KEY,type text,"userId" text,"scopeType" text,"scopeId" text,"walletTransactionIds" text[],"reversesOperationId" text);
 CREATE TABLE coin_provenance(id text PRIMARY KEY,"userId" text,"lotClass" text,"sourceOperationId" text,"walletTransactionId" text);
 CREATE TABLE coin_lot_entries(id text PRIMARY KEY,"operationId" text,"userId" text,"entryType" text,"lotId" text,"availableDelta" int,"reservedDelta" int);
 CREATE TABLE agent_orders(id text); CREATE TABLE agent_inventories(id text); CREATE TABLE withdrawal_quotes(id text);
 CREATE TABLE exchange_rate_configs(id text PRIMARY KEY,"fiatCurrency" text,"coinsPerUnit" numeric,"pricingPolicy" jsonb);
 CREATE TABLE coin_packages(id text,"isActive" boolean,"updatedAt" timestamp);
 INSERT INTO coin_packages VALUES('old',true,now());
 CREATE FUNCTION financial_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Append only'; END $$;
 CREATE FUNCTION ledger_apply_runtime_grants(text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
 INSERT INTO users VALUES ('member'),('admin');INSERT INTO countries VALUES ('country');`);
  await db.exec(sql('20261008010000_usdt_tron_payments'));
});
afterAll(() => db.close());
it('refuses to relabel a funded wallet or a zeroed wallet with history', async () => {
  await db.exec(`INSERT INTO wallets VALUES('existing',100)`);
  await expect(db.exec(etbMigration)).rejects.toThrow(/existing financial records/);
  await db.exec('ROLLBACK');
  expect((await db.query('SELECT "coinsBalance" FROM wallets')).rows).toEqual([
    { coinsBalance: 100 },
  ]);
  await db.exec(
    `UPDATE wallets SET "coinsBalance"=0;INSERT INTO wallet_transactions(id,currency) VALUES('history','COINS')`
  );
  await expect(db.exec(etbMigration)).rejects.toThrow(/existing financial records/);
  await db.exec('ROLLBACK');
  await db.exec('DELETE FROM wallet_transactions; DELETE FROM wallets;');
});
it('initializes only an empty ledger and permanently records the denomination', async () => {
  await db.exec(etbMigration);
  expect((await db.query('SELECT currency,"minorDigits" FROM wallet_denomination')).rows).toEqual([
    { currency: 'ETB', minorDigits: 2 },
  ]);
  expect((await db.query('SELECT "isActive" FROM coin_packages')).rows).toEqual([
    { isActive: false },
  ]);
  await expect(db.exec('DELETE FROM wallet_denomination')).rejects.toThrow('Append only');
  await expect(
    db.query('INSERT INTO exchange_rate_configs VALUES($1,$2,$3,$4)', [
      'bad',
      'ETB',
      1,
      JSON.stringify({ version: 'USD_V1' }),
    ])
  ).rejects.toThrow(/ETB pricing/);
  await db.query('INSERT INTO exchange_rate_configs VALUES($1,$2,$3,$4)', [
    'rate',
    'ETB',
    1,
    JSON.stringify(policy),
  ]);
});
it('enforces exact source-linked conversion and rejects forged or legacy snapshots', async () => {
  for (const [minor, terms, valid] of [
    [182163, snapshot, true],
    [182164, snapshot, false],
    [960, {}, false],
    [182163, { ...snapshot, rateId: 'missing' }, false],
    [182163, { ...snapshot, localPerUsd: '200' }, false],
  ] as const) {
    expect(
      (
        await db.query<{ valid: boolean }>('SELECT etb_crypto_amount_valid($1,$2,$3,$4) AS valid', [
          'deposit',
          '10000000',
          minor,
          JSON.stringify(terms),
        ])
      ).rows[0].valid
    ).toBe(valid);
  }
  expect(
    (
      await db.query<{ valid: boolean }>('SELECT etb_crypto_amount_valid($1,$2,$3,$4) AS valid', [
        'withdrawal',
        '9999957',
        182163,
        JSON.stringify(snapshot),
      ])
    ).rows[0].valid
  ).toBe(true);
  await db.exec(
    `INSERT INTO crypto_addresses(address,label,"addedBy") VALUES ('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7','fixture','admin')`
  );
  await expect(
    db.query(
      `INSERT INTO crypto_deposits(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","expiresAt") VALUES ('bad','member','country','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,182164,$1,'bad',now()+interval '15 minutes')`,
      [JSON.stringify(snapshot)]
    )
  ).rejects.toThrow(/crypto_deposit_etb_amount/);
  await db.query(
    `INSERT INTO crypto_deposits(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","expiresAt") VALUES ('deposit','member','country','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,182163,$1,'key',now()+interval '15 minutes')`,
    [JSON.stringify(snapshot)]
  );
});
it('keeps original ETB terms after repricing and still requires real settlement proof', async () => {
  await db.query('INSERT INTO exchange_rate_configs VALUES($1,$2,$3,$4)', [
    'new-rate',
    'ETB',
    1,
    JSON.stringify({ ...policy, localPerUsd: '185' }),
  ]);
  expect((await db.query('SELECT "coinAmount" FROM crypto_deposits')).rows).toEqual([
    { coinAmount: 182163 },
  ]);
  await expect(
    db.exec(`UPDATE crypto_deposits SET "coinAmount"=185000 WHERE id='deposit'`)
  ).rejects.toThrow(/immutable/);
  await expect(
    db.exec(`UPDATE crypto_deposits SET status='CREDITED' WHERE id='deposit'`)
  ).rejects.toThrow(/exact solidified receipt/);
  await db.exec(`BEGIN;
 INSERT INTO crypto_receipts VALUES ('receipt','deposit','${'ab'.repeat(32)}',0,'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t','TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',10000000,100,now(),now());
 INSERT INTO wallet_transactions VALUES ('wt','member','COINS','COIN_CREDIT','CREDIT','SUCCEEDED','PURCHASE','deposit',182163,0,182163);
 INSERT INTO economic_operations VALUES ('op','PURCHASE','member','CRYPTO_DEPOSIT','deposit',ARRAY['wt'],NULL);
 INSERT INTO coin_provenance VALUES ('lot','member','WITHDRAWABLE','op','wt');
 INSERT INTO coin_lot_entries VALUES ('entry','op','member','MINT','lot',182163,0);
 UPDATE crypto_deposits SET status='CREDITED' WHERE id='deposit';
 INSERT INTO crypto_deposit_settlements VALUES ('settlement','deposit','receipt','wt',now());
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`);
  await expect(
    db.exec(`INSERT INTO crypto_deposit_settlements VALUES ('copy','deposit','receipt','wt',now())`)
  ).rejects.toThrow();
});
