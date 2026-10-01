/**
 * Owner-run setup of the ledger's runtime trust boundary, after every deploy
 * that applied migrations (docs/deployment/ledger-upgrade-gate.md, "Database
 * roles and the approval key"):
 *
 *   pnpm --filter api ledger:runtime-access [--json]
 *   node apps/api/dist/scripts/ledger-runtime-access.js [--json]
 *
 * Reads only the environment (no .env file):
 *   LEDGER_OWNER_DATABASE_URL    the owner (migration) credential; never the
 *                                API's or the worker's DATABASE_URL
 *   LEDGER_RUNTIME_ROLE          the role the API and the worker connect as
 *   LEDGER_APPROVAL_SIGNING_KEY  the API's approval signing key (hex)
 *   LEDGER_APPROVAL_KEY_ID       its ID (default "primary")
 * In one transaction it first refuses, before changing anything, a runtime
 * role that is, or can become, a role no runtime role may act as (a
 * superuser, among others), or that is, can become or inherits the
 * privileges of a role no runtime role may hold the privileges of (the owner
 * of the database, of the schema or of anything in it, among others), and
 * any denied privilege held by a role it can become or inherits from, or by
 * PUBLIC, which the setup does not change. A role counts as one it can
 * become when a SET ROLE to it would succeed (PostgreSQL 16 and later: every
 * membership on the way grants SET; before 16, any membership) or when it
 * holds ADMIN OPTION on it that PostgreSQL lets it use, and so could grant
 * it to itself; one it inherits from, when it holds its privileges without
 * SET ROLE (ledger_role_reach, which ledger_apply_runtime_grants shares). The
 * owner credential must be the owner, or a role that both inherits its
 * privileges (the setup never uses SET ROLE) and can become it or a
 * superuser (else the grants function refuses it as a role outside the
 * owner's trust that can create where the owner resolves names). It then installs
 * the approval key (idempotent; a different secret under an installed key ID
 * is refused), applies ledger_apply_runtime_grants() (which also removes, or
 * refuses, any way for the runtime role to create objects in the schemas
 * where code running as the owner resolves names, and refuses while any
 * other role outside the owner's trust can create there or owns objects
 * there; the runtime role also loses UPDATE on every key other tables follow
 * by cascade) and verifies the result, again for the runtime role and every
 * role it can become or inherits from. A refusal rolls the transaction back.
 * It never prints a connection string, a password or the key.
 * Exit codes: 0 applied and verified, 1 refused or not verified, 2 could not run.
 */
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { redactSecrets } from '../economy/ledger-upgrade-preflight.js';

const USAGE = 'usage: ledger-runtime-access [--json]  (reads LEDGER_OWNER_DATABASE_URL, LEDGER_RUNTIME_ROLE, '
  + 'LEDGER_APPROVAL_SIGNING_KEY and LEDGER_APPROVAL_KEY_ID from the environment)';

