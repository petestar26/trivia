// Migration matrix for the ledger upgrade, driven through the real Prisma CLI
// against scratch databases on the same local server:
//   fresh install, replay, populated upgrade from master-era data, a stop at
//   the pre-upgrade gate (nothing changed) and at the final integrity gate
//   (that migration changed nothing), each followed by the documented
//   stop-and-escalate recovery: a reviewed correction, then
//   `prisma migrate resolve --rolled-back <gate>`, then an ordinary redeploy.
// It never marks a gate as applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@socialplay/database';
import { runLedgerUpgradePreflight } from '../economy/ledger-upgrade-preflight.js';

const DATABASE_PACKAGE = fileURLToPath(new URL('../../../../packages/database/', import.meta.url));
const PRISMA = join(DATABASE_PACKAGE, 'node_modules/.bin/prisma');
const SCHEMA = join(DATABASE_PACKAGE, 'prisma/schema.prisma');
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma/migrations');
const PRE_GATE = '20260917900000_ledger_preupgrade_gate';
const FINAL_GATE = '20260924000000_ledger_integrity_gate';
const AUTHORIZATION = '20260924010000_ledger_resolution_authorization';
const OPENING_JOURNAL = '20260923030000_opus_freeze_legacy_allocations';
const WINDOW_CHECK = '20260924090000_ledger_upgrade_window_check';
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const RUNTIME_ACCESS = fileURLToPath(new URL('../scripts/ledger-runtime-access.ts', import.meta.url));
const ALL = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const MASTER = ALL.filter((name) => name < PRE_GATE);
// The migrations added after the parent release (bfe2263). Every other one is
// the parent's, byte for byte: a migration a database has applied is never
// edited, so what corrects it comes forward.
const ADDED_AFTER_PARENT = ['20260924050000_ledger_cascade_trigger_search_path',
  '20260924060000_ledger_runtime_grants_cascade_keys'];
const PARENT = ALL.filter((name) => !ADDED_AFTER_PARENT.includes(name));

const created: string[] = [];
const scratchRoots: string[] = [];

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function scratchDatabase(label: string): Promise<{ name: string; url: string; client: PrismaClient }> {
  const name = `playqube_upg_${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}_throwaway`;
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  created.push(name);
  const url = urlFor(name);
  return { name, url, client: new PrismaClient({ datasourceUrl: url, log: [] }) };
}

/** A schema file whose sibling migrations directory holds exactly `names`. */
function migrationSubset(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-upgrade-'));
  scratchRoots.push(root);
  cpSync(SCHEMA, join(root, 'schema.prisma'));
  cpSync(join(MIGRATIONS, 'migration_lock.toml'), join(root, 'migrations', 'migration_lock.toml'));
  for (const name of names) cpSync(join(MIGRATIONS, name), join(root, 'migrations', name), { recursive: true });
  return join(root, 'schema.prisma');
}

function prismaCli(url: string, args: string[]): { status: number; output: string } {
  const run = spawnSync(PRISMA, args, {
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: url }, encoding: 'utf8', timeout: 240_000,
  });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
}
const deploy = (url: string, schema = SCHEMA) => prismaCli(url, ['migrate', 'deploy', '--schema', schema]);

function execute(url: string, sql: string): void {
  const root = mkdtempSync(join(tmpdir(), 'ledger-sql-'));
  scratchRoots.push(root);
  writeFileSync(join(root, 'script.sql'), sql);
  const run = prismaCli(url, ['db', 'execute', '--url', url, '--file', join(root, 'script.sql')]);
  if (run.status !== 0) throw new Error(`SQL script failed: ${run.output}`);
}

/** `prisma migrate deploy` running in the background, so a test can observe it waiting. */
function deployInBackground(url: string, schema = SCHEMA) {
  const child = spawn(PRISMA, ['migrate', 'deploy', '--schema', schema],
    { env: { PATH: process.env.PATH ?? '', DATABASE_URL: url } });
  let output = '';
  let exited = false;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const done = new Promise<{ status: number; output: string }>((resolve) => {
    child.on('close', (code) => { exited = true; resolve({ status: code ?? -1, output }); });
  });
  return { done, hasExited: () => exited };
}

