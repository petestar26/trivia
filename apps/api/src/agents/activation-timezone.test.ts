import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses UTC setup expiry and audit times in every session timezone', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id text PRIMARY KEY,role text,status text,"passwordHash" text,"tokenVersion" int DEFAULT 0,"updatedAt" timestamp);
      CREATE TABLE agents("userId" text,status text); CREATE TABLE sessions("userId" text);`);
    const migration = (name: string) => readFileSync(new URL(`../../../../packages/database/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
    await db.exec(migration('20261005130000_admin_agent_onboarding'));
    await db.exec(migration('20261007040000_agent_activation_utc'));
    const hash = '$2b$12$' + 'a'.repeat(53);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Vientiane']) {
      await db.query(`SELECT set_config('TimeZone',$1,false)`, [zone]);
      for (const expired of [true, false]) {
        const id = `${zone}-${expired}`;
        await db.query(`INSERT INTO users(id,role,status) VALUES($1,'USER','PENDING_VERIFICATION');`, [id]);
        await db.query(`INSERT INTO agents VALUES($1,'ACTIVE')`, [id]);
        await db.query(`INSERT INTO agent_account_setups("userId","createdBy","credentialHash","expiresAt") VALUES($1,'admin','temporary',(clock_timestamp() AT TIME ZONE 'UTC') + $2::interval)`, [id, expired ? '-1 hour' : '1 hour']);
        const result = await db.query<{allowed:boolean}>(`SELECT activate_provisioned_agent($1,'temporary',$2) AS allowed`, [id,hash]);
        expect((await db.query<{zone:string}>(`SELECT current_setting('TimeZone') AS zone`)).rows[0].zone).toBe(zone);
        expect(result.rows[0].allowed, `${zone}: expired=${expired}`).toBe(!expired);
        if (!expired) {
          const times = await db.query<{seconds:number}>(`SELECT abs(extract(epoch from ("consumedAt"-(clock_timestamp() AT TIME ZONE 'UTC'))))::float8 AS seconds FROM agent_account_setups WHERE "userId"=$1`, [id]);
          expect(times.rows[0].seconds).toBeLessThan(5);
          expect((await db.query<{allowed:boolean}>(`SELECT activate_provisioned_agent($1,'temporary',$2) AS allowed`,[id,hash])).rows[0].allowed).toBe(false);
        }
      }
    }
  } finally { await db.close(); }
});