/** What the runtime role must never be able to do, and what it needs. */
const DENIED: [table: string, privilege: string][] = [
  ['house_publication_requests', 'INSERT'], ['house_publication_requests', 'UPDATE'], ['house_publication_requests', 'DELETE'],
  ['house_publication_receipts', 'INSERT'], ['house_publication_receipts', 'UPDATE'], ['house_publication_receipts', 'DELETE'],
  ['house_round_beacon_pins', 'INSERT'], ['house_round_beacon_pins', 'UPDATE'], ['house_round_beacon_pins', 'DELETE'],
  ['house_round_randomness', 'SELECT'], ['house_round_randomness', 'INSERT'],
  ['house_round_randomness', 'UPDATE'], ['house_round_randomness', 'DELETE'],
  ['house_ticket_resolutions', 'INSERT'], ['house_ticket_resolutions', 'UPDATE'], ['house_ticket_resolutions', 'DELETE'],
  ['house_capital_accounts', 'INSERT'], ['house_capital_accounts', 'UPDATE'], ['house_capital_accounts', 'DELETE'],
  ['house_capital_fundings', 'INSERT'], ['house_capital_fundings', 'UPDATE'], ['house_capital_fundings', 'DELETE'],
  ['house_round_reservations', 'INSERT'], ['house_round_reservations', 'UPDATE'], ['house_round_reservations', 'DELETE'],
  ['admin_adjustment_approvals', 'INSERT'], ['admin_adjustment_approvals', 'UPDATE'], ['admin_adjustment_approvals', 'DELETE'],
  ['ledger_approval_assertions', 'INSERT'], ['ledger_approval_assertions', 'UPDATE'], ['ledger_approval_assertions', 'DELETE'],
  ['ledger_approval_keys', 'SELECT'], ['ledger_approval_keys', 'INSERT'], ['ledger_approval_keys', 'UPDATE'],
  ['ledger_approval_keys', 'DELETE'],
  ['economic_operations', 'UPDATE'], ['economic_operations', 'DELETE'],
  ['coin_lot_entries', 'UPDATE'], ['coin_lot_entries', 'DELETE'],
  ['wallet_transactions', 'UPDATE'], ['wallet_transactions', 'DELETE'],
  ['legacy_balance_reviews', 'UPDATE'], ['legacy_balance_reviews', 'DELETE'],
  ['scheduled_stake_holds', 'DELETE'],
  ['wallets', 'DELETE'], ['coin_provenance', 'DELETE'], ['users', 'DELETE'],
  ['game_rules', 'INSERT'], ['game_rules', 'UPDATE'], ['game_rules', 'DELETE'],
  ['_prisma_migrations', 'INSERT'], ['_prisma_migrations', 'UPDATE'], ['_prisma_migrations', 'DELETE'],
  ['agent_order_settlements', 'UPDATE'], ['agent_order_settlements', 'DELETE'],
  ['game_sessions', 'UPDATE'], ['game_sessions', 'DELETE'], ['coin_ledger_accounts', 'DELETE'],
];
/** Denied on every table of the schema: TRUNCATE skips row triggers, and a
 * trigger of one's own runs as whoever writes the table, the owner included. */
const DENIED_ON_EVERY_TABLE = ['TRUNCATE', 'TRIGGER'];
const DENIED_USER_COLUMNS = ['role', 'status'];
/** The owner's procedures: a key installed or retired, an assertion recorded, these grants applied. */
const DENIED_FUNCTIONS = [
  'ledger_apply_runtime_grants_pre_publication(text)',
  'ledger_apply_runtime_grants_seed_only(text)', 'ledger_install_approval_key(text,bytea)', 'ledger_retire_approval_key(text)', 'ledger_apply_runtime_grants(text)',
  'ledger_record_assertion(text,text,text,text,text,numeric,text,jsonb,text,text,text)',
  'house_record_capital_funding(text,bigint,text)', 'house_reserve_round_loss(text,bigint,jsonb,integer)',
  'house_discharge_ticket(text,text,text,integer,integer,text)', 'house_spin_outcome(text)',
];
const REQUIRED: [table: string, privilege: string][] = [
  ['users', 'INSERT'], ['economic_operations', 'INSERT'], ['coin_lot_entries', 'INSERT'],
  ['wallet_transactions', 'INSERT'], ['game_sessions', 'INSERT'], ['admin_adjustment_approvals', 'SELECT'],
];
/** Columns the API updates on tables whose key other tables follow by cascade (so UPDATE is column-level there). */
const REQUIRED_UPDATE_COLUMNS: [table: string, column: string][] = [
  ['wallets', 'coinsBalance'], ['wallets', 'gamePointsBalance'], ['agent_orders', 'status'], ['coin_provenance', 'state'],
];

interface Report {
  applied: boolean;
  runtimeRole: string;
  approvalKeyId: string;
  failures: string[];
}

class NotVerified extends Error {
  constructor(readonly failures: string[]) { super('runtime access not verified'); }
}

/** A refusal ledger_apply_runtime_grants raises (SQLSTATE 42501); its transaction changed nothing. */
function grantsRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } } | null;
  if (e?.code !== 'P2010' || e.meta?.code !== '42501') return null;
  return String(e.meta.message ?? '').replace(/^ERROR:\s*/, '');
}

type Tx = Prisma.TransactionClient;

/** A role whose privileges the runtime role holds or can come to hold. */
interface Reached {
  name: string;
  /** The runtime role itself, or a role it can become (SET ROLE, or a grant to itself under ADMIN OPTION). */
  assumable: boolean;
  /** For a role it cannot become, the role that inherits its privileges: the runtime role itself, or a role it can become. */
  via: string | null;
  superuser: boolean;
}

