/**
 * Read-only ledger upgrade preflight.
 *
 * Works on both supported schemas:
 *   - PRE_UPGRADE (master): evaluates the ledger-integrity definitions over a
 *     projection of what the upgrade migrations will create from this data,
 *     plus the legacy game catalog preconditions, i.e. exactly what the
 *     pre-upgrade gate (20260917900000) will decide.
 *   - UPGRADED: evaluates the same definitions over the ledger tables, i.e.
 *     exactly what the final gate (20260924000000) and the runtime invariant
 *     checker (I15) decide, and reports whether the installed database
 *     function has drifted from these definitions.
 * Any other (intermediate) schema is reported as UNSUPPORTED; it is never
 * guessed at. Everything runs in one READ ONLY, REPEATABLE READ transaction,
 * so the report is a consistent snapshot and nothing can be written.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  LEDGER_FUNCTION_BODY, LEDGER_SOURCE_CURRENT, LEDGER_SOURCE_PROJECTED, LEGACY_CATALOG_PRECONDITIONS,
  buildAnomalyQuery, normalizeSql,
} from './ledger-integrity-definitions.js';

type Queryable = Pick<Prisma.TransactionClient, '$queryRawUnsafe'>;

export type LedgerSchemaMode = 'PRE_UPGRADE' | 'UPGRADED' | 'UNSUPPORTED';

export interface LedgerIntegrityAnomaly {
  category: string;
  subjectType: string;
  subjectId: string | null;
  userId: string | null;
  detail: string;
}

export interface LedgerUpgradePreflightReport {
  database: string;
  serverVersion: string;
  mode: LedgerSchemaMode;
  reason: string;
  migrations: { lastApplied: string | null; failed: string[] };
  snapshot: { readOnly: boolean; isolation: string };
  gateFunctionInstalled: boolean;
  definitionDrift: boolean;
  anomalies: LedgerIntegrityAnomaly[];
}

export const ESCALATION_DOC = 'docs/deployment/ledger-upgrade-gate.md';

interface SchemaFacts {
  database: string; server_version: string;
  has_lots: boolean; has_lot_class: boolean; has_accounts: boolean; has_entries: boolean;
  has_operations: boolean; has_reviews: boolean; has_wallets: boolean; has_holds: boolean;
  has_withdrawals: boolean; has_function: boolean; has_migrations: boolean;
}

async function schemaFacts(db: Queryable): Promise<SchemaFacts> {
  const rows = await db.$queryRawUnsafe<SchemaFacts[]>(`
    SELECT current_database() AS database,
           current_setting('server_version') AS server_version,
           to_regclass('coin_provenance') IS NOT NULL AS has_lots,
           EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'coin_provenance'
                     AND column_name = 'lotClass') AS has_lot_class,
           to_regclass('coin_ledger_accounts') IS NOT NULL AS has_accounts,
           to_regclass('coin_lot_entries') IS NOT NULL AS has_entries,
           to_regclass('economic_operations') IS NOT NULL AS has_operations,
           to_regclass('legacy_balance_reviews') IS NOT NULL AS has_reviews,
           to_regclass('wallets') IS NOT NULL AS has_wallets,
           to_regclass('withdrawal_holds') IS NOT NULL AS has_holds,
           to_regclass('withdrawals') IS NOT NULL AS has_withdrawals,
           to_regprocedure('ledger_integrity_anomalies()') IS NOT NULL AS has_function,
           to_regclass('_prisma_migrations') IS NOT NULL AS has_migrations`);
  return rows[0];
}

function classify(facts: SchemaFacts): { mode: LedgerSchemaMode; reason: string } {
  const ledger = [facts.has_lots, facts.has_lot_class, facts.has_accounts, facts.has_entries,
    facts.has_operations, facts.has_reviews];
  if (ledger.every(Boolean) && facts.has_wallets) {
    return { mode: 'UPGRADED', reason: 'the managed ledger tables are present' };
  }
  if (!ledger.some(Boolean) && facts.has_wallets && facts.has_holds && facts.has_withdrawals) {
    return { mode: 'PRE_UPGRADE', reason: 'no ledger table exists yet; evaluating what the upgrade will create from this data' };
  }
  const present = ['coin_provenance', 'coin_provenance.lotClass', 'coin_ledger_accounts', 'coin_lot_entries',
    'economic_operations', 'legacy_balance_reviews'].filter((_, index) => ledger[index]);
  return {
    mode: 'UNSUPPORTED',
    reason: `neither the supported pre-upgrade schema nor the upgraded schema (ledger objects present: ${present.join(', ') || 'none'}; wallets: ${facts.has_wallets}, withdrawal_holds: ${facts.has_holds})`,
  };
}

/** The anomalies under the definitions for `mode`; read-only. */
export async function collectLedgerIntegrityAnomalies(
  db: Queryable, mode: 'PRE_UPGRADE' | 'UPGRADED',
): Promise<LedgerIntegrityAnomaly[]> {
  const query = mode === 'UPGRADED'
    ? buildAnomalyQuery(LEDGER_SOURCE_CURRENT)
    : buildAnomalyQuery(LEDGER_SOURCE_PROJECTED, LEGACY_CATALOG_PRECONDITIONS);
  return db.$queryRawUnsafe<LedgerIntegrityAnomaly[]>(`
    SELECT q.category, q.subject_type AS "subjectType", q.subject_id AS "subjectId",
           q.user_id AS "userId", q.detail
    FROM (${query}) q
    ORDER BY q.category, q.subject_id NULLS FIRST`);
}

