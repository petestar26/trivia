// In-memory PostgreSQL fixture only. Does not read DATABASE_URL or create credentials.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const sql = readFileSync(
  new URL(
    '../../../packages/database/prisma/migrations/20261113060000_owner_reset_issuance/migration.sql',
    import.meta.url
  ),
  'utf8'
);
const db = new PGlite();
try {
  await db.exec(
    'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC; ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO PUBLIC; ALTER DEFAULT PRIVILEGES GRANT ALL ON SCHEMAS TO PUBLIC;'
  );
  await assert.rejects(db.exec(sql.replace(/COMMIT;\s*$/, 'SELECT 1/0; COMMIT;')));
  await db.exec('ROLLBACK');
  let r = await db.query("SELECT to_regnamespace('password_reset_private') IS NULL AS absent");
  assert.equal(r.rows[0].absent, true);
  await db.exec(sql);
  r = await db.query(
    "SELECT n.nspname, a.privilege_type FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='password_reset_private' AND a.grantee=0"
  );
  assert.equal(r.rows.length, 0);
  r = await db.query(
    "SELECT a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname='password_reset_private' AND a.grantee=0"
  );
  assert.equal(r.rows.length, 0);
  r = await db.query(
    "SELECT a.privilege_type FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='public.consume_owner_password_reset(uuid,text,text,integer,timestamptz)'::regprocedure AND a.grantee=0"
  );
  assert.equal(r.rows.length, 0);
  console.log(
    'PASS: failed migration fully rolls back; retry succeeds; PUBLIC inherited defaults stripped for schema/table/function. In-memory only; no credentials created.'
  );
} finally {
  await db.close();
}