/**
 * Every role the runtime role is, can become or inherits the privileges of,
 * itself first, as the database's ledger_role_reach answers (migration
 * 20260924070000, shared with ledger_apply_runtime_grants and invariant I3).
 * It can become a role when SET ROLE to it succeeds (pg_has_role SET from
 * PostgreSQL 16, MEMBER before it), or when it can grant the role to itself:
 * a membership in it WITH ADMIN OPTION held by itself or by a role it
 * inherits from, never a superuser role; and so on from every role it can
 * become. It inherits a role's privileges when every membership on the way
 * grants INHERIT (pg_has_role USAGE, which has_*_privilege follow).
 * Attributes (superuser, row-security exemption, CREATEROLE, replication)
 * are never inherited: they apply only after SET ROLE. A superuser, refused
 * in its own right, can become every role: nothing is followed from it.
 */
async function reachableRoles(tx: Tx, role: string): Promise<Reached[]> {
  return tx.$queryRaw<Reached[]>`
    SELECT r.rolname::text AS "name", x.assumable AS "assumable", v.rolname::text AS "via", r.rolsuper AS "superuser"
    FROM "ledger_role_reach"((SELECT m.oid FROM pg_roles m WHERE m.rolname = ${role})) x
    JOIN pg_roles r ON r.oid = x.role_id LEFT JOIN pg_roles v ON v.oid = x.via_id
    ORDER BY r.rolname::text <> ${role}, r.rolname`;
}

/** A role whose grants the denied-privilege checks read, and how the runtime role holds what it holds. */
interface Subject { name: string; how: string }

/**
 * The runtime role, every role it can become and every role it inherits from
 * in its own right, and how it holds what each holds. What a role it can
 * become inherits, has_*_privilege already reports for that role. A
 * superuser it only inherits from is left out: has_*_privilege reports every
 * privilege for a superuser, whose bypass is not inherited; the grants such a
 * role holds explicitly, the runtime role inherits, and the verification of
 * the runtime role itself reports them.
 */
function subjectsOf(role: string, reached: Reached[]): Subject[] {
  return reached.filter((r) => r.assumable || (r.via === role && !r.superuser)).map((r) => ({
    name: r.name,
    how: r.name === role ? '' : r.assumable ? ` as ${r.name}, a role it can become`
      : ` through ${r.name}, a role whose privileges it inherits`,
  }));
}

/**
 * Roles the runtime role must neither be nor be able to become: each can
 * act beyond any grant (a superuser, a role exempt from row security, one
 * that can make itself a member of the tables' owner, or copy every row by
 * replication), attributes that apply only to the current role. And roles
 * whose privileges it must not hold, whether it can become them or inherits
 * from them: those that reach the server's files, or change the ledger's
 * objects whatever their grants say (the owner of the database, of the
 * schema, of the tables or of anything else in the schema).
 */
async function unsafeRoles(tx: Tx, role: string, reached: Reached[]): Promise<string[]> {
  const rows = await tx.$queryRaw<{ name: string; reasons: string[] }[]>`
    WITH owned AS (
      SELECT c.relowner AS owner, 'relation ' || c.oid::regclass::text AS what
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL SELECT p.proowner, 'function ' || p.oid::regprocedure::text
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      UNION ALL SELECT o.oprowner, 'operator ' || o.oid::regoperator::text
      FROM pg_operator o WHERE o.oprnamespace = 'public'::regnamespace
      UNION ALL SELECT t.typowner, 'type ' || t.oid::regtype::text
      FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typrelid = 0 AND t.typcategory <> 'A'),
    tables_owner AS (SELECT c.relowner AS oid FROM pg_class c WHERE c.oid = to_regclass('economic_operations')),
    reached AS (
      SELECT r.name, r.assumable, r.k
      FROM unnest(${reached.map((r) => r.name)}::text[], ${reached.map((r) => r.assumable)}::boolean[])
        WITH ORDINALITY AS r(name, assumable, k)),
    checked AS (
      SELECT m.rolname::text AS name, r.k, array_remove(ARRAY[
        CASE WHEN r.assumable AND m.rolsuper THEN 'a superuser' END,
        CASE WHEN r.assumable AND m.rolbypassrls THEN 'exempt from row security' END,
        CASE WHEN r.assumable AND m.rolcreaterole THEN 'allowed to create roles (before PostgreSQL 16, to grant itself any role '
          || 'but a superuser, the tables'' owner included)' END,
        CASE WHEN r.assumable AND m.rolreplication
          THEN 'allowed to replicate, and so to copy every row, the signing key included' END,
        CASE WHEN m.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
          THEN 'allowed to run programs or read or write files on the database server' END,
        CASE WHEN m.oid = (SELECT d.datdba FROM pg_database d WHERE d.datname = current_database())
          THEN 'the owner of database ' || current_database() END,
        CASE WHEN m.oid = (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = 'public')
          THEN 'the owner of schema public' END,
        CASE WHEN m.oid IN (SELECT oid FROM tables_owner) THEN 'the owner of the ledger tables' END,
        (SELECT 'the owner of ' || min(o.what) || CASE WHEN count(*) > 1 THEN ' and ' || (count(*) - 1) || ' more' ELSE '' END
                  || ' in schema public'
         FROM owned o WHERE o.owner = m.oid AND m.oid NOT IN (SELECT oid FROM tables_owner))
      ], NULL) AS reasons
      FROM reached r JOIN pg_roles m ON m.rolname = r.name)
    SELECT name, reasons FROM checked WHERE cardinality(reasons) > 0 ORDER BY k`;
  const how = new Map(reached.map((r) => [r.name, r]));
  return rows.flatMap(({ name, reasons }) => reasons.map((reason) => {
    const r = how.get(name)!;
    if (name === role) return `${role} is ${reason}`;
    if (r.assumable) return `${role} can become ${name}, which is ${reason}`;
    if (r.via === role) return `${role} inherits the privileges of ${name}, which is ${reason}`;
    return `${role} can become ${r.via}, which inherits the privileges of ${name}; ${name} is ${reason}`;
  }));
}