async function migrationState(db: Queryable, present: boolean) {
  if (!present) return { lastApplied: null, failed: [] as string[] };
  const rows = await db.$queryRawUnsafe<{ migration_name: string; finished: boolean; rolled_back: boolean }[]>(`
    SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
    FROM _prisma_migrations ORDER BY started_at, migration_name`);
  const applied = rows.filter((row) => row.finished && !row.rolled_back);
  return {
    lastApplied: applied.length ? applied[applied.length - 1].migration_name : null,
    failed: rows.filter((row) => !row.finished && !row.rolled_back).map((row) => row.migration_name),
  };
}

async function installedDefinitionDrifts(db: Queryable): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ body: string }[]>(
    `SELECT prosrc AS body FROM pg_proc WHERE oid = to_regprocedure('ledger_integrity_anomalies()')`);
  return normalizeSql(rows[0]?.body ?? '') !== normalizeSql(LEDGER_FUNCTION_BODY);
}

/** Runs the whole preflight in one READ ONLY, REPEATABLE READ snapshot. */
export async function runLedgerUpgradePreflight(client: PrismaClient): Promise<LedgerUpgradePreflightReport> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [settings] = await tx.$queryRawUnsafe<{ read_only: string; isolation: string }[]>(
      `SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`);
    const snapshot = { readOnly: settings.read_only === 'on', isolation: settings.isolation };
    const facts = await schemaFacts(tx);
    const { mode, reason } = classify(facts);
    const migrations = await migrationState(tx, facts.has_migrations);
    const gateFunctionInstalled = mode === 'UPGRADED' && facts.has_function;
    const definitionDrift = gateFunctionInstalled ? await installedDefinitionDrifts(tx) : false;
    const anomalies = mode === 'UNSUPPORTED' ? [] : await collectLedgerIntegrityAnomalies(tx, mode);
    return {
      database: facts.database, serverVersion: facts.server_version, mode, reason, migrations, snapshot,
      gateFunctionInstalled, definitionDrift, anomalies,
    };
  }, { timeout: 600_000, maxWait: 30_000 });
}

/** 0: evaluated and clean; 1: anomalies found; 2: could not evaluate. */
export function preflightExitCode(report: LedgerUpgradePreflightReport): 0 | 1 | 2 {
  if (report.mode === 'UNSUPPORTED' || report.definitionDrift) return 2;
  return report.anomalies.length ? 1 : 0;
}

