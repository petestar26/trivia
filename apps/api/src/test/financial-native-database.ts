import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const BOOTSTRAP_DATABASE = 'playqube_scheduled_throwaway';
const DATABASE_PACKAGE = new URL('../../../../packages/database/', import.meta.url);
const PRISMA_CLI = fileURLToPath(new URL('node_modules/prisma/build/index.js', DATABASE_PACKAGE));
const SCHEMA = fileURLToPath(new URL('prisma/schema.prisma', DATABASE_PACKAGE));
const OWN_DATABASE = /^playqube_fin_(?:admission|settlement)_[0-9a-f]{20}_throwaway$/;

/** Each financial native file owns a blank, migrated database. The acknowledged
 * bootstrap database is used only for CREATE/DROP DATABASE; no fixture, gate or
 * capital write is performed there. Append-only fixture rows disappear with the
 * owned database, without disabling any trigger or mutating financial history.
 */
export async function financialNativeDatabase(label: 'admission' | 'settlement') {
  const originalUrl = process.env.DATABASE_URL;
  const originalLedgerName = process.env.TEST_LEDGER_DB_NAME;
  const source = new URL(originalUrl ?? 'http://invalid');
  if (process.env.NODE_ENV !== 'test' ||
      !['postgresql:', 'postgres:'].includes(source.protocol) ||
      !['127.0.0.1', 'localhost'].includes(source.hostname) ||
      source.searchParams.has('host') || source.searchParams.has('hostaddr') ||
      source.pathname !== `/${BOOTSTRAP_DATABASE}` ||
      process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') {
    throw new Error('Financial native tests require the acknowledged loopback playqube_scheduled_throwaway database');
  }

  const name = `playqube_fin_${label}_${randomUUID().replaceAll('-', '').slice(0, 20)}_throwaway`;
  const isolated = new URL(source);
  isolated.pathname = `/${name}`;
  const admin = new PrismaClient({ datasourceUrl: source.toString(), log: [] });
  let client: PrismaClient | undefined;
  let created = false;
  let closed = false;

  async function dispose() {
    if (closed) return;
    // Only the exact database created by this helper may ever be dropped.
    // Disconnect first; FORCE is unnecessary and could hide leaked clients.
    try {
      await client?.$disconnect();
      if (created) {
        if (!OWN_DATABASE.test(name) || name === BOOTSTRAP_DATABASE) {
          throw new Error('Refusing to drop a database outside the financial native ownership guard');
        }
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
        created = false;
      }
      closed = true;
    } finally {
      await admin.$disconnect();
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalLedgerName === undefined) delete process.env.TEST_LEDGER_DB_NAME;
      else process.env.TEST_LEDGER_DB_NAME = originalLedgerName;
    }
  }

  try {
    const [database] = await admin.$queryRaw<Array<{ name: string }>>`
      SELECT pg_catalog.current_database() AS name`;
    if (database?.name !== BOOTSTRAP_DATABASE) {
      throw new Error('Financial native bootstrap connection does not match its exact acknowledged database');
    }
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const migration = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', SCHEMA], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: isolated.toString() },
      encoding: 'utf8', timeout: 240_000,
    });
    if (migration.status !== 0) {
      // Prisma can echo its connection URL in diagnostics; keep credentials out
      // of test logs even when the initial deployment fails.
      let output = `${migration.stdout ?? ''}\n${migration.stderr ?? ''}`
        .replaceAll(isolated.toString(), '[isolated database URL]');
      if (isolated.password) {
        output = output.replaceAll(isolated.password, '[password]')
          .replaceAll(decodeURIComponent(isolated.password), '[password]');
      }
      throw new Error(`Financial native migration failed (${migration.status ?? 'terminated'}): ${output}`);
    }
    client = new PrismaClient({ datasourceUrl: isolated.toString(), log: [] });
    const [identity] = await client.$queryRaw<Array<{ name: string }>>`
      SELECT pg_catalog.current_database() AS name`;
    if (identity?.name !== name) throw new Error('Financial native fixture client connected to the wrong database');
    process.env.DATABASE_URL = isolated.toString();
    process.env.TEST_LEDGER_DB_NAME = name;
    return { name, url: isolated.toString(), client, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