/**
 * Every denied privilege `holders` hold, as the runtime role would hold it
 * through them (as a role it can become, by inheritance or through PUBLIC):
 * table grants and column grants alike (has_table_privilege does not see a
 * grant on some columns only, such as SELECT on ledger_approval_keys.secret),
 * user role and status, the owner's procedures, keys other tables follow by
 * cascade and, with `schemaCreate`, CREATE on the schema.
 */
async function deniedPrivileges(tx: Tx, role: string, holders: Subject[], schemaCreate: boolean): Promise<string[]> {
  const subjects = holders.map(({ name }) => name);
  const how = new Map(holders.map(({ name, how: held }) => [name, held]));
  /** Each denial found: who holds it, what it is, and its failure given how the runtime role holds it. */
  const found: { subject: string; what: string; failure: (via: string) => string }[] = [];
  const tables = await tx.$queryRaw<{ subject: string; privilege: string; table: string; whole: boolean; columns: string[] }[]>`
    WITH denied AS (
      SELECT to_regclass(d.tbl) AS rel, d.privilege, d.n
      FROM unnest(${DENIED.map(([table]) => table)}::text[], ${DENIED.map(([, privilege]) => privilege)}::text[])
        WITH ORDINALITY AS d(tbl, privilege, n)
      UNION ALL
      SELECT c.oid, p.privilege, ${DENIED.length} + p.n
      FROM pg_class c CROSS JOIN unnest(${DENIED_ON_EVERY_TABLE}::text[]) WITH ORDINALITY AS p(privilege, n)
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p'))
    SELECT s.subject, d.privilege, c.relname::text AS "table",
           has_table_privilege(s.subject, d.rel, d.privilege) AS "whole",
           CASE WHEN d.privilege IN ('SELECT', 'INSERT', 'UPDATE') THEN ARRAY(
             SELECT a.attname::text FROM pg_attribute a
             WHERE a.attrelid = d.rel AND a.attnum > 0 AND NOT a.attisdropped
               AND has_column_privilege(s.subject, d.rel, a.attnum, d.privilege)
             ORDER BY a.attnum) ELSE ARRAY[]::text[] END AS "columns"
    FROM denied d JOIN pg_class c ON c.oid = d.rel
    CROSS JOIN unnest(${subjects}::text[]) WITH ORDINALITY AS s(subject, k)
    ORDER BY s.k, d.n, c.relname`;
  for (const { subject, privilege, table, whole, columns } of tables) {
    const target = whole ? table : columns.map((column) => `${table}.${column}`).join(', ');
    if (target) found.push({ subject, what: `${privilege} ${target}`, failure: (via) => `${role} still holds ${privilege} on ${target}${via}` });
  }
  const users = await tx.$queryRaw<{ subject: string; column: string }[]>`
    SELECT s.subject, u.col AS "column"
    FROM unnest(${subjects}::text[]) WITH ORDINALITY AS s(subject, k)
    CROSS JOIN unnest(${DENIED_USER_COLUMNS}::text[]) WITH ORDINALITY AS u(col, n)
    WHERE has_column_privilege(s.subject, to_regclass('users'), u.col, 'UPDATE')
    ORDER BY s.k, u.n`;
  for (const { subject, column } of users) {
    found.push({ subject, what: `users.${column}`, failure: (via) => `${role} can still change users.${column}${via}` });
  }
  const holdColumns = await tx.$queryRaw<{ subject: string; column: string }[]>`
    SELECT s.subject, a.attname::text AS "column"
    FROM unnest(${subjects}::text[]) AS s(subject)
    JOIN pg_attribute a ON a.attrelid=to_regclass('public.scheduled_stake_holds')
      AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attname NOT IN ('state','refund_operation_id')
      AND has_column_privilege(s.subject,a.attrelid,a.attnum,'UPDATE')`;
  for (const { subject, column } of holdColumns) {
    found.push({ subject, what: `scheduled_stake_holds.${column}`,
      failure: (via) => `${role} can still change scheduled_stake_holds.${column}${via}` });
  }
  const functions = await tx.$queryRaw<{ subject: string; name: string }[]>`
    SELECT s.subject, p.proname::text AS "name"
    FROM unnest(${subjects}::text[]) WITH ORDINALITY AS s(subject, k)
    CROSS JOIN unnest(${DENIED_FUNCTIONS}::text[]) WITH ORDINALITY AS f(signature, n)
    JOIN pg_proc p ON p.oid = to_regprocedure(f.signature)
    WHERE has_function_privilege(s.subject, p.oid, 'EXECUTE')
    ORDER BY s.k, f.n`;
  for (const { subject, name } of functions) {
    found.push({ subject, what: `run ${name}`, failure: (via) => `${role} can still run ${name}${via}` });
  }
  // The approval functions run as the owner and resolve names in this
  // schema: the runtime role must not be able to create anything there
  // (the grants function removes PUBLIC's CREATE, and refuses when it
  // cannot remove the rest).
  if (schemaCreate) {
    const creators = await tx.$queryRaw<{ subject: string }[]>`
      SELECT s.subject FROM unnest(${subjects}::text[]) WITH ORDINALITY AS s(subject, k)
      WHERE has_schema_privilege(s.subject, 'public', 'CREATE') ORDER BY s.k`;
    for (const { subject } of creators) {
      found.push({ subject, what: 'create', failure: (via) => `${role} can still create objects in schema public${via}` });
    }
  }
  // No key another table follows by cascade: a cascade, and the triggers
  // it fires, run as the owner of the referencing table.
  const cascadeKeys = await tx.$queryRaw<{ key: string; subject: string }[]>`
    SELECT DISTINCT s.k, c.confrelid::regclass::text || '.' || a.attname::text AS "key", s.subject
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
    CROSS JOIN unnest(${subjects}::text[]) WITH ORDINALITY AS s(subject, k)
    WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd')
      AND has_column_privilege(s.subject, c.confrelid, a.attname::text, 'UPDATE')
    ORDER BY s.k, 2`;
  for (const { key, subject } of cascadeKeys) {
    found.push({ subject, what: `cascade ${key}`,
      failure: (via) => `${role} can still change ${key}${via}, a key other tables follow by cascade` });
  }
  // What PUBLIC holds, every role holds: named once, through PUBLIC.
  const byPublic = new Set(found.filter(({ subject }) => subject === 'public').map(({ what }) => what));
  return found.filter(({ subject, what }) => subject === 'public' || !byPublic.has(what))
    .map(({ subject, failure }) => failure(how.get(subject)!));
}

