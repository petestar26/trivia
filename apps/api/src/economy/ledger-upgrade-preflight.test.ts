// Contract of the read-only ledger upgrade preflight:
// - it is configured by the ordinary environment alone (no .env file, no
//   application secrets), and never prints credentials, even on failure;
// - exit codes: 0 clean, 1 anomalies found, 2 could not evaluate;
// - its definitions are byte-identical (modulo whitespace) to the copies the
//   two gate migrations carry and to the function installed in the database.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@socialplay/database';
import {
  LEDGER_ANOMALY_PREDICATES, LEDGER_SOURCE_CURRENT, LEDGER_SOURCE_PROJECTED, LEGACY_CATALOG_PRECONDITIONS, normalizeSql,
} from './ledger-integrity-definitions.js';
import { redactSecrets, runLedgerUpgradePreflight } from './ledger-upgrade-preflight.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSX = join(API_ROOT, 'node_modules/.bin/tsx');
const SCRIPT = join(API_ROOT, 'src/scripts/ledger-upgrade-preflight.ts');
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/database/prisma/migrations/', import.meta.url));
const PRE_GATE = join(MIGRATIONS, '20260917900000_ledger_preupgrade_gate/migration.sql');
const FINAL_GATE = join(MIGRATIONS, '20260924000000_ledger_integrity_gate/migration.sql');

