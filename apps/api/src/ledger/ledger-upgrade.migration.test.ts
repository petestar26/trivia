// Migration matrix for the ledger upgrade, driven through the real Prisma CLI
// against scratch databases on the same local server:
//   fresh install, replay, populated upgrade from master-era data, a stop at
//   the pre-upgrade gate (nothing changed) and at the final integrity gate
//   (that migration changed nothing), each followed by the documented
//   stop-and-escalate recovery: a reviewed correction, then
//   `prisma migrate resolve --rolled-back <gate>`, then an ordinary redeploy.
// It never marks a gate as applied.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@socialplay/database';
import { runLedgerUpgradePreflight } from '../economy/ledger-upgrade-preflight.js';

const DATABASE_PACKAGE = fileURLToPath(new URL('../../../../packages/database/', import.meta.url));
const PRISMA = join(DATABASE_PACKAGE, 'node_modules/.bin/prisma');
const SCHEMA = join(DATABASE_PACKAGE, 'prisma/schema.prisma');
const MIGRATIONS = join(DATABASE_PACKAGE, 'prisma/migrations');
const PRE_GATE = '20260917900000_ledger_preupgrade_gate';
const FINAL_GATE = '20260924000000_ledger_integrity_gate';
const ALL = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const MASTER = ALL.filter((name) => name < PRE_GATE);

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

async function migrationRows(client: PrismaClient) {
  return client.$queryRawUnsafe<{ migration_name: string; finished: boolean; rolled_back: boolean; steps: number }[]>(
    `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back,
            applied_steps_count AS steps FROM _prisma_migrations ORDER BY started_at, migration_name`);
}

async function relationExists(client: PrismaClient, name: string): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<{ found: boolean }[]>('SELECT to_regclass($1) IS NOT NULL AS found', name);
  return rows[0].found;
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
INSERT INTO countries (id, code, name, "currencyCode", "isActive", "agentPaymentEnabled", "updatedAt")
  VALUES ('${ids.country}', 'Q${ids.tag.slice(0, 1).toUpperCase()}', 'Master era ${ids.tag}', 'USD', true, true, ${t});
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
    admin: id('admin'), country: id('country'), method: id('method'), rate: id('rate'), agent: id('agent'),
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
  expect(ALL[ALL.length - 1]).toBe(FINAL_GATE);
  expect(MASTER.at(-1)).toBe('20260917000000_group_invites_hardening');
});

afterAll(async () => {
  for (const name of created) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  await prisma.$disconnect();
});

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

  it('populated upgrade from master-era data preserves every legacy record and opens the ledger under review', async () => {
    const db = await scratchDatabase('populated');
    try {
      expect(deploy(db.url, migrationSubset(MASTER)).status).toBe(0);
      const ids = masterIds();
      execute(db.url, masterEraSeed(ids));
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
      expect(await anomalies(db.client)).toEqual([]);
      const after = await runLedgerUpgradePreflight(db.client);
      expect({ mode: after.mode, anomalies: after.anomalies.length, drift: after.definitionDrift })
        .toEqual({ mode: 'UPGRADED', anomalies: 0, drift: false });
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

  it('final gate: a malformed upgraded ledger stops the last migration, which changes nothing, and recovers the same way', async () => {
    const db = await scratchDatabase('finalgate');
    try {
      expect(deploy(db.url, migrationSubset(ALL.filter((name) => name !== FINAL_GATE))).status).toBe(0);
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

      // Stand-in for the separately reviewed, case-specific correction.
      execute(db.url, `
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO wallets (id, "userId", "coinsBalance", "gamePointsBalance", "updatedAt") VALUES ('w-${u}', '${u}', 0, 0, now());
UPDATE coin_provenance SET state = 'OPEN' WHERE id = '${lot}';
COMMIT;`);
      expect((await runLedgerUpgradePreflight(db.client)).anomalies).toEqual([]);
      const resolved = prismaCli(db.url, ['migrate', 'resolve', '--rolled-back', FINAL_GATE, '--schema', SCHEMA]);
      expect(resolved.status, resolved.output).toBe(0);
      const retried = deploy(db.url);
      expect(retried.status, retried.output).toBe(0);
      expect(await anomalies(db.client)).toEqual([]);
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
});