/** The same runtime trust checks as owner-run setup, without installing a key or changing grants. */
export async function verifyRuntimeAccessReadOnly(tx: Tx, role: string): Promise<string[]> {
  const reached = await reachableRoles(tx, role);
  if (reached[0]?.name !== role) return ['runtime role is not installed'];
  const unsafe = await unsafeRoles(tx, role, reached);
  const subjects = subjectsOf(role, reached);
  const held = await deniedPrivileges(tx, role,
    [...subjects, { name: 'public', how: ' through PUBLIC' }], true);
  return [...unsafe, ...held];
}

/**
 * Applies and verifies the runtime access in one transaction as `client`
 * (the owner) and returns what failed; any failure rolls the transaction
 * back, so a refused setup leaves every grant, ACL and key as it found them.
 */
export async function applyRuntimeAccess(client: PrismaClient, role: string, keyId: string, keyHex: string): Promise<string[]> {
  try {
    await client.$transaction(async (tx) => {
      // The owner credential must hold the owner's privileges (USAGE): the
      // setup runs as it and never uses SET ROLE, so a membership in the
      // owner that grants neither INHERIT nor SET (PostgreSQL 16), or SET
      // alone, is no ownership it can use. And it must be inside the owner's
      // trust (it can become the owner or a superuser): one that only
      // inherits the owner's privileges can create where the owner resolves
      // names, and ledger_apply_runtime_grants refuses such a role.
      const [who] = await tx.$queryRaw<{ isOwner: boolean; member: boolean; current: boolean; sameRole: boolean }[]>`
        SELECT pg_has_role(current_user, c."relowner", 'USAGE') AS "isOwner",
               pg_has_role(current_user, c."relowner", 'MEMBER') AS "member",
               to_regprocedure('ledger_role_reach(oid)') IS NOT NULL AS "current", current_user = ${role} AS "sameRole"
        FROM pg_class c WHERE c."oid" = to_regclass('economic_operations')`;
      if (!who) throw new NotVerified(['the ledger schema is not installed: apply the migrations first']);
      const asOwner = 'connect as the owner, or as a role that inherits its privileges and can become it or a superuser '
        + '(SET ROLE, which PostgreSQL 16\'s default GRANT allows, or ADMIN OPTION it can use)';
      if (!who.isOwner) {
        throw new NotVerified([who.member
          ? 'LEDGER_OWNER_DATABASE_URL connects as a member of the owner of the ledger tables that does not inherit its '
            + `privileges (a NOINHERIT role, or from PostgreSQL 16 a membership without INHERIT), and the setup never uses SET ROLE: ${asOwner}`
          : 'LEDGER_OWNER_DATABASE_URL does not connect as the owner of the ledger tables']);
      }
      if (!who.current) throw new NotVerified(['the ledger schema is not up to date (ledger_role_reach is missing): apply the migrations first']);
      const [trust] = await tx.$queryRaw<{ trusted: boolean }[]>`
        SELECT "ledger_role_is_trusted"((SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user), c."relowner") AS "trusted"
        FROM pg_class c WHERE c."oid" = to_regclass('economic_operations')`;
      if (!trust?.trusted) {
        throw new NotVerified(['LEDGER_OWNER_DATABASE_URL connects as a role that inherits the privileges of the owner of the ledger '
          + 'tables but can become neither it nor a superuser: ledger_apply_runtime_grants refuses such a role, which can create '
          + `where code running as the owner resolves names; ${asOwner}`]);
      }
      if (who.sameRole) throw new NotVerified(['LEDGER_RUNTIME_ROLE is the owner credential\'s own role']);

      // Before anything changes. The setup changes only the runtime role's
      // own grants (and PUBLIC's CREATE on the schema): what it could reach
      // as another role, by inheritance or through PUBLIC, it would keep.
      const reached = await reachableRoles(tx, role);
      if (reached[0]?.name !== role) throw new Error(`role "${role}" does not exist`);
      const unsafe = await unsafeRoles(tx, role, reached);
      if (unsafe.length > 0) throw new NotVerified(unsafe);
      const subjects = subjectsOf(role, reached);
      const held = await deniedPrivileges(tx, role,
        [...subjects.filter(({ name }) => name !== role), { name: 'public', how: ' through PUBLIC' }], false);
      if (held.length > 0) throw new NotVerified(held);

      await tx.$executeRaw`SELECT "ledger_install_approval_key"(${keyId}, decode(${keyHex}, 'hex'))`;
      await tx.$executeRaw`SELECT "ledger_apply_runtime_grants"(${role})`;

      // Verified for the runtime role and for every role it can become or inherits from.
      const failures = await deniedPrivileges(tx, role, subjects, true);
      for (const [table, column] of REQUIRED_UPDATE_COLUMNS) {
        const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
          SELECT has_column_privilege(${role}, to_regclass(${table}), ${column}, 'UPDATE') AS "granted"`;
        if (!row?.granted) failures.push(`${role} cannot update ${table}.${column}, which the API needs`);
      }
      for (const [table, privilege] of REQUIRED) {
        const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
          SELECT has_table_privilege(${role}, to_regclass(${table}), ${privilege}) AS "granted"`;
        if (!row?.granted) failures.push(`${role} lacks ${privilege} on ${table}, which the API needs`);
      }
      const [key] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "ledger_approval_keys" WHERE "keyId" = ${keyId} AND "retiredAt" IS NULL) AS "active"`;
      if (!key?.active) failures.push(`approval key ${keyId} is retired: install a new key ID`);
      if (failures.length > 0) throw new NotVerified(failures);
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (error instanceof NotVerified) return error.failures;
    const refusal = grantsRefusal(error);
    if (refusal) return [refusal];
    throw error;
  }
  return [];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown) {
    process.stderr.write(`unknown argument ${unknown}\n${USAGE}\n`);
    return 2;
  }
  const json = args.includes('--json');
  const ownerUrl = process.env.LEDGER_OWNER_DATABASE_URL;
  const role = process.env.LEDGER_RUNTIME_ROLE;
  const keyHex = process.env.LEDGER_APPROVAL_SIGNING_KEY;
  const keyId = process.env.LEDGER_APPROVAL_KEY_ID || 'primary';
  const missing = [
    !ownerUrl && 'LEDGER_OWNER_DATABASE_URL',
    !role && 'LEDGER_RUNTIME_ROLE',
    !keyHex && 'LEDGER_APPROVAL_SIGNING_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    process.stderr.write(`Ledger runtime access could not run: ${missing.join(', ')} not set in the environment.\n`);
    return 2;
  }
  if (!/^(?:[0-9a-fA-F]{2}){32,64}$/.test(keyHex!)) {
    process.stderr.write('Ledger runtime access could not run: LEDGER_APPROVAL_SIGNING_KEY must be 32-64 bytes as hex (64-128 characters).\n');
    return 2;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    process.stderr.write('Ledger runtime access could not run: LEDGER_APPROVAL_KEY_ID must be 1-64 characters of [A-Za-z0-9._-].\n');
    return 2;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === ownerUrl) {
    process.stderr.write('Ledger runtime access refused: DATABASE_URL is the owner credential. '
      + 'The API and the worker must connect as the runtime role.\n');
    return 1;
  }

  const client = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  const redact = (text: string) => redactSecrets(text, ownerUrl).split(keyHex!).join('[redacted]');
  try {
    const failures = await applyRuntimeAccess(client, role!, keyId, keyHex!.toLowerCase());
    const report: Report = { applied: failures.length === 0, runtimeRole: role!, approvalKeyId: keyId, failures };
    if (json) {
      process.stdout.write(`${redact(JSON.stringify(report, null, 2))}\n`);
    } else if (report.applied) {
      process.stdout.write(redact(`Ledger runtime access: approval key ${keyId} installed; ${role} holds data access only `
        + '(no approvals, assertions, signing key, migration history, user role or status, and no rewriting '
        + 'of financial history). Verified.\n'));
    } else {
      process.stdout.write(redact(`Ledger runtime access NOT verified; nothing was changed:\n${
        failures.map((failure) => `  ${failure}\n`).join('')}`));
    }
    return report.applied ? 0 : 1;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
    process.stderr.write(`Ledger runtime access could not run; nothing was changed: ${redact(message)}\n`);
    return 2;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

/** True when this file is the program being run (by tsx or node), not a module a test imports. */
function invokedAsScript(): boolean {
  try {
    const file = realpathSync(fileURLToPath(import.meta.url));
    // esbuild also bundles these helpers into the predeploy identity CLI.
    // The entry path alone would then match and accidentally run owner setup.
    return basename(file) === 'ledger-runtime-access.js' || basename(file) === 'ledger-runtime-access.ts'
      ? realpathSync(process.argv[1] ?? '') === file : false;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    const key = process.env.LEDGER_APPROVAL_SIGNING_KEY;
    let message = redactSecrets(String((error as Error)?.message ?? error), process.env.LEDGER_OWNER_DATABASE_URL);
    if (key) message = message.split(key).join('[redacted]');
    process.stderr.write(`Ledger runtime access could not run; nothing was changed: ${message.slice(0, 500)}\n`);
    process.exitCode = 2;
  });
}