/**
 * Removes every credential form a driver message could carry: the whole
 * connection string, any URL-like token, and the user, password and
 * credential-bearing query parameters of the configured URL (raw and
 * percent-decoded).
 */
export function redactSecrets(text: string, databaseUrl?: string): string {
  const secrets = new Set<string>();
  if (databaseUrl) {
    secrets.add(databaseUrl);
    try {
      const url = new URL(databaseUrl);
      for (const value of [url.username, url.password]) {
        if (value) { secrets.add(value); secrets.add(decodeURIComponent(value)); }
      }
      for (const key of ['user', 'password', 'sslpassword', 'sslkey', 'sslcert', 'sslidentity']) {
        const value = url.searchParams.get(key);
        if (value) secrets.add(value);
      }
    } catch {
      // Not parseable as a URL: the literal string is still redacted below.
    }
  }
  let out = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, '[redacted connection string]');
  for (const secret of [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function formatPreflightReport(report: LedgerUpgradePreflightReport, limitPerCategory = 50): string {
  const lines = [
    'Ledger upgrade preflight (read-only)',
    `Database: ${report.database} (PostgreSQL ${report.serverVersion})`,
    `Schema: ${report.mode} - ${report.reason}`,
    `Migrations: last applied ${report.migrations.lastApplied ?? 'none'}; failed: ${report.migrations.failed.join(', ') || 'none'}`,
    `Snapshot: ${report.snapshot.readOnly ? 'read-only' : 'WRITABLE'}, ${report.snapshot.isolation}`,
  ];
  if (report.mode === 'UPGRADED') {
    lines.push(report.gateFunctionInstalled
      ? `Gate definitions installed in the database: ${report.definitionDrift ? 'DIFFER from this release (drift)' : 'identical to this release'}`
      : 'Gate definitions installed in the database: not yet (the final gate migration has not been applied)');
  }
  lines.push('');
  if (report.mode === 'UNSUPPORTED') {
    lines.push('The preflight could not evaluate this database: its schema is not a supported upgrade point.',
      `Escalate before deploying; see ${ESCALATION_DOC}.`);
    return `${lines.join('\n')}\n`;
  }
  if (report.definitionDrift) {
    lines.push('The installed ledger_integrity_anomalies() function differs from this release, so the gate,',
      'the invariant checker and this preflight may not agree. Escalate before deploying; see ' + ESCALATION_DOC + '.', '');
  }
  if (!report.anomalies.length) {
    lines.push('No ledger integrity anomalies found.');
    return `${lines.join('\n')}\n`;
  }
  const byCategory = new Map<string, LedgerIntegrityAnomaly[]>();
  for (const anomaly of report.anomalies) {
    byCategory.set(anomaly.category, [...(byCategory.get(anomaly.category) ?? []), anomaly]);
  }
  lines.push(`${report.anomalies.length} ledger integrity anomal${report.anomalies.length === 1 ? 'y' : 'ies'} in ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}. The upgrade gate stops on every one of them.`, '');
  for (const [category, list] of byCategory) {
    lines.push(`${category} (${list.length})`);
    for (const anomaly of list.slice(0, limitPerCategory)) {
      lines.push(`  - ${anomaly.subjectType} ${anomaly.subjectId ?? 'NULL'} (user ${anomaly.userId ?? 'NULL'}): ${anomaly.detail}`);
    }
    if (list.length > limitPerCategory) lines.push(`  ... ${list.length - limitPerCategory} more (use --limit or --json)`);
  }
  lines.push('',
    'Do not edit ledger rows ad hoc and never mark a gate migration as applied. Escalate every record',
    `for a separately reviewed, case-specific correction, then re-run this preflight. See ${ESCALATION_DOC}.`);
  return `${lines.join('\n')}\n`;
}