const emptyDirs: string[] = [];
afterAll(async () => {
  for (const dir of emptyDirs) rmSync(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

function runCli(env: Record<string, string>, args: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), 'preflight-cwd-'));
  emptyDirs.push(cwd);
  const run = spawnSync(TSX, [SCRIPT, ...args], {
    cwd, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 120_000,
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', all: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

function block(file: string, name: string): string {
  const text = readFileSync(file, 'utf8');
  const match = new RegExp(`-- ledger-integrity:${name}:begin\\n([\\s\\S]*?)-- ledger-integrity:${name}:end`).exec(text);
  if (!match) throw new Error(`${file} lacks the ${name} block`);
  return match[1];
}

describe('ledger upgrade preflight', () => {
  it('runs from a directory with no .env file, configured only by DATABASE_URL, and reports a clean ledger', () => {
    const url = process.env.DATABASE_URL!;
    const run = runCli({ DATABASE_URL: url });
    expect(run.status, run.all).toBe(0);
    expect(run.stdout).toContain('Schema: UPGRADED');
    expect(run.stdout).toContain('No ledger integrity anomalies found.');
    const parsed = new URL(url);
    expect(run.all).not.toContain(url);
    if (parsed.password) expect(run.all).not.toContain(`:${decodeURIComponent(parsed.password)}@`);
  });

  it('--json emits one machine-readable report', () => {
    const run = runCli({ DATABASE_URL: process.env.DATABASE_URL! }, ['--json']);
    expect(run.status, run.all).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ mode: 'UPGRADED', anomalies: [], definitionDrift: false,
      snapshot: { readOnly: true, isolation: 'repeatable read' } });
    expect(typeof report.database).toBe('string');
  });

  it('never prints credentials, even when it cannot connect', () => {
    const secret = `S3cr3t-${randomUUID().slice(0, 8)}`;
    const login = `preflight_${randomUUID().slice(0, 6)}`;
    for (const url of [
      `postgresql://${login}:${secret}@127.0.0.1:1/nowhere?schema=public`,
      `postgresql://127.0.0.1:1/nowhere?user=${login}&password=${secret}`,
    ]) {
      const run = runCli({ DATABASE_URL: url });
      expect(run.status).toBe(2);
      expect(run.all).toContain('could not evaluate');
      expect(run.all).not.toContain(secret);
      expect(run.all).not.toContain(login);
      expect(run.all).not.toContain(url);
    }
  });

  it('never prints credentials when the server itself echoes the login back (role missing)', () => {
    const secret = `S3cr3t-${randomUUID().slice(0, 8)}`;
    const login = `preflight_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const server = new URL(process.env.DATABASE_URL!);
    const database = server.pathname.slice(1);
    for (const url of [
      `postgresql://${login}:${secret}@${server.host}/${database}?schema=public`,
      `postgresql://${server.host}/${database}?user=${login}&password=${secret}`,
    ]) {
      const run = runCli({ DATABASE_URL: url });
      expect(run.status, run.all).toBe(2);
      expect(run.all).toContain('could not evaluate');
      expect(run.all).not.toContain(secret);
      expect(run.all).not.toContain(login);
    }
  });

  it('exits 2 with a clear message when DATABASE_URL is not set', () => {
    const run = runCli({});
    expect(run.status).toBe(2);
    expect(run.all).toContain('DATABASE_URL is not set');
    expect(run.all).not.toMatch(/\n\s+at /);
  });

  it('redacts every credential form it may see in driver messages', () => {
    // Each value also appears on its own, as a driver may echo it outside the URL.
    const text = 'Error at postgresql://alice:pa%40ss@db.internal:5432/app?password=hunter2&sslmode=require and pa@ss, hunter2, alice';
    const redacted = redactSecrets(text, 'postgresql://alice:pa%40ss@db.internal:5432/app?password=hunter2&sslmode=require');
    expect(redacted).not.toMatch(/alice|pa%40ss|pa@ss|hunter2/);
    expect(redacted).toContain('[redacted]');
  });

  it('the migrations carry the same definitions, and the database runs the same function', async () => {
    expect(normalizeSql(block(PRE_GATE, 'predicates'))).toBe(normalizeSql(LEDGER_ANOMALY_PREDICATES));
    expect(normalizeSql(block(FINAL_GATE, 'predicates'))).toBe(normalizeSql(LEDGER_ANOMALY_PREDICATES));
    expect(normalizeSql(block(PRE_GATE, 'source-projected'))).toBe(normalizeSql(LEDGER_SOURCE_PROJECTED));
    expect(normalizeSql(block(PRE_GATE, 'catalog-preconditions'))).toBe(normalizeSql(LEGACY_CATALOG_PRECONDITIONS));
    expect(normalizeSql(block(FINAL_GATE, 'source-current'))).toBe(normalizeSql(LEDGER_SOURCE_CURRENT));
    const report = await runLedgerUpgradePreflight(prisma);
    expect({ mode: report.mode, drift: report.definitionDrift }).toEqual({ mode: 'UPGRADED', drift: false });
  });

  it('reports each anomaly with exit code 1 and an escalation instruction, never a bypass', async () => {
    const name = `playqube_prefl_${randomUUID().replaceAll('-', '').slice(0, 8)}_throwaway`;
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
      const prismaBin = fileURLToPath(new URL('../../../../packages/database/node_modules/.bin/prisma', import.meta.url));
      const schema = fileURLToPath(new URL('../../../../packages/database/prisma/schema.prisma', import.meta.url));
      const migrated = spawnSync(prismaBin, ['migrate', 'deploy', '--schema', schema],
        { env: { PATH: process.env.PATH ?? '', DATABASE_URL: url.toString() }, encoding: 'utf8', timeout: 240_000 });
      expect(migrated.status, migrated.stdout + migrated.stderr).toBe(0);
      const orphan = `orphan-${randomUUID().slice(0, 8)}`;
      const scratch = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      try {
        await scratch.$transaction([
          scratch.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
          scratch.$executeRawUnsafe(`INSERT INTO users (id, email, username, "passwordHash", "displayName", "updatedAt")
            VALUES ($1, $1 || '@m.test', $1, 'x', 'Orphan', now())`, orphan),
          scratch.$executeRawUnsafe('INSERT INTO coin_ledger_accounts ("userId", "classifiedAt") VALUES ($1, now())', orphan),
        ]);
      } finally { await scratch.$disconnect(); }
      const run = runCli({ DATABASE_URL: url.toString() });
      expect(run.status, run.all).toBe(1);
      expect(run.stdout).toContain('WALLET_MISSING (1)');
      expect(run.stdout).toContain(orphan);
      expect(run.stdout).toContain('docs/deployment/ledger-upgrade-gate.md');
      expect(run.all).not.toMatch(/--applied/);

      // A database whose installed definitions differ from this release
      // cannot be evaluated consistently: exit 2, not a clean report.
      const drifted = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
      try {
        const [row] = await drifted.$queryRawUnsafe<{ body: string }[]>(
          `SELECT prosrc AS body FROM pg_proc WHERE oid = to_regprocedure('ledger_integrity_anomalies()')`);
        await drifted.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "ledger_integrity_anomalies"()
          RETURNS TABLE ("category" text, "subjectType" text, "subjectId" text, "userId" text, "detail" text)
          LANGUAGE sql STABLE AS $ledger$${row.body.replace("'WALLET_MISSING', 'user'", "'WALLET_ABSENT', 'user'")}$ledger$`);
      } finally { await drifted.$disconnect(); }
      const drift = runCli({ DATABASE_URL: url.toString() }, ['--json']);
      expect(drift.status, drift.all).toBe(2);
      expect(JSON.parse(drift.stdout)).toMatchObject({ mode: 'UPGRADED', definitionDrift: true });
    } finally {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  }, 300_000);
});
