import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

// Targeted SQL backstop test, independent of native lifecycle CI.
const db = new PGlite();
beforeAll(async () => {
  await db.exec(`CREATE TABLE countries (id text PRIMARY KEY);
    CREATE TABLE exchange_rate_configs (id text PRIMARY KEY, "countryId" text, "fiatCurrency" text,
      "coinsPerUnit" numeric(18,6), "effectiveAt" timestamp, "setBy" text, "isActive" boolean);
    CREATE TABLE agent_orders (id text PRIMARY KEY, status text);
    CREATE TABLE withdrawal_quotes (id text PRIMARY KEY, status text);
    CREATE TABLE withdrawals (id text PRIMARY KEY, status text);
    INSERT INTO countries VALUES ('legacy');
    INSERT INTO agent_orders VALUES ('old-order','CREATED');`);
  await db.exec(
    readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261004120000_usd_payment_pricing/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261004121000_usd_pricing_guard_paths/migration.sql', import.meta.url), 'utf8'));

  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261004122000_usd_activation_guard_path/migration.sql', import.meta.url), 'utf8'));

});
afterAll(async () => db.close());
it('keeps all existing countries and historical rows on legacy pricing', async () => {
  expect((await db.query('SELECT "usdPricingEnabled" FROM countries')).rows).toEqual([
    { usdPricingEnabled: false },
  ]);
  expect((await db.query('SELECT "pricingSnapshot" FROM agent_orders')).rows).toEqual([
    { pricingSnapshot: null },
  ]);
  expect(
    (await db.query('SELECT "coinAmount" FROM coin_packages ORDER BY "displayOrder"')).rows.map(
      (r: any) => r.coinAmount
    )
  ).toEqual([30, 70, 350, 700, 1400, 3500]);
});
it('allows lifecycle status updates but never rewrites pricing snapshots', async () => {
  for (const table of ['agent_orders', 'withdrawal_quotes', 'withdrawals']) {
    await db.exec(
      `INSERT INTO ${table} (id,status,"pricingSnapshot") VALUES ('new','ACTIVE','{"version":"USD_V1"}');`
    );
    await db.exec(`UPDATE ${table} SET status='COMPLETED' WHERE id='new';`);
    await expect(
      db.exec(`UPDATE ${table} SET "pricingSnapshot"='{}' WHERE id='new'`)
    ).rejects.toThrow(/immutable/);
  }
  await expect(
    db.exec(`UPDATE agent_orders SET "pricingSnapshot"='{}' WHERE id='old-order'`)
  ).rejects.toThrow(/immutable/);
});
it('makes activation one-way and rate terms append-only while allowing emergency disable', async () => {
  await db.exec(`UPDATE countries SET "usdPricingEnabled"=true WHERE id='legacy'`);
  await expect(
    db.exec(`UPDATE countries SET "usdPricingEnabled"=false WHERE id='legacy'`)
  ).rejects.toThrow(/cannot revert/);
  await db.exec(
    `INSERT INTO exchange_rate_configs (id,"pricingPolicy","isActive") VALUES ('rate','{"version":"USD_V1"}',true)`
  );
  await db.exec(`UPDATE exchange_rate_configs SET "isActive"=false WHERE id='rate'`);
  await expect(
    db.exec(`UPDATE exchange_rate_configs SET "pricingPolicy"=NULL WHERE id='rate'`)
  ).rejects.toThrow(/immutable/);
  await expect(
    db.exec(`UPDATE exchange_rate_configs SET "coinsPerUnit"=99 WHERE id='rate'`)
  ).rejects.toThrow(/immutable/);
});

it('pins every new guard to the existing ledger search-path policy', async () => {
  const { rows } = await db.query<{ proname: string; proconfig: string[] }>(`SELECT proname, proconfig FROM pg_proc WHERE proname IN
    ('payment_protect_usd_snapshot','payment_protect_usd_rate','payment_protect_usd_activation')`);
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(row.proconfig).toContain(row.proname === 'payment_protect_usd_activation' ? 'search_path=public, pg_temp' : 'search_path=pg_catalog, pg_temp');
});