/** Resolves once some backend of `database` waits on a lock; throws if none does in time. */
async function waitForLockWaitIn(database: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, database);
    if (row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no backend of ${database} waited on a lock within ${timeoutMs}ms`);
}

class WriterRolledBack extends Error {}

/** A writer transaction on `url` that has run `statements` and is still open,
 * until the test commits or rolls it back. */
async function openWriter(url: string, statements: [string, ...unknown[]][]) {
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  let decide!: (commit: boolean) => void;
  const decision = new Promise<boolean>((resolve) => { decide = resolve; });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => { written = resolve; });
  const finished = client.$transaction(async (tx) => {
    for (const [sql, ...params] of statements) await tx.$executeRawUnsafe(sql, ...params);
    written();
    if (!(await decision)) throw new WriterRolledBack();
  }, { timeout: 240_000, maxWait: 10_000 }).then(() => 'committed' as const, (error) => {
    if (error instanceof WriterRolledBack) return 'rolled back' as const;
    throw error;
  }).finally(() => client.$disconnect());
  await Promise.race([ready, finished.then(() => { throw new Error('writer finished before the test decided'); })]);
  return {
    commit: () => { decide(true); return finished; },
    rollback: () => { decide(false); return finished; },
  };
}

/** A writer transaction driven one statement at a time, so a test can
 * interleave it with a migration. A statement that fails ends it. */
function stepWriter(url: string) {
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  const steps: { sql: string; params: unknown[]; resolve: (outcome: string) => void }[] = [];
  let notify: () => void = () => undefined;
  let ended = false;
  let commit = false;
  const finished = client.$transaction(async (tx) => {
    for (;;) {
      while (!steps.length && !ended) await new Promise<void>((resolve) => { notify = resolve; });
      const step = steps.shift();
      if (!step) break;
      try {
        await tx.$executeRawUnsafe(step.sql, ...step.params);
        step.resolve('ok');
      } catch (error) {
        step.resolve(`error: ${String((error as Error).message)}`);
        throw error;
      }
    }
    if (!commit) throw new WriterRolledBack();
  }, { timeout: 240_000, maxWait: 10_000 }).then(() => 'committed', (error) => (
    error instanceof WriterRolledBack ? 'rolled back' : `aborted: ${String((error as Error).message).slice(0, 300)}`))
    .finally(() => client.$disconnect());
  return {
    run: (sql: string, ...params: unknown[]) => new Promise<string>((resolve) => { steps.push({ sql, params, resolve }); notify(); }),
    end: (commitIt: boolean) => { commit = commitIt; ended = true; notify(); return finished; },
  };
}

async function migrationRows(client: PrismaClient) {
  return client.$queryRawUnsafe<{ migration_name: string; finished: boolean; rolled_back: boolean; steps: number }[]>(
    `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back,
            applied_steps_count AS steps FROM _prisma_migrations ORDER BY started_at, migration_name`);
}

async function relationExists(client: PrismaClient, name: string): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<{ found: boolean }[]>('SELECT to_regclass($1) IS NOT NULL AS found', name);
  return rows[0].found;
}

/**
 * The owner-run setup (ledger:runtime-access) for a fresh runtime role on an
 * upgraded database: it installs a disposable approval key, applies the
 * runtime grants and verifies them, refusing (exit 1) a database where a role
 * outside the owner's trust owns objects in, or can still create in, the
 * schemas where code running as the owner resolves names.
 */
async function runtimeSetup(db: { url: string; client: PrismaClient }) {
  const role = `playqube_upg_runtime_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
  try {
    const run = spawnSync(TSX, [RUNTIME_ACCESS], {
      env: { PATH: process.env.PATH ?? '', LEDGER_OWNER_DATABASE_URL: db.url, LEDGER_RUNTIME_ROLE: role,
        LEDGER_APPROVAL_SIGNING_KEY: randomBytes(32).toString('hex'), LEDGER_APPROVAL_KEY_ID: `upg-${role.slice(-8)}` },
      encoding: 'utf8', timeout: 120_000 });
    const [row] = await db.client.$queryRawUnsafe<{ runtime: boolean; public: boolean }[]>(`
      SELECT has_schema_privilege($1, 'public', 'CREATE') AS runtime,
             EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                     WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS public`, role);
    return { status: run.status, output: `${run.stdout}${run.stderr}`, runtimeCanCreate: row.runtime, publicCanCreate: row.public };
  } finally {
    await db.client.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
}

async function anomalies(client: PrismaClient) {
  return client.$queryRawUnsafe<{ category: string; subjectId: string | null }[]>(
    'SELECT "category", "subjectId" FROM "ledger_integrity_anomalies"()');
}

// Master-era (9b0c4f0 schema) records: a settled purchase, a gift, an ACTIVE
// and a completed withdrawal hold, a resolved withdrawal dispute and a
// reviewed agent application, plus the wallets and wallet history behind them.
function masterEraSeed(ids: Record<string, string>, extra = ''): string {
  const t = "TIMESTAMP '2026-09-10 10:00:00'";
  return `
INSERT INTO users (id, email, username, "passwordHash", "displayName", role, "createdAt", "updatedAt") VALUES
  ('${ids.alice}', '${ids.alice}@m.test', 'alice${ids.tag}', 'x', 'Alice', 'USER', ${t}, ${t}),
  ('${ids.bob}', '${ids.bob}@m.test', 'bob${ids.tag}', 'x', 'Bob', 'USER', ${t}, ${t}),
  ('${ids.carol}', '${ids.carol}@m.test', 'carol${ids.tag}', 'x', 'Carol', 'USER', ${t}, ${t}),
  ('${ids.dave}', '${ids.dave}@m.test', 'dave${ids.tag}', 'x', 'Dave', 'USER', ${t}, ${t}),
  ('${ids.agentUser}', '${ids.agentUser}@m.test', 'agent${ids.tag}', 'x', 'Agent', 'USER', ${t}, ${t}),
  ('${ids.admin}', '${ids.admin}@m.test', 'admin${ids.tag}', 'x', 'Admin', 'SUPER_ADMIN', ${t}, ${t});
INSERT INTO wallets (id, "userId", "coinsBalance", "gamePointsBalance", "updatedAt") VALUES
  ('w-${ids.alice}', '${ids.alice}', 1000, 0, ${t}),
  ('w-${ids.bob}', '${ids.bob}', 0, 20, ${t}),
  ('w-${ids.carol}', '${ids.carol}', 100, 0, ${t}),
  ('w-${ids.dave}', '${ids.dave}', 0, 0, ${t});
INSERT INTO countries (id, code, name, "currencyCode", "isActive", "agentPaymentEnabled", "updatedAt") VALUES
  ('${ids.country}', 'Q${ids.tag.slice(0, 1).toUpperCase()}', 'Master era ${ids.tag}', 'USD', true, true, ${t}),
  -- master never limited country codes (its own tests write ones like W3SFBFA4F)
  ('${ids.longCountry}', 'LONG${ids.tag.toUpperCase()}', 'Long code ${ids.tag}', 'USD', false, false, ${t});
INSERT INTO payment_method_definitions (id, "countryId", type, name, "fieldSchema", "updatedAt")
  VALUES ('${ids.method}', '${ids.country}', 'BANK_TRANSFER', 'Bank ${ids.tag}', '{}', ${t});
INSERT INTO exchange_rate_configs (id, "countryId", "fiatCurrency", "coinsPerUnit", "setBy")
  VALUES ('${ids.rate}', '${ids.country}', 'USD', 2, '${ids.admin}');
INSERT INTO agents (id, "userId", "countryId", "displayName", "contactEmail", "updatedAt")
  VALUES ('${ids.agent}', '${ids.agentUser}', '${ids.country}', 'Agent ${ids.tag}', 'agent@m.test', ${t});
INSERT INTO agent_applications (id, "agentId", "submittedData", status, "reviewedBy", "reviewedAt")
  VALUES ('${ids.application}', '${ids.agent}', '{"reason":"master era"}', 'APPROVED', '${ids.admin}', ${t});
INSERT INTO agent_payment_accounts (id, "agentId", "countryId", "methodDefId", "accountDetails", "updatedAt")
  VALUES ('${ids.agentAccount}', '${ids.agent}', '${ids.country}', '${ids.method}', '{"accountNumber":"1"}', ${t});
INSERT INTO agent_orders (id, "orderNumber", "userId", "agentId", "countryId", "paymentMethodDefId", "paymentAccountId",
    "paymentSnapshot", "fiatAmount", "fiatCurrency", "exchangeRateConfigId", "exchangeRateValue", "coinAmount",
    "idempotencyKey", status, "updatedAt")
  VALUES ('${ids.order}', 'MO-${ids.tag}', '${ids.alice}', '${ids.agent}', '${ids.country}', '${ids.method}',
    '${ids.agentAccount}', '{}', 600, 'USD', '${ids.rate}', 2, 1200, 'order-${ids.tag}', 'COMPLETED', ${t});
INSERT INTO gifts (id, name, "coinPrice", "recipientPointValue", "updatedAt")
  VALUES ('${ids.gift}', 'Rose ${ids.tag}', 200, 20, ${t});
INSERT INTO wallet_transactions (id, "walletId", "userId", type, "ledgerType", currency, amount, "balanceBefore",
    "balanceAfter", "referenceType", "referenceId", description, status, "createdAt") VALUES
  ('tx-a1-${ids.tag}', 'w-${ids.alice}', '${ids.alice}', 'COIN_CREDIT', 'CREDIT', 'COINS', 1200, 0, 1200, 'AGENT_ORDER', '${ids.order}', 'purchase', 'SUCCEEDED', ${t}),
  ('tx-a2-${ids.tag}', 'w-${ids.alice}', '${ids.alice}', 'GIFT_SEND', 'DEBIT', 'COINS', 200, 1200, 1000, 'GIFT', '${ids.giftTx}', 'gift', 'SUCCEEDED', ${t}),
  ('tx-b1-${ids.tag}', 'w-${ids.bob}', '${ids.bob}', 'GIFT_RECEIVE', 'CREDIT', 'GAME_POINTS', 20, 0, 20, 'GIFT', '${ids.giftTx}', 'gift', 'SUCCEEDED', ${t}),
  ('tx-c1-${ids.tag}', 'w-${ids.carol}', '${ids.carol}', 'COIN_CREDIT', 'CREDIT', 'COINS', 300, 0, 300, 'REWARD', 'reward-${ids.tag}', 'reward', 'SUCCEEDED', ${t}),
  ('tx-c2-${ids.tag}', 'w-${ids.carol}', '${ids.carol}', 'COIN_DEBIT', 'DEBIT', 'COINS', 200, 300, 100, 'WITHDRAWAL', '${ids.heldWithdrawal}', 'hold', 'SUCCEEDED', ${t}),
  ('tx-d1-${ids.tag}', 'w-${ids.dave}', '${ids.dave}', 'COIN_CREDIT', 'CREDIT', 'COINS', 50, 0, 50, 'REWARD', 'reward2-${ids.tag}', 'reward', 'SUCCEEDED', ${t}),
  ('tx-d2-${ids.tag}', 'w-${ids.dave}', '${ids.dave}', 'COIN_DEBIT', 'DEBIT', 'COINS', 50, 50, 0, 'WITHDRAWAL', '${ids.doneWithdrawal}', 'hold', 'SUCCEEDED', ${t});
INSERT INTO gift_transactions (id, "senderId", "recipientId", "giftId", quantity, "totalCoins", "totalGamePoints",
    "coinPriceAtTransaction", "pointValueAtTransaction", "senderWalletId", "recipientWalletId")
  VALUES ('${ids.giftTx}', '${ids.alice}', '${ids.bob}', '${ids.gift}', 1, 200, 20, 200, 20, 'w-${ids.alice}', 'w-${ids.bob}');
INSERT INTO user_payout_accounts (id, "userId", "countryId", "methodDefId", "accountDetails", "updatedAt") VALUES
  ('pa-c-${ids.tag}', '${ids.carol}', '${ids.country}', '${ids.method}', '{"accountNumber":"2"}', ${t}),
  ('pa-d-${ids.tag}', '${ids.dave}', '${ids.country}', '${ids.method}', '{"accountNumber":"3"}', ${t});
INSERT INTO withdrawal_quotes (id, "userId", "countryId", "fiatCurrency", "coinAmount", "fiatAmount",
    "exchangeRateConfigId", "exchangeRateValue", "requestHash", "expiresAt") VALUES
  ('q-c-${ids.tag}', '${ids.carol}', '${ids.country}', 'USD', 200, 100, '${ids.rate}', 2, 'h1', ${t}),
  ('q-d-${ids.tag}', '${ids.dave}', '${ids.country}', 'USD', 50, 25, '${ids.rate}', 2, 'h2', ${t});
INSERT INTO withdrawals (id, "withdrawalNumber", "userId", "requestHash", "idempotencyKey", "countryId",
    "paymentMethodDefId", "paymentAccountId", "paymentSnapshot", "fiatAmount", "fiatCurrency", "exchangeRateConfigId",
    "exchangeRateValue", "coinAmount", "quoteExpiresAt", "updatedAt", "quoteId", status, "paymentSubmittedAt", "completedAt") VALUES
  ('${ids.heldWithdrawal}', 'WD-1-${ids.tag}', '${ids.carol}', 'h1', 'k1-${ids.tag}', '${ids.country}', '${ids.method}',
   'pa-c-${ids.tag}', '{}', 100, 'USD', '${ids.rate}', 2, 200, ${t}, ${t}, 'q-c-${ids.tag}', 'HELD', NULL, NULL),
  ('${ids.doneWithdrawal}', 'WD-2-${ids.tag}', '${ids.dave}', 'h2', 'k2-${ids.tag}', '${ids.country}', '${ids.method}',
   'pa-d-${ids.tag}', '{}', 25, 'USD', '${ids.rate}', 2, 50, ${t}, ${t}, 'q-d-${ids.tag}', 'COMPLETED', ${t}, ${t});
INSERT INTO withdrawal_holds (id, "withdrawalId", "coinAmount", status, "debitWalletTransactionId", "consumedAt") VALUES
  ('${ids.activeHold}', '${ids.heldWithdrawal}', 200, 'ACTIVE', 'tx-c2-${ids.tag}', NULL),
  ('hold-d-${ids.tag}', '${ids.doneWithdrawal}', 50, 'CONSUMED', 'tx-d2-${ids.tag}', ${t});
INSERT INTO withdrawal_disputes (id, "withdrawalId", "openedBy", reason, description, status, resolution, "resolvedBy",
    "assignedAdminId", "resolutionNote", "openedAt", "assignedAt", "resolvedAt", "openedFromStatus")
  VALUES ('dispute-${ids.tag}', '${ids.doneWithdrawal}', '${ids.dave}', 'FIAT_NOT_RECEIVED', 'late payout', 'RESOLVED',
    'RELEASE_COINS', '${ids.admin}', '${ids.admin}', 'payout confirmed', ${t}, ${t}, ${t}, 'PAYMENT_SUBMITTED');
${extra}`;
}

function masterIds() {
  const tag = randomUUID().replaceAll('-', '').slice(0, 8);
  const id = (label: string) => `${label}-${tag}`;
  return { tag, alice: id('alice'), bob: id('bob'), carol: id('carol'), dave: id('dave'), agentUser: id('agentuser'),
    admin: id('admin'), country: id('country'), longCountry: id('country-long'), method: id('method'), rate: id('rate'), agent: id('agent'),
    application: id('application'), agentAccount: id('agentacct'), order: id('order'), gift: id('gift'),
    giftTx: id('gifttx'), heldWithdrawal: id('wd-held'), doneWithdrawal: id('wd-done'), activeHold: id('hold-active') };
}

const LEGACY_TABLES = ['users', 'wallets', 'wallet_transactions', 'gifts', 'gift_transactions', 'agent_orders',
  'agents', 'agent_applications', 'agent_payment_accounts', 'withdrawals', 'withdrawal_holds', 'withdrawal_quotes',
  'user_payout_accounts', 'withdrawal_disputes', 'countries'];

/** Fingerprint of every master-era column of every legacy table. Columns the
 * upgrade adds later are excluded, so only pre-existing data is compared. */
async function legacyFingerprint(client: PrismaClient, columns?: Record<string, string[]>) {
  const cols: Record<string, string[]> = columns ?? Object.fromEntries(await Promise.all(LEGACY_TABLES.map(async (table) => [table,
    (await client.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1
       ORDER BY ordinal_position`, table)).map((row) => row.column_name)])));
  const digests: Record<string, string> = {};
  for (const table of LEGACY_TABLES) {
    const list = cols[table].map((c) => `"${c}"`).join(', ');
    const rows = await client.$queryRawUnsafe<{ n: number; digest: string | null }[]>(
      `SELECT count(*)::int AS n, md5(string_agg(row_text, E'\\n' ORDER BY row_text)) AS digest
       FROM (SELECT ROW(${list})::text AS row_text FROM "${table}") t`);
    digests[table] = `${rows[0].n}:${rows[0].digest}`;
  }
  return { columns: cols, digests };
}

beforeAll(() => {
  expect(ALL).toContain(PRE_GATE);
  expect(ALL).toContain(FINAL_GATE);
  expect(ALL.indexOf(FINAL_GATE)).toBeLessThan(ALL.indexOf(AUTHORIZATION));
  expect(ALL.at(-1)).toBe(WINDOW_CHECK);
  expect(MASTER.at(-1)).toBe('20260917000000_group_invites_hardening');
  expect(ALL).toEqual(expect.arrayContaining(ADDED_AFTER_PARENT));
});

// Dropping every scratch database (dozens of them) can outlast the default
// hook timeout on a loaded machine.
afterAll(async () => {
  for (const name of created) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  await prisma.$disconnect();
}, 300_000);

describe('ledger upgrade migrations', () => {
  it('fresh install: every migration applies, both gates pass, and a replay is a no-op', async () => {
    const db = await scratchDatabase('fresh');
    try {
      const first = deploy(db.url);
      expect(first.status, first.output).toBe(0);
      const rows = await migrationRows(db.client);
      expect(rows.map((row) => row.migration_name)).toEqual(ALL);
      expect(rows.every((row) => row.finished && !row.rolled_back)).toBe(true);
      expect(await anomalies(db.client)).toEqual([]);
      const preflight = await runLedgerUpgradePreflight(db.client);
      expect({ mode: preflight.mode, anomalies: preflight.anomalies.length, drift: preflight.definitionDrift })
        .toEqual({ mode: 'UPGRADED', anomalies: 0, drift: false });
      const replay = deploy(db.url);
      expect(replay.status, replay.output).toBe(0);
      expect(replay.output).toContain('No pending migrations to apply');
      const status = prismaCli(db.url, ['migrate', 'status', '--schema', SCHEMA]);
      expect(status.output).toContain('Database schema is up to date');
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('a database at the parent release upgrades: the candidate migrations apply, the candidate setup verifies, and a replay has nothing pending', async () => {
    const db = await scratchDatabase('parent');
    try {
      const parent = deploy(db.url, migrationSubset(PARENT));
      expect(parent.status, parent.output).toBe(0);
      // The parent's grants function predates the cascade-key rules, and a
      // correction to the migration that installed it would never run here:
      // the candidate setup does not verify it.
      const early = await runtimeSetup(db);
      expect(early.status, early.output).toBe(1);
      expect(early.output).toMatch(/can still change agents\.id, a key other tables follow by cascade/);

      const upgrade = deploy(db.url);
      expect(upgrade.status, upgrade.output).toBe(0);
      for (const name of ADDED_AFTER_PARENT) expect(upgrade.output).toContain(`Applying migration \`${name}\``);
      const rows = await migrationRows(db.client);
      expect(rows.map((row) => row.migration_name).sort()).toEqual(ALL);
      expect(rows.every((row) => row.finished && !row.rolled_back)).toBe(true);

      const setup = await runtimeSetup(db);
      expect(setup.status, setup.output).toBe(0);
      expect(setup.output).toContain('Verified');

      const replay = deploy(db.url);
      expect(replay.status, replay.output).toBe(0);
      expect(replay.output).toContain('No pending migrations to apply');
      const status = prismaCli(db.url, ['migrate', 'status', '--schema', SCHEMA]);
      expect(status.output).toContain('Database schema is up to date');
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('populated upgrade from master-era data preserves every legacy record and opens the ledger under review', async () => {
    const db = await scratchDatabase('populated');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      // As on a master database created by PostgreSQL 13 or 14, where PUBLIC
      // may create in schema public by default.
      execute(db.url, `GRANT CREATE ON SCHEMA public TO PUBLIC;\n${masterEraSeed(ids)}`);
      const before = await legacyFingerprint(db.client);

      const preflight = await runLedgerUpgradePreflight(db.client);
      expect({ mode: preflight.mode, anomalies: preflight.anomalies }).toEqual({ mode: 'PRE_UPGRADE', anomalies: [] });

      const upgrade = deploy(db.url);
      expect(upgrade.status, upgrade.output).toBe(0);
      expect((await legacyFingerprint(db.client, before.columns)).digests).toEqual(before.digests);

      // What the upgrade adds: one unclassified account per wallet, one
      // conservative UNCLASSIFIED lot per positive balance, and the ACTIVE
      // hold as a reserved UNCLASSIFIED lot under an OPEN legacy review.
      const accounts = await db.client.$queryRawUnsafe<{ userId: string; classified: boolean }[]>(
        `SELECT "userId", "classifiedAt" IS NOT NULL AS classified FROM coin_ledger_accounts ORDER BY "userId"`);
      expect(accounts).toEqual([ids.alice, ids.bob, ids.carol, ids.dave].sort().map((userId) => ({ userId, classified: false })));
      const lots = await db.client.$queryRawUnsafe<{ userId: string; lotClass: string; state: string; available: number; reserved: number; reviewStatus: string | null }[]>(
        `SELECT p."userId", p."lotClass"::text AS "lotClass", p.state::text AS state, p."availableAmount" AS available,
                p."reservedAmount" AS reserved, r.status AS "reviewStatus"
         FROM coin_provenance p LEFT JOIN legacy_balance_reviews r ON r.id = p."reviewId"
         ORDER BY p."userId", p."reservedAmount"`);
      expect(lots).toEqual([
        { userId: ids.alice, lotClass: 'UNCLASSIFIED', state: 'OPEN', available: 1000, reserved: 0, reviewStatus: null },
        { userId: ids.carol, lotClass: 'UNCLASSIFIED', state: 'OPEN', available: 100, reserved: 0, reviewStatus: null },
        { userId: ids.carol, lotClass: 'UNCLASSIFIED', state: 'OPEN', available: 0, reserved: 200, reviewStatus: 'OPEN' },
      ].sort((a, b) => a.userId.localeCompare(b.userId) || a.reserved - b.reserved));
      // Every country, whatever its code, gets a jurisdiction with no active policy.
      const jurisdictions = await db.client.$queryRawUnsafe<{ countryCode: string; activePolicyId: string | null }[]>(
        `SELECT j."countryCode", j."activePolicyId" FROM country_jurisdictions j
         JOIN countries c ON c.code = j."countryCode" WHERE c.id IN ($1, $2) ORDER BY j."countryCode"`, ids.longCountry, ids.country);
      expect(jurisdictions).toEqual([`LONG${ids.tag.toUpperCase()}`, `Q${ids.tag.slice(0, 1).toUpperCase()}`]
        .map((countryCode) => ({ countryCode, activePolicyId: null })));
      expect(await anomalies(db.client)).toEqual([]);
      const after = await runLedgerUpgradePreflight(db.client);
      expect({ mode: after.mode, anomalies: after.anomalies.length, drift: after.definitionDrift })
        .toEqual({ mode: 'UPGRADED', anomalies: 0, drift: false });
      // The owner-run setup accepts the upgraded master database: nothing in
      // it belongs to a role outside the owner's trust, and PUBLIC's CREATE,
      // which the upgrade kept, is the setup's own to revoke.
      const [kept] = await db.client.$queryRawUnsafe<{ public: boolean }[]>(`
        SELECT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                       WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS public`);
      expect(kept.public).toBe(true);
      const setup = await runtimeSetup(db);
      expect(setup.status, setup.output).toBe(0);
      expect(setup.output).toContain('Verified');
      expect({ runtime: setup.runtimeCanCreate, public: setup.publicCanCreate }).toEqual({ runtime: false, public: false });
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('pre-upgrade anomaly: the first gate stops before any ledger migration runs, then the escalation procedure recovers', async () => {
    const db = await scratchDatabase('pregate');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      const erin = `erin-${ids.tag}`;
      const frank = `frank-${ids.tag}`;
      // A master-era ACTIVE hold whose owner has no wallet row: the upgrade
      // would create a reserved lot for a user with no wallet.
      execute(db.url, masterEraSeed(ids, `
INSERT INTO users (id, email, username, "passwordHash", "displayName", "updatedAt")
  VALUES ('${erin}', '${erin}@m.test', 'erin${ids.tag}', 'x', 'Erin', now());
INSERT INTO withdrawal_quotes (id, "userId", "countryId", "fiatCurrency", "coinAmount", "fiatAmount",
    "exchangeRateConfigId", "exchangeRateValue", "requestHash", "expiresAt")
  VALUES ('q-e-${ids.tag}', '${erin}', '${ids.country}', 'USD', 75, 37, '${ids.rate}', 2, 'h3', now());
INSERT INTO user_payout_accounts (id, "userId", "countryId", "methodDefId", "accountDetails", "updatedAt")
  VALUES ('pa-e-${ids.tag}', '${erin}', '${ids.country}', '${ids.method}', '{}', now());
INSERT INTO withdrawals (id, "withdrawalNumber", "userId", "requestHash", "idempotencyKey", "countryId",
    "paymentMethodDefId", "paymentAccountId", "paymentSnapshot", "fiatAmount", "fiatCurrency", "exchangeRateConfigId",
    "exchangeRateValue", "coinAmount", "quoteExpiresAt", "updatedAt", "quoteId", status)
  VALUES ('wd-e-${ids.tag}', 'WD-3-${ids.tag}', '${erin}', 'h3', 'k3-${ids.tag}', '${ids.country}', '${ids.method}',
    'pa-e-${ids.tag}', '{}', 37, 'USD', '${ids.rate}', 2, 75, now(), now(), 'q-e-${ids.tag}', 'HELD');
INSERT INTO withdrawal_holds (id, "withdrawalId", "coinAmount", status, "debitWalletTransactionId")
  VALUES ('hold-e-${ids.tag}', 'wd-e-${ids.tag}', 75, 'ACTIVE', 'missing-tx-${ids.tag}');
-- Control: a CONSUMED hold of another wallet-less user creates no lot, so it is no anomaly.
INSERT INTO users (id, email, username, "passwordHash", "displayName", "updatedAt")
  VALUES ('${frank}', '${frank}@m.test', 'frank${ids.tag}', 'x', 'Frank', now());
INSERT INTO withdrawal_quotes (id, "userId", "countryId", "fiatCurrency", "coinAmount", "fiatAmount",
    "exchangeRateConfigId", "exchangeRateValue", "requestHash", "expiresAt")
  VALUES ('q-f-${ids.tag}', '${frank}', '${ids.country}', 'USD', 30, 15, '${ids.rate}', 2, 'h4', now());
INSERT INTO user_payout_accounts (id, "userId", "countryId", "methodDefId", "accountDetails", "updatedAt")
  VALUES ('pa-f-${ids.tag}', '${frank}', '${ids.country}', '${ids.method}', '{}', now());
INSERT INTO withdrawals (id, "withdrawalNumber", "userId", "requestHash", "idempotencyKey", "countryId",
    "paymentMethodDefId", "paymentAccountId", "paymentSnapshot", "fiatAmount", "fiatCurrency", "exchangeRateConfigId",
    "exchangeRateValue", "coinAmount", "quoteExpiresAt", "updatedAt", "quoteId", status, "paymentSubmittedAt", "completedAt")
  VALUES ('wd-f-${ids.tag}', 'WD-4-${ids.tag}', '${frank}', 'h4', 'k4-${ids.tag}', '${ids.country}', '${ids.method}',
    'pa-f-${ids.tag}', '{}', 15, 'USD', '${ids.rate}', 2, 30, now(), now(), 'q-f-${ids.tag}', 'COMPLETED', now(), now());
INSERT INTO withdrawal_holds (id, "withdrawalId", "coinAmount", status, "debitWalletTransactionId", "consumedAt")
  VALUES ('hold-f-${ids.tag}', 'wd-f-${ids.tag}', 30, 'CONSUMED', 'missing-tx2-${ids.tag}', now());`));
      const before = await legacyFingerprint(db.client);

      const preflight = await runLedgerUpgradePreflight(db.client);
      expect(preflight.mode).toBe('PRE_UPGRADE');
      expect(preflight.anomalies.map((a) => [a.category, a.subjectId])).toEqual([['WALLET_MISSING', erin]]);

      const stopped = deploy(db.url);
      expect(stopped.status).not.toBe(0);
      expect(stopped.output).toContain('P3018');
      expect(stopped.output).toContain(PRE_GATE);
      expect(stopped.output).toContain('LEDGER PRE-UPGRADE GATE STOPPED THE UPGRADE');
      expect(stopped.output).toContain(`WALLET_MISSING x1 [${erin}]`);
      expect(stopped.output).not.toMatch(/--applied/);
      const stoppedReport = await runLedgerUpgradePreflight(db.client);
      expect({ mode: stoppedReport.mode, failed: stoppedReport.migrations.failed })
        .toEqual({ mode: 'PRE_UPGRADE', failed: [PRE_GATE] });
      const failed = await migrationRows(db.client);
      expect(failed.at(-1)).toMatchObject({ migration_name: PRE_GATE, finished: false, rolled_back: false, steps: 0 });
      expect(failed.filter((row) => row.migration_name > PRE_GATE)).toEqual([]);
      expect(await relationExists(db.client, 'coin_provenance')).toBe(false);
      expect((await legacyFingerprint(db.client, before.columns)).digests).toEqual(before.digests);

      const retryWithoutResolve = deploy(db.url);
      expect(retryWithoutResolve.status).not.toBe(0);
      expect(retryWithoutResolve.output).toContain('P3009');

      // Stand-in for the separately reviewed, case-specific correction.
      execute(db.url, `INSERT INTO wallets (id, "userId", "coinsBalance", "gamePointsBalance", "updatedAt")
        VALUES ('w-${erin}', '${erin}', 0, 0, now());`);
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
      const resolved = prismaCli(db.url, ['migrate', 'resolve', '--rolled-back', PRE_GATE, '--schema', SCHEMA]);
      expect(resolved.status, resolved.output).toBe(0);
      const retried = deploy(db.url);
      expect(retried.status, retried.output).toBe(0);
      expect(await anomalies(db.client)).toEqual([]);
      const erinLots = await db.client.$queryRawUnsafe<{ reserved: number; status: string }[]>(
        `SELECT p."reservedAmount" AS reserved, r.status FROM coin_provenance p JOIN legacy_balance_reviews r ON r.id = p."reviewId"
         WHERE p."userId" = $1`, erin);
      expect(erinLots).toEqual([{ reserved: 75, status: 'OPEN' }]);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('final gate: a malformed upgraded ledger stops the upgrade, which changes nothing, and the backup restore recovers', async () => {
    const db = await scratchDatabase('finalgate');
    const backup = `${db.name.replace('_throwaway', '')}_bak_throwaway`;
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      // Runbook step: a restorable backup of the pre-upgrade database.
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${backup}" TEMPLATE "${db.name}"`);
      created.push(backup);
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < FINAL_GATE))).status).toBe(0);
      const u = `orphan-${randomUUID().slice(0, 8)}`; const lot = `nullstate-${randomUUID().slice(0, 8)}`;
      const op = `op-${randomUUID().slice(0, 8)}`; const owner = `owner-${randomUUID().slice(0, 8)}`;
      execute(db.url, `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO users (id, email, username, "passwordHash", "displayName", "updatedAt") VALUES
  ('${u}', '${u}@m.test', '${u}', 'x', 'Orphan', now()), ('${owner}', '${owner}@m.test', '${owner}', 'x', 'Owner', now());
INSERT INTO coin_ledger_accounts ("userId", "classifiedAt") VALUES ('${u}', now()), ('${owner}', NULL);
INSERT INTO wallets (id, "userId", "coinsBalance", "gamePointsBalance", "updatedAt") VALUES ('w-${owner}', '${owner}', 0, 0, now());
INSERT INTO economic_operations (id, type, "userId", "scopeType", "scopeId", "walletTransactionIds", "createdBy")
  VALUES ('${op}', 'LEGACY_OPENING', '${owner}', 'LEGACY_LOT', '${lot}', '{}', 'SYSTEM');
INSERT INTO coin_provenance (id, "userId", amount, "provenanceType", "restrictionStatus", "originalSource", "lotClass",
    state, "availableAmount", "reservedAmount", "requirementAmount", "progressAmount", "sourceOperationId", "createdAt", "updatedAt")
  VALUES ('${lot}', '${owner}', 1, 'ADMIN_ADJUSTMENT', 'UNRESTRICTED', 'ADMIN_ADJUSTMENT', 'UNCLASSIFIED', NULL, 0, 0, 0, 0, '${op}', now(), now());
COMMIT;`);
      const preflight = await runLedgerUpgradePreflight(db.client);
      expect(preflight.mode).toBe('UPGRADED');
      expect(preflight.anomalies.map((a) => [a.category, a.subjectId]).sort())
        .toEqual([['LOT_STATE_NULL', lot], ['WALLET_MISSING', u]]);

      const stopped = deploy(db.url);
      expect(stopped.status).not.toBe(0);
      expect(stopped.output).toContain(FINAL_GATE);
      expect(stopped.output).toContain('LEDGER INTEGRITY GATE STOPPED THE UPGRADE');
      expect(stopped.output).toContain(`LOT_STATE_NULL x1 [${lot}]`);
      expect(stopped.output).toContain(`WALLET_MISSING x1 [${u}]`);
      expect(stopped.output).not.toMatch(/--applied/);
      expect((await migrationRows(db.client)).at(-1)).toMatchObject({ migration_name: FINAL_GATE, finished: false, steps: 0 });
      const installed = await db.client.$queryRawUnsafe<{ fn: boolean; guard: boolean }[]>(
        `SELECT to_regprocedure('ledger_integrity_anomalies()') IS NOT NULL AS fn,
                EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'coin_lot_initialization_guard') AS guard`);
      expect(installed).toEqual([{ fn: false, guard: false }]);

      // Runbook response to a stop after the pre-upgrade gate: restore the
      // pre-upgrade backup (never correct the partly upgraded ledger in
      // place), run the preflight, deploy again with writers stopped.
      await db.client.$disconnect();
      await prisma.$executeRawUnsafe(`DROP DATABASE "${db.name}" WITH (FORCE)`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${db.name}" TEMPLATE "${backup}"`);
      const restored = await runLedgerUpgradePreflight(db.client);
      expect({ mode: restored.mode, anomalies: restored.anomalies }).toEqual({ mode: 'PRE_UPGRADE', anomalies: [] });
      const retried = deploy(db.url);
      expect(retried.status, retried.output).toBe(0);
      expect(await anomalies(db.client)).toEqual([]);
      expect(await relationExists(db.client, 'ledger_upgrade_window')).toBe(false);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('authorization: an ADMIN_ADJUST recorded before the rules exist stops the upgrade, which changes nothing', async () => {
    const db = await scratchDatabase('authorization');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, masterEraSeed(ids));
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < AUTHORIZATION))).status).toBe(0);
      const forged = `op-forged-${ids.tag}`;
      execute(db.url, `INSERT INTO economic_operations (id, type, "userId", "scopeType", "scopeId", "walletTransactionIds", "createdBy")
        VALUES ('${forged}', 'ADMIN_ADJUST', '${ids.alice}', 'ADMIN_ADJUSTMENT', 'case-${ids.tag}', '{}', 'SYSTEM');`);
      const result = deploy(db.url);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(AUTHORIZATION);
      expect(result.output).toContain('LEDGER AUTHORIZATION CHECK STOPPED THE UPGRADE: 1 recorded operation(s)');
      expect(result.output).toContain(`ADMIN_ADJUST ${forged}: admin adjustment ${forged} is not the execution of any adjustment approval`);
      expect(result.output).not.toMatch(/--applied/);
      expect((await migrationRows(db.client)).at(-1)).toMatchObject({ migration_name: AUTHORIZATION, finished: false });
      expect(await relationExists(db.client, 'admin_adjustment_approvals')).toBe(false);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('an ACTIVE hold whose withdrawal row is missing is reported, never silently dropped by a join', async () => {
    const db = await scratchDatabase('orphanhold');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, `${masterEraSeed(ids)}
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO withdrawal_holds (id, "withdrawalId", "coinAmount", status, "debitWalletTransactionId")
  VALUES ('hold-orphan-${ids.tag}', 'wd-gone-${ids.tag}', 40, 'ACTIVE', 'tx-gone-${ids.tag}');
COMMIT;`);
      const preflight = await runLedgerUpgradePreflight(db.client);
      expect(preflight.anomalies.map((a) => [a.category, a.subjectId])).toEqual([['WALLET_MISSING', null]]);
      const stopped = deploy(db.url);
      expect(stopped.status).not.toBe(0);
      expect(stopped.output).toContain('WALLET_MISSING x1 [NULL]');
      expect(await relationExists(db.client, 'coin_provenance')).toBe(false);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('the preflight refuses an intermediate schema instead of guessing', async () => {
    const db = await scratchDatabase('partial');
    try {
      const partial = ALL.filter((name) => name <= '20260918010000_casino_foundation_schema');
      expect(deploy(db.url, migrationSubset(partial)).status).toBe(0);
      const preflight = await runLedgerUpgradePreflight(db.client);
      expect(preflight.mode).toBe('UNSUPPORTED');
      expect(preflight.anomalies).toEqual([]);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('the preflight answers UNSUPPORTED for ledger tables without a lot class, instead of failing in the anomaly query', async () => {
    const db = await scratchDatabase('nolotclass');
    try {
      execute(db.url, `
        CREATE TABLE "wallets" ("userId" TEXT PRIMARY KEY, "coinsBalance" INTEGER NOT NULL);
        CREATE TABLE "coin_provenance" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
        CREATE TABLE "coin_ledger_accounts" ("userId" TEXT PRIMARY KEY, "classifiedAt" TIMESTAMP(3));
        CREATE TABLE "coin_lot_entries" ("operationId" TEXT, "lotId" TEXT);
        CREATE TABLE "economic_operations" ("id" TEXT PRIMARY KEY, "userId" TEXT);
        CREATE TABLE "legacy_balance_reviews" ("id" TEXT PRIMARY KEY, "userId" TEXT, "status" TEXT);`);
      const preflight = await runLedgerUpgradePreflight(db.client);
      expect({ mode: preflight.mode, anomalies: preflight.anomalies }).toEqual({ mode: 'UNSUPPORTED', anomalies: [] });
      expect(preflight.reason).not.toContain('coin_provenance.lotClass');
    } finally { await db.client.$disconnect(); }
  }, 300_000);
});

// The pre-casino API (master 9b0c4f0, apps/api/src/games/game-catalog.ts)
// creates these rows the first time the catalog is listed or a game is
// played: ensureGameDefinitions() upserts each configuration through Prisma,
// i.e. as JSON.stringify of these objects. JavaScript prints lucky_spin's
// 0.10 as 0.1, which is exactly what made the fixed-literal rules hash
// verification stop a real master database before canonical hashing.
const MASTER_RUNTIME_CATALOG = [
  { key: 'lucky_spin', name: 'Lucky Spin', type: 'LUCKY_SPIN', minBet: 10, maxBet: 500,
    description: 'Spin the wheel and try your luck! Different segments offer different multipliers.',
    configuration: { outcomes: [
      { name: 'LOSE', multiplier: 0, probability: 0.45 }, { name: 'SMALL_WIN', multiplier: 1.5, probability: 0.25 },
      { name: 'MEDIUM_WIN', multiplier: 3, probability: 0.15 }, { name: 'LARGE_WIN', multiplier: 5, probability: 0.10 },
      { name: 'JACKPOT', multiplier: 10, probability: 0.05 }] } },
  { key: 'dice', name: 'Dice', type: 'DICE', minBet: 5, maxBet: 1000,
    description: 'Roll the dice! A sum of 7 or higher doubles your bet.',
    configuration: { winThreshold: 7, multiplier: 2 } },
  { key: 'number_challenge', name: 'Number Challenge', type: 'NUMBER_CHALLENGE', minBet: 10, maxBet: 200,
    description: 'Guess a number between 1 and 100. The closer you are, the more you win!',
    configuration: { range: { min: 1, max: 100 }, rewards: { exact: 5, within1: 3, within5: 2, within10: 1.5 } } },
  { key: 'trivia', name: 'Trivia', type: 'TRIVIA', minBet: 5, maxBet: 100,
    description: 'Answer trivia questions correctly to earn rewards!',
    configuration: { correctMultiplier: 3 } },
];

/** The rows ensureGameDefinitions() writes; `raw` overrides a configuration's
 * JSON text for formatting and rule-change variants. */
function masterRuntimeCatalogSql(raw: Record<string, string> = {}): string {
  return MASTER_RUNTIME_CATALOG.map((game) => {
    const json = (raw[game.key] ?? JSON.stringify(game.configuration)).replaceAll("'", "''");
    return `INSERT INTO game_definitions (id, key, name, description, type, "minBet", "maxBet", configuration, "isActive", "updatedAt")
  VALUES (gen_random_uuid()::text, '${game.key}', '${game.name}', '${game.description.replaceAll("'", "''")}', '${game.type}',
    ${game.minBet}, ${game.maxBet}, '${json}'::jsonb, true, now());`;
  }).join('\n');
}

const RULES_HASH_LITERALS = Object.fromEntries([...readFileSync(
  join(MIGRATIONS, '20260922060000_g0_rules_hash_verification_fix/migration.sql'), 'utf8',
).matchAll(/WHEN '([a-z_]+)' THEN '([0-9a-f]{64})'/g)].map((match) => [match[1], match[2]]));

async function legacyRules(client: PrismaClient) {
  const rows = await client.$queryRawUnsafe<{ key: string; hash: string; rules: string }[]>(
    `SELECT d.key, r."rulesHash" AS hash, r.rules::text AS rules FROM game_rules r
     JOIN game_definitions d ON d.id = r."gameId"
     WHERE r.version = 1 AND d.key IN ('lucky_spin', 'dice', 'number_challenge', 'trivia') ORDER BY d.key`);
  return Object.fromEntries(rows.map((row) => [row.key, { hash: row.hash, rules: row.rules }]));
}

async function catalogFingerprint(client: PrismaClient) {
  const [row] = await client.$queryRawUnsafe<{ definitions: string; rules: string }[]>(
    `SELECT (SELECT md5(string_agg(t::text, E'\\n' ORDER BY t.id)) FROM game_definitions t) AS definitions,
            (SELECT md5(string_agg(t::text, E'\\n' ORDER BY t.id)) FROM game_rules t) AS rules`);
  return row;
}

function readCatalog(url: string): { listed: string[]; games: Record<string, { rulesHash: string | null }> } {
  const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  const probe = fileURLToPath(new URL('../test/catalog-read-probe.ts', import.meta.url));
  const run = spawnSync(tsx, [probe], { env: { PATH: process.env.PATH ?? '', DATABASE_URL: url }, encoding: 'utf8', timeout: 120_000 });
  if (run.status !== 0) throw new Error(`catalog probe failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

async function freshRules() {
  const db = await scratchDatabase('rulesfresh');
  try {
    expect(deploy(db.url).status).toBe(0);
    return await legacyRules(db.client);
  } finally { await db.client.$disconnect(); }
}

describe('legacy game rules on a master database whose catalog the pre-casino API initialized', () => {
  it('the complete upgrade succeeds, with the same canonical rules and hashes as a fresh install', async () => {
    const fresh = await freshRules();
    expect(Object.fromEntries(Object.entries(fresh).map(([key, value]) => [key, value.hash]))).toEqual(RULES_HASH_LITERALS);
    const db = await scratchDatabase('mastercatalog');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterEraSeed(masterIds(), masterRuntimeCatalogSql()));
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
      const upgrade = deploy(db.url);
      expect(upgrade.status, upgrade.output).toBe(0);
      expect(await legacyRules(db.client)).toEqual(fresh);
      expect(await anomalies(db.client)).toEqual([]);
      const setup = await runtimeSetup(db);
      expect(setup.status, setup.output).toBe(0);
      expect(setup.output).toContain('Verified');
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('equivalent number formatting upgrades to identical rules and hashes', async () => {
    const fresh = await freshRules();
    const lucky = JSON.stringify(MASTER_RUNTIME_CATALOG[0].configuration);
    for (const [label, raw] of [
      ['0.10', { lucky_spin: lucky.replace('"probability":0.1}', '"probability":0.10}') }],
      ['0.100 and 1e-1', { lucky_spin: lucky.replace('"probability":0.1}', '"probability":1e-1}').replace('0.45', '0.450') }],
      ['1.50', { number_challenge: '{"range":{"min":1,"max":100},"rewards":{"exact":5.0,"within1":3,"within5":2,"within10":1.50}}' }],
    ] as const) {
      const db = await scratchDatabase('rulesformat');
      try {
        expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
        execute(db.url, masterRuntimeCatalogSql(raw));
        const upgrade = deploy(db.url);
        expect(upgrade.status, `${label}: ${upgrade.output}`).toBe(0);
        expect(await legacyRules(db.client), label).toEqual(fresh);
      } finally { await db.client.$disconnect(); }
    }
  }, 300_000);

  it('a genuine rules difference stops at the pre-upgrade gate, before any database change', async () => {
    const db = await scratchDatabase('ruleschange');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const lucky = JSON.stringify(MASTER_RUNTIME_CATALOG[0].configuration).replace('"probability":0.1}', '"probability":0.11}');
      execute(db.url, masterEraSeed(masterIds(), masterRuntimeCatalogSql({ lucky_spin: lucky, dice: '{"winThreshold":8,"multiplier":2}' })));
      const before = await legacyFingerprint(db.client);
      const catalogBefore = await db.client.$queryRawUnsafe<{ digest: string }[]>(
        `SELECT md5(string_agg(t::text, E'\\n' ORDER BY t.id)) AS digest FROM game_definitions t`);

      const preflight = await runLedgerUpgradePreflight(db.client);
      expect(preflight.anomalies.map((a) => [a.category, a.subjectId])).toEqual([['GAME_RULES_CHANGED', 'dice'], ['GAME_RULES_CHANGED', 'lucky_spin']]);

      const stopped = deploy(db.url);
      expect(stopped.status).not.toBe(0);
      expect(stopped.output).toContain(PRE_GATE);
      expect(stopped.output).toContain('GAME_RULES_CHANGED x2 [dice, lucky_spin]');
      expect((await migrationRows(db.client)).filter((row) => row.migration_name >= PRE_GATE))
        .toEqual([{ migration_name: PRE_GATE, finished: false, rolled_back: false, steps: 0 }]);
      expect(await relationExists(db.client, 'game_rules')).toBe(false);
      expect(await relationExists(db.client, 'coin_provenance')).toBe(false);
      expect((await legacyFingerprint(db.client, before.columns)).digests).toEqual(before.digests);
      expect(await db.client.$queryRawUnsafe(
        `SELECT md5(string_agg(t::text, E'\\n' ORDER BY t.id)) AS digest FROM game_definitions t`)).toEqual(catalogBefore);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('replaying the migrations, and their hash verifications, preserves the same hashes', async () => {
    const db = await scratchDatabase('rulesreplay');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      expect(deploy(db.url).status).toBe(0);
      const upgraded = await legacyRules(db.client);
      const replay = deploy(db.url);
      expect(replay.output).toContain('No pending migrations to apply');
      for (const verification of ['20260922020000_g0_rules_hash_verification', '20260922060000_g0_rules_hash_verification_fix']) {
        execute(db.url, readFileSync(join(MIGRATIONS, verification, 'migration.sql'), 'utf8'));
      }
      expect(await legacyRules(db.client)).toEqual(upgraded);
      const [recomputed] = await db.client.$queryRawUnsafe<{ lucky: string }[]>(
        `SELECT "rules_hash"(configuration) AS lucky FROM game_definitions WHERE key = 'lucky_spin'`);
      expect(recomputed.lucky).toBe(RULES_HASH_LITERALS.lucky_spin);
      expect(upgraded.lucky_spin.hash).toBe(RULES_HASH_LITERALS.lucky_spin);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('the catalog stays read-only after upgrading: rules cannot be edited, and serving the catalog writes nothing', async () => {
    const db = await scratchDatabase('rulesreadonly');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      expect(deploy(db.url).status).toBe(0);
      const before = await catalogFingerprint(db.client);
      const served = readCatalog(db.url);
      expect(served.listed).toEqual(expect.arrayContaining(['dice', 'number_challenge', 'trivia']));
      expect(served.listed).not.toContain('lucky_spin');
      expect(served.games.lucky_spin.rulesHash).toBe(RULES_HASH_LITERALS.lucky_spin);
      expect(await catalogFingerprint(db.client)).toEqual(before);
      for (const [sql, message] of [
        [`UPDATE game_rules SET "rulesHash" = repeat('0', 64)`, 'game_rules is immutable'],
        [`UPDATE game_rules SET rules = '{}'::jsonb`, 'game_rules is immutable'],
        ['DELETE FROM game_rules', 'game_rules is immutable'],
        [`UPDATE game_definitions SET mode = 'BONUS' WHERE key = 'dice'`, 'metadata disagrees with active game_rules'],
        [`UPDATE game_definitions SET "currentRulesVersion" = 2 WHERE key = 'dice'`, 'points to missing game_rules'],
      ] as const) {
        await expect(db.client.$executeRawUnsafe(sql), sql).rejects.toThrow(message);
      }
      expect(await catalogFingerprint(db.client)).toEqual(before);
    } finally { await db.client.$disconnect(); }
  }, 300_000);
});

// The supported upgrade runs with every application writer stopped. These
// schedules prove what happens when one is not: every race either waits and
// then evaluates the committed result, or stops the upgrade. None completes
// around a write it did not see.
describe('the upgrade window covers every field reconciliation and classification read', () => {
  const t = "TIMESTAMP '2026-09-10 10:00:00'";
  // Purchase evidence and a game session, as master records them.
  const evidenceSeed = (ids: ReturnType<typeof masterIds>) => `
INSERT INTO agent_reservations (id, "orderId", "agentId", amount, status, "createdAt", "consumedAt")
  VALUES ('res-${ids.tag}', '${ids.order}', '${ids.agent}', 1200, 'CONSUMED', ${t}, ${t});
INSERT INTO agent_order_settlements (id, "orderId", "reservationId", "coinAmount", "walletTransactionId", "resolvedVia", "releasedBy", "settledAt")
  VALUES ('set-${ids.tag}', '${ids.order}', 'res-${ids.tag}', 1200, 'tx-a1-${ids.tag}', 'AGENT_RELEASE', '${ids.agentUser}', ${t});
INSERT INTO game_sessions (id, "userId", "gameId", status, "betAmount", result, "rewardAmount", "isWin", "createdAt", "completedAt")
  SELECT 'gs-${ids.tag}', '${ids.alice}', g.id, 'COMPLETED', 10, '{"sum": 4}', 0, false, ${t}, ${t}
  FROM game_definitions g WHERE g.key = 'dice';`;

  async function snapshotted(label: string) {
    const db = await scratchDatabase(label);
    expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
    const ids = masterIds();
    execute(db.url, masterRuntimeCatalogSql());
    execute(db.url, masterEraSeed(ids, evidenceSeed(ids)));
    const staged = deploy(db.url, migrationSubset(ALL.filter((name) => name <= PRE_GATE)));
    expect(staged.status, staged.output).toBe(0);
    return { db, ids };
  }

  it('the same data, unchanged, upgrades completely', async () => {
    const { db } = await snapshotted('windowbase');
    try {
      const result = deploy(db.url);
      expect(result.status, result.output).toBe(0);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  // Each keeps every row count and every credited amount.
  const changes: [string, (ids: ReturnType<typeof masterIds>) => string][] = [
    ['wallet_transactions.balanceBefore', (ids) => `UPDATE wallet_transactions SET "balanceBefore" = "balanceBefore" + 1 WHERE id = 'tx-a2-${ids.tag}'`],
    ['wallet_transactions.balanceAfter', (ids) => `UPDATE wallet_transactions SET "balanceAfter" = "balanceAfter" - 1 WHERE id = 'tx-a2-${ids.tag}'`],
    ['wallet_transactions.createdAt (chronology)', (ids) => `UPDATE wallet_transactions SET "createdAt" = "createdAt" - interval '1 day' WHERE id = 'tx-a2-${ids.tag}'`],
    ['wallet_transactions.type', (ids) => `UPDATE wallet_transactions SET type = 'GIFT_RECEIVE' WHERE id = 'tx-c1-${ids.tag}'`],
    ['wallet_transactions.referenceType', (ids) => `UPDATE wallet_transactions SET "referenceType" = 'GAME' WHERE id = 'tx-c1-${ids.tag}'`],
    ['wallet_transactions.referenceId', (ids) => `UPDATE wallet_transactions SET "referenceId" = 'another-order' WHERE id = 'tx-a1-${ids.tag}'`],
    ['wallet_transactions.walletId', (ids) => `UPDATE wallet_transactions SET "walletId" = 'w-${ids.bob}' WHERE id = 'tx-c1-${ids.tag}'`],
    ['agent_order_settlements.walletTransactionId', (ids) => `UPDATE agent_order_settlements SET "walletTransactionId" = 'tx-c1-${ids.tag}' WHERE id = 'set-${ids.tag}'`],
    ['agent_order_settlements.resolvedVia', (ids) => `UPDATE agent_order_settlements SET "resolvedVia" = 'ADMIN_DISPUTE_RESOLUTION' WHERE id = 'set-${ids.tag}'`],
    ['agent_orders.status', (ids) => `UPDATE agent_orders SET status = 'DISPUTE' WHERE id = '${ids.order}'`],
    ['agent_orders.userId', (ids) => `UPDATE agent_orders SET "userId" = '${ids.bob}' WHERE id = '${ids.order}'`],
    ['agent_reservations.status', (ids) => `UPDATE agent_reservations SET status = 'RELEASED' WHERE id = 'res-${ids.tag}'`],
    ['withdrawal_holds.debitWalletTransactionId', (ids) => `UPDATE withdrawal_holds SET "debitWalletTransactionId" = 'tx-c1-${ids.tag}' WHERE id = '${ids.activeHold}'`],
    ['withdrawals.userId', (ids) => `UPDATE withdrawals SET "userId" = '${ids.dave}' WHERE id = '${ids.heldWithdrawal}'`],
    ['gift_transactions.recipientId', (ids) => `UPDATE gift_transactions SET "recipientId" = '${ids.carol}' WHERE id = '${ids.giftTx}'`],
    ['game_sessions.status', (ids) => `UPDATE game_sessions SET status = 'FAILED' WHERE id = 'gs-${ids.tag}'`],
  ];
  for (const [field, change] of changes) {
    it(`a change to ${field} between migration stages stops the upgrade`, async () => {
      const { db, ids } = await snapshotted('windowfield');
      try {
        execute(db.url, `${change(ids)};`);
        const result = deploy(db.url);
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toMatch(/LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE|LEDGER INTEGRITY GATE STOPPED THE UPGRADE/);
        expect((await migrationRows(db.client)).every((row) => row.migration_name !== WINDOW_CHECK || !row.finished)).toBe(true);
      } finally { await db.client.$disconnect(); }
    }, 300_000);
  }

  it('the row count still catches an intervening FAILED wallet transaction whose row hash cancels out', async () => {
    // The hash half of the fingerprint is a sum of row hashes, so a row whose
    // hash contributes nothing would pass it unseen. With the inserted row's
    // real PostgreSQL row hash (the window check's own expression, read from
    // the migration) folded into the snapshot, the hash halves match exactly;
    // only the count differs, and the closing migration must still stop.
    const text = readFileSync(join(MIGRATIONS, WINDOW_CHECK, 'migration.sql'), 'utf8');
    const block = text.slice(text.indexOf('-- ledger-upgrade-window:begin'), text.indexOf('-- ledger-upgrade-window:end'));
    const { db, ids } = await snapshotted('windowcount');
    try {
      const current = async () => (await db.client.$queryRawUnsafe<{ fingerprint: string }[]>(
        `WITH current_window ("subject", "fingerprint") AS (\n${block}\n)
         SELECT "fingerprint" FROM current_window WHERE "subject" = 'wallet_transactions'`))[0].fingerprint;
      const snapshot = async () => (await db.client.$queryRawUnsafe<{ fingerprint: string }[]>(
        `SELECT "fingerprint" FROM "ledger_upgrade_window" WHERE "subject" = 'wallet_transactions'`))[0].fingerprint;
      const rows = async () => (await db.client.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM "wallet_transactions"'))[0].n;
      const before = await snapshot();
      expect(await current()).toBe(before);
      const [snapshotCount, sumBefore] = before.split('/');
      const rowsBefore = await rows();
      execute(db.url, `INSERT INTO wallet_transactions (id, "walletId", "userId", type, "ledgerType", currency, amount,
          "balanceBefore", "balanceAfter", "referenceType", "referenceId", description, status, "createdAt")
        VALUES ('tx-failed-${ids.tag}', 'w-${ids.alice}', '${ids.alice}', 'COIN_CREDIT', 'CREDIT', 'COINS', 300, 1000, 1000,
          'AGENT_ORDER', '${ids.order}', 'failed purchase', 'FAILED', TIMESTAMP '2026-09-10 11:00:00');`);
      expect(await rows()).toBe(rowsBefore + 1);
      const sumAfter = (await current()).split('/')[1];
      const rowHash = BigInt(sumAfter) - BigInt(sumBefore);
      expect(rowHash).not.toBe(0n);
      await db.client.$executeRawUnsafe(`UPDATE "ledger_upgrade_window" SET "fingerprint" = $1 WHERE "subject" = 'wallet_transactions'`,
        `${snapshotCount}/${sumAfter}`);
      expect((await snapshot()).split('/')[1]).toBe((await current()).split('/')[1]);
      const result = deploy(db.url);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE: 1 legacy financial record\(s\) changed while the release migrations ran: wallet_transactions/);
      expect((await migrationRows(db.client)).find((row) => row.migration_name === WINDOW_CHECK)?.finished ?? false).toBe(false);
      // What the check compared: the same hash sum, one more row.
      const [countSeen, sumSeen] = (await current()).split('/');
      expect(sumSeen).toBe((await snapshot()).split('/')[1]);
      expect(Number(countSeen)).toBe(Number(snapshotCount) + 1);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('the check compares every column master defines on every table it fingerprints', async () => {
    // The window check's own comparison, read from the migration, evaluated
    // after changing one column of one row (rolled back each time). The
    // snapshot migration must fingerprint with exactly the same text.
    const windowBlock = (migration: string) => {
      const text = readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8');
      return text.slice(text.indexOf('-- ledger-upgrade-window:begin'), text.indexOf('-- ledger-upgrade-window:end'));
    };
    const block = windowBlock(WINDOW_CHECK);
    expect(block.length).toBeGreaterThan(100);
    expect(windowBlock(PRE_GATE)).toBe(block);
    const differing = `WITH current_window ("subject", "fingerprint") AS (\n${block}\n)
      SELECT COALESCE(c."subject", s."subject") AS subject FROM current_window c
      FULL OUTER JOIN "ledger_upgrade_window" s ON s."subject" = c."subject"
      WHERE c."fingerprint" IS DISTINCT FROM s."fingerprint"`;
    const tables = ['wallets', 'wallet_transactions', 'withdrawal_holds', 'withdrawals', 'agent_orders',
      'agent_order_settlements', 'agent_reservations', 'gift_transactions', 'game_sessions'];
    const changed = (column: string, type: string, udt: string): string | null => {
      const c = `"${column}"`;
      if (type === 'USER-DEFINED') {
        return `(SELECT e.enumlabel::"${udt}" FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = '${udt}' AND e.enumlabel IS DISTINCT FROM ${c}::text ORDER BY e.enumsortorder LIMIT 1)`;
      }
      if (['integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real'].includes(type)) return `COALESCE(${c}, 0) + 1`;
      if (type === 'boolean') return `NOT COALESCE(${c}, false)`;
      if (['text', 'character varying'].includes(type)) return `COALESCE(${c}, '') || 'x'`;
      if (type.startsWith('timestamp') || type === 'date') return `COALESCE(${c}, TIMESTAMP '2026-01-01') + interval '1 day'`;
      if (type === 'jsonb') return `COALESCE(${c}, '{}'::jsonb) || '{"windowProbe": 1}'::jsonb`;
      if (type === 'json') return `(COALESCE(${c}::jsonb, '{}'::jsonb) || '{"windowProbe": 1}'::jsonb)::json`;
      return null;
    };
    class Probed extends Error { constructor(readonly subjects: string[]) { super('probed'); } }
    const { db } = await snapshotted('windowcolumns');
    try {
      expect(await db.client.$queryRawUnsafe(differing)).toEqual([]);
      const columns = await db.client.$queryRawUnsafe<{ table: string; column: string; type: string; udt: string }[]>(
        `SELECT table_name::text AS "table", column_name::text AS "column", data_type::text AS "type", udt_name::text AS "udt"
         FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
         ORDER BY table_name, ordinal_position`, tables);
      expect(new Set(columns.map((c) => c.table))).toEqual(new Set(tables));
      expect(columns).toHaveLength(121); // every column master defines on these tables
      const missed: string[] = [];
      for (const { table, column, type, udt } of columns) {
        const value = changed(column, type, udt);
        if (!value) { missed.push(`${table}.${column}: no probe for type ${type}`); continue; }
        try {
          await db.client.$transaction(async (tx) => {
            // Only the fingerprint is under test: keys, guards and CHECKs
            // (all restored by the rollback) stay out of the way.
            await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
            const checks = await tx.$queryRawUnsafe<{ name: string }[]>(
              `SELECT conname::text AS name FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, table);
            for (const { name } of checks) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`);
            const updated = await tx.$executeRawUnsafe(
              `UPDATE "${table}" SET "${column}" = ${value} WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`);
            if (updated !== 1) throw new Error(`no ${table} row to change`);
            const rows = await tx.$queryRawUnsafe<{ subject: string }[]>(differing);
            throw new Probed(rows.map((r) => r.subject));
          });
        } catch (error) {
          if (!(error instanceof Probed)) missed.push(`${table}.${column}: ${String((error as Error).message).split('\n').pop()}`);
          else if (error.subjects.length === 0) missed.push(`${table}.${column}: not fingerprinted`);
        }
      }
      expect(missed).toEqual([]);
      expect(await db.client.$queryRawUnsafe(differing)).toEqual([]);
    } finally { await db.client.$disconnect(); }
  }, 300_000);
});

describe('ledger upgrade with a concurrent writer', () => {
  const orphanStatements = (orphan: string): [string, ...unknown[]][] => [
    [`INSERT INTO users (id, email, username, "passwordHash", "displayName", "updatedAt")
      VALUES ($1, $1 || '@m.test', $1, 'x', 'Orphan', now())`, orphan],
    ['INSERT INTO coin_ledger_accounts ("userId", "classifiedAt") VALUES ($1, NULL)', orphan],
  ];

  async function beforeFinalGate(label: string) {
    const db = await scratchDatabase(label);
    expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
    const ids = masterIds();
    execute(db.url, masterEraSeed(ids));
    expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < FINAL_GATE))).status).toBe(0);
    return { db, ids };
  }

  it('final gate: an uncommitted ledger write makes the gate wait; once committed, the gate stops on it', async () => {
    const { db, ids } = await beforeFinalGate('racecommit');
    try {
      const orphan = `orphan-${ids.tag}`;
      const writer = await openWriter(db.url, orphanStatements(orphan)); // a ledger account without a wallet
      const migration = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(migration.hasExited()).toBe(false);
      expect(await writer.commit()).toBe('committed');
      const result = await migration.done;
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('LEDGER INTEGRITY GATE STOPPED THE UPGRADE');
      expect(result.output).toContain(`WALLET_MISSING x1 [${orphan}]`);
      expect((await migrationRows(db.client)).at(-1)).toMatchObject({ migration_name: FINAL_GATE, finished: false });
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('final gate: the same write rolled back lets the gate complete, with no anomaly afterwards', async () => {
    const { db, ids } = await beforeFinalGate('racerollback');
    try {
      const writer = await openWriter(db.url, orphanStatements(`orphan-${ids.tag}`));
      const migration = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(migration.hasExited()).toBe(false);
      expect(await writer.rollback()).toBe('rolled back');
      const result = await migration.done;
      expect(result.status, result.output).toBe(0);
      expect(await anomalies(db.client)).toEqual([]);
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('an old-version wallet credit between migration stages stops the upgrade at the window check', async () => {
    const db = await scratchDatabase('windowwrite');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, masterEraSeed(ids));
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name <= OPENING_JOURNAL))).status).toBe(0);
      // Exactly what the pre-ledger API writes for a Coin credit, after the
      // opening journal has already turned alice's balance into a lot.
      execute(db.url, `
UPDATE wallets SET "coinsBalance" = "coinsBalance" + 500, "updatedAt" = now() WHERE "userId" = '${ids.alice}';
INSERT INTO wallet_transactions (id, "walletId", "userId", type, "ledgerType", currency, amount, "balanceBefore",
    "balanceAfter", "referenceType", "referenceId", description, status, "createdAt")
  VALUES ('tx-late-${ids.tag}', 'w-${ids.alice}', '${ids.alice}', 'COIN_CREDIT', 'CREDIT', 'COINS', 500, 1000, 1500,
    'REWARD', 'late-${ids.tag}', 'late credit', 'SUCCEEDED', now());`);
      const result = deploy(db.url);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(WINDOW_CHECK);
      expect(result.output).toContain('LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE');
      expect(result.output).toContain(`wallet:${ids.alice}`);
      expect(result.output).toContain('wallet_transactions');
      // The ledger's own definitions cannot see this write (alice's account
      // is unclassified): only the window check catches it.
      expect(await anomalies(db.client)).toEqual([]);
      expect(await relationExists(db.client, 'ledger_upgrade_window')).toBe(true);
      expect((await migrationRows(db.client)).at(-1)).toMatchObject({ migration_name: WINDOW_CHECK, finished: false });
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('a legacy catalog edit committed between migration stages stops the upgrade at the window check', async () => {
    const db = await scratchDatabase('windowgame');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name <= PRE_GATE))).status).toBe(0);
      // Trivia's rules are fixed by the release, so no rules hash check sees
      // this edit; only the window check does.
      execute(db.url, `UPDATE game_definitions SET configuration = '{"correctMultiplier": 4}'::jsonb WHERE key = 'trivia';`);
      const result = deploy(db.url);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(WINDOW_CHECK);
      expect(result.output).toContain('LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE');
      expect(result.output).toContain('game:trivia');
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('a missing upgrade-window snapshot stops the upgrade with an explanation, never a silent pass', async () => {
    const db = await scratchDatabase('windowmissing');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < WINDOW_CHECK))).status).toBe(0);
      execute(db.url, 'DROP TABLE ledger_upgrade_window;');
      const result = deploy(db.url);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(WINDOW_CHECK);
      expect(result.output).toContain('the snapshot recorded by 20260917900000_ledger_preupgrade_gate is missing');
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('pre-upgrade gate: a noncompliant writer that deadlocks with its locks leaves no partial change', async () => {
    const db = await scratchDatabase('deadlock');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, masterRuntimeCatalogSql());
      execute(db.url, masterEraSeed(ids));
      const before = await legacyFingerprint(db.client);
      // The writer holds a catalog row; the gate takes the wallets and then
      // waits for the catalog; the writer then needs a wallet: a cycle.
      const writer = stepWriter(db.url);
      expect(await writer.run(`UPDATE game_definitions SET "updatedAt" = "updatedAt" WHERE key = 'dice'`)).toBe('ok');
      const migration = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      const walletStep = writer.run('UPDATE wallets SET "coinsBalance" = "coinsBalance" WHERE "userId" = $1', ids.alice);
      const [step, result] = await Promise.all([walletStep, migration.done.then(async (done) => {
        await writer.end(true);
        return done;
      })]);
      const writerOutcome = await writer.end(true);
      const migrationDeadlocked = result.status !== 0;
      // PostgreSQL aborts exactly one side, and that side changed nothing.
      expect([migrationDeadlocked, step.startsWith('error')].filter(Boolean)).toHaveLength(1);
      if (migrationDeadlocked) {
        expect(result.output).toMatch(/deadlock detected|lock timeout/);
        expect(result.output).toContain(PRE_GATE);
        expect(writerOutcome).toBe('committed');
        for (const table of ['ledger_upgrade_window', 'game_rules', 'coin_provenance']) {
          expect(await relationExists(db.client, table), table).toBe(false);
        }
        expect(await legacyFingerprint(db.client)).toEqual(before);
        // Once the writer is gone, the documented recovery completes the upgrade.
        expect(prismaCli(db.url, ['migrate', 'resolve', '--rolled-back', PRE_GATE, '--schema', SCHEMA]).status).toBe(0);
        const retried = deploy(db.url);
        expect(retried.status, retried.output).toBe(0);
      } else {
        expect(step).toMatch(/deadlock detected/);
        expect(writerOutcome).toMatch(/aborted/);
        expect(result.status, result.output).toBe(0);
      }
      expect(await anomalies(db.client)).toEqual([]);
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('pre-upgrade gate: gives up after its lock timeout instead of waiting forever, and changes nothing', async () => {
    const db = await scratchDatabase('locktimeout');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      execute(db.url, masterEraSeed(masterIds()));
      const writer = stepWriter(db.url);
      expect(await writer.run(`UPDATE game_definitions SET "updatedAt" = "updatedAt" WHERE key = 'dice'`)).toBe('ok');
      const started = Date.now();
      const migration = deployInBackground(db.url);
      const result = await Promise.race([migration.done,
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 60_000); })]);
      await writer.end(false);
      expect(result, 'the gate was still waiting after 60s').not.toBeNull();
      expect(result!.status).not.toBe(0);
      expect(result!.output).toMatch(/lock timeout/);
      expect(result!.output).toContain(PRE_GATE);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(await relationExists(db.client, 'ledger_upgrade_window')).toBe(false);
      expect(await relationExists(db.client, 'game_rules')).toBe(false);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('the pre-upgrade gate and the window check lock every table the window fingerprints', async () => {
    const WINDOW_TABLES = ['wallets', 'wallet_transactions', 'withdrawal_holds', 'withdrawals', 'game_definitions',
      'agent_orders', 'agent_order_settlements', 'agent_reservations', 'gift_transactions', 'game_sessions'];
    for (const migration of [PRE_GATE, WINDOW_CHECK]) {
      const db = await scratchDatabase('windowlocks');
      try {
        const before = deploy(db.url, migrationSubset(ALL.filter((name) => name < migration)));
        expect(before.status, before.output).toBe(0);
        // A missed writer on every table at once; each is released only once
        // the migration waits for exactly its table.
        const writers = new Map<string, ReturnType<typeof stepWriter>>();
        for (const table of WINDOW_TABLES) {
          const writer = stepWriter(db.url);
          expect(await writer.run(`LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`)).toBe('ok');
          writers.set(table, writer);
        }
        const deployment = deployInBackground(db.url, migrationSubset(ALL.filter((name) => name <= migration)));
        const waitedFor: string[] = [];
        while (!deployment.hasExited()) {
          // Read in the scratch database itself, where its relation OIDs resolve.
          const waiting = await db.client.$queryRawUnsafe<{ relation: string }[]>(
            `SELECT l.relation::regclass::text AS relation FROM pg_locks l
             WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND l.locktype = 'relation' AND NOT l.granted`);
          const table = waiting.map((w) => w.relation.replaceAll('"', '')).find((name) => writers.has(name));
          if (table) {
            waitedFor.push(table);
            await writers.get(table)!.end(false);
            writers.delete(table);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        for (const writer of writers.values()) await writer.end(false);
        const result = await deployment.done;
        expect(result.status, result.output).toBe(0);
        expect([...waitedFor].sort(), migration).toEqual([...WINDOW_TABLES].sort());
      } finally { await db.client.$disconnect(); }
    }
  }, 300_000);

  it('every later locking migration also gives up after its lock timeout, and stays unapplied', async () => {
    // Each migration of the release that locks tables, and one table it
    // locks. A missed writer holding ROW EXCLUSIVE on it (as any INSERT,
    // UPDATE or DELETE does) conflicts with the migration's lock.
    const locking: [migration: string, table: string][] = [
      ['20260918020000_casino_foundation_seed', 'game_definitions'],
      ['20260922020000_g0_rules_hash_verification', 'game_rules'],
      ['20260922060000_g0_rules_hash_verification_fix', 'game_rules'],
      [FINAL_GATE, 'wallets'],
      [AUTHORIZATION, 'economic_operations'],
      [WINDOW_CHECK, 'wallets'],
    ];
    const prepared: { migration: string; table: string; db: Awaited<ReturnType<typeof scratchDatabase>> }[] = [];
    try {
      // Migrate each database up to the migration under test, one at a time.
      for (const [index, [migration, table]] of locking.entries()) {
        const db = await scratchDatabase(`locktimeout${index}`);
        prepared.push({ migration, table, db });
        const before = deploy(db.url, migrationSubset(ALL.filter((name) => name < migration)));
        expect(before.status, before.output).toBe(0);
      }
      // Then run all of them against their writers at once.
      const outcomes = await Promise.all(prepared.map(async ({ migration, table, db }) => {
        const writer = stepWriter(db.url);
        expect(await writer.run(`LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`)).toBe('ok');
        const started = Date.now();
        const deployment = deployInBackground(db.url, migrationSubset(ALL.filter((name) => name <= migration)));
        const result = await Promise.race([deployment.done,
          new Promise<null>((resolve) => { setTimeout(() => resolve(null), 60_000); })]);
        const elapsed = Date.now() - started;
        await writer.end(false);
        if (!result) await deployment.done;
        const row = (await migrationRows(db.client)).find((r) => r.migration_name === migration);
        return { migration, result, elapsed, finished: row?.finished ?? false };
      }));
      for (const { migration, result, elapsed, finished } of outcomes) {
        expect(result, `${migration} was still waiting after 60s`).not.toBeNull();
        expect(result!.status, migration).not.toBe(0);
        expect(result!.output, migration).toMatch(/lock timeout/);
        expect(result!.output, migration).toContain(migration);
        expect(elapsed, migration).toBeLessThan(60_000);
        expect(finished, `${migration} must stay unapplied`).toBe(false);
      }
    } finally {
      for (const { db } of prepared) await db.client.$disconnect();
    }
  }, 600_000);

  it('pre-upgrade gate: an uncommitted rules edit makes it wait; once committed, it stops before any schema change', async () => {
    const db = await scratchDatabase('rulesrace');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      const edited = JSON.stringify(MASTER_RUNTIME_CATALOG[0].configuration).replace('"probability":0.1}', '"probability":0.11}');
      const writer = await openWriter(db.url, [
        ['UPDATE game_definitions SET configuration = $1::jsonb WHERE key = \'lucky_spin\'', edited]]);
      // The read-only preflight cannot see an uncommitted edit; the gate
      // itself waits for it.
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
      const migration = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(migration.hasExited()).toBe(false);
      expect(await writer.commit()).toBe('committed');
      const result = await migration.done;
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(PRE_GATE);
      expect(result.output).toContain('GAME_RULES_CHANGED x1 [lucky_spin]');
      expect(await relationExists(db.client, 'game_rules')).toBe(false);
      expect(await relationExists(db.client, 'ledger_upgrade_window')).toBe(false);
      expect((await runLedgerUpgradePreflight(db.client)).anomalies.map((a) => a.category)).toEqual(['GAME_RULES_CHANGED']);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('pre-upgrade gate: the same edit rolled back lets the upgrade complete with the verified hashes', async () => {
    const db = await scratchDatabase('rulesrollback');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterRuntimeCatalogSql());
      const edited = JSON.stringify(MASTER_RUNTIME_CATALOG[0].configuration).replace('"probability":0.1}', '"probability":0.11}');
      const writer = await openWriter(db.url, [
        ['UPDATE game_definitions SET configuration = $1::jsonb WHERE key = \'lucky_spin\'', edited]]);
      const migration = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(migration.hasExited()).toBe(false);
      expect(await writer.rollback()).toBe('rolled back');
      const result = await migration.done;
      expect(result.status, result.output).toBe(0);
      expect((await legacyRules(db.client)).lucky_spin.hash).toBe(RULES_HASH_LITERALS.lucky_spin);
    } finally { await db.client.$disconnect(); }
  }, 300_000);
  /** The migration rows started but not finished: the one that is running. */
  async function runningMigrations(client: PrismaClient): Promise<string[]> {
    const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
    return rows.map((row) => row.migration_name);
  }

  // Each catalog migration locks the catalog and the rules itself, so a
  // write that began after the pre-upgrade gate is waited for, not read
  // around. The writer holds only game_rules: the trigger that
  // 20260922020000 creates on game_definitions would make it wait anyway.
  for (const migration of ['20260918020000_casino_foundation_seed', '20260922020000_g0_rules_hash_verification',
    '20260922060000_g0_rules_hash_verification_fix']) {
    it(`${migration} waits for an uncommitted rules write`, async () => {
      const db = await scratchDatabase('catalock');
      try {
        expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
        execute(db.url, masterRuntimeCatalogSql());
        expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < migration))).status).toBe(0);
        const writer = await openWriter(db.url, [['LOCK TABLE game_rules IN ROW EXCLUSIVE MODE']]);
        const background = deployInBackground(db.url);
        await waitForLockWaitIn(db.name);
        expect(await runningMigrations(db.client)).toEqual([migration]);
        expect(await writer.rollback()).toBe('rolled back');
        const result = await background.done;
        expect(result.status, result.output).toBe(0);
      } finally { await db.client.$disconnect(); }
    }, 300_000);
  }

  it('authorization rules: an uncommitted coin lot write makes the migration wait instead of checking around it', async () => {
    const db = await scratchDatabase('authlock');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      execute(db.url, masterEraSeed(masterIds()));
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < AUTHORIZATION))).status).toBe(0);
      const writer = await openWriter(db.url, [['UPDATE "coin_provenance" SET "updatedAt" = "updatedAt" WHERE false']]);
      const background = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(await runningMigrations(db.client)).toEqual([AUTHORIZATION]);
      expect(await writer.rollback()).toBe('rolled back');
      const result = await background.done;
      expect(result.status, result.output).toBe(0);
    } finally { await db.client.$disconnect(); }
  }, 300_000);

  it('window check: an uncommitted legacy wallet write makes it wait; once committed, it stops the upgrade', async () => {
    const db = await scratchDatabase('windowrace');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, masterEraSeed(ids));
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name < WINDOW_CHECK))).status).toBe(0);
      // What the pre-ledger API writes when it records a Game Points reward.
      const writer = await openWriter(db.url, [[
        `INSERT INTO wallet_transactions (id, "walletId", "userId", type, "ledgerType", currency, amount, "balanceBefore",
           "balanceAfter", "referenceType", "referenceId", description, status, "createdAt")
         VALUES ($1, 'w-' || $2, $2, 'GAME_POINT_CREDIT', 'CREDIT', 'GAME_POINTS', 5, 0, 5, 'REWARD', $1, 'late reward', 'SUCCEEDED', now())`,
        `tx-late-${ids.tag}`, ids.alice]]);
      const background = deployInBackground(db.url);
      await waitForLockWaitIn(db.name);
      expect(await runningMigrations(db.client)).toEqual([WINDOW_CHECK]);
      expect(await writer.commit()).toBe('committed');
      const result = await background.done;
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('LEDGER UPGRADE WINDOW CHECK STOPPED THE UPGRADE');
      expect(result.output).toContain('wallet_transactions');
    } finally { await db.client.$disconnect(); }
  }, 300_000);
});
