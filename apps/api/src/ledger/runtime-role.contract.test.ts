// The documented runtime role: what the API and the worker connect as, with
// exactly the grants ledger_apply_runtime_grants() gives it (migrations run
// as the owner). This file proves, with every trigger enabled:
//   1. the role holds only data access: no approvals, assertions, signing
//      key, migration history, user role or status, and no rewriting or
//      deleting of financial history;
//   2. it cannot forge an approval: writing the rows is refused, the signed
//      procedures refuse any signature not made with the API's key, a
//      replayed signature is refused, and a fabricated mint rolls back
//      without changing the operation, journal, lots, reviews or wallet;
//   3. amounts reach the database as NUMERIC and are never rounded;
//   4. it cannot switch off, replace or shadow a guard;
//   5. the API and the worker work under it;
// and that the owner-run setup script (ledger:runtime-access) installs the
// key and the grants, verifies them, refuses a shared or wrong credential
// and prints no secret; (6.) that the runtime role cannot plant a
// function or operator that runs with the owner's privileges inside the
// approval functions; (7.) that neither can any other role, such as a
// retired one, whose objects the setup then refuses; (8.) that the older
// SECURITY DEFINER guards a wager, a catalog update or a rules or
// allocation write reaches never run such an object either; (9.) that
// the setup refuses any role outside the owner's trust that could still
// create where functions running as the owner resolve names; (10.) that
// no cascade the runtime role can start runs such an object as the owner,
// even one created after the setup ran; and (11.) that the setup checks
// every role the runtime role can become, even by SET ROLE alone, and every
// column grant, and that a refusal changes no grant, ACL, membership or key.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@socialplay/database';
import { creditCoins } from '../economy/coin-ledger-service.js';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import { applyRuntimeAccess } from '../scripts/ledger-runtime-access.js';
import { playGame } from '../games/game-play.js';
import { executeTestAdjustment, makeApprovers } from '../test/adjustment-fixtures.js';
import type { Approvers } from '../test/adjustment-fixtures.js';
import { RolledBack, inRolledBackTransaction, purchasedFixture, uid } from '../test/ledger-integrity-fixtures.js';
import type { PurchasedFixture, Statement } from '../test/ledger-integrity-fixtures.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSX = join(API_ROOT, 'node_modules/.bin/tsx');

const role = `playqube_runtime_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const password = randomUUID();
let runtimeUrl: string;
let app: PrismaClient;
let f: PurchasedFixture;
let approvers: Approvers;
let setup: ReturnType<typeof runtimeAccess>;

/** Runs the owner-run setup script (ledger:runtime-access) with the given environment overrides. */
function runtimeAccess(overrides: Record<string, string | undefined>, args: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, LEDGER_OWNER_DATABASE_URL: process.env.DATABASE_URL,
    LEDGER_RUNTIME_ROLE: role, ...overrides };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const run = spawnSync(TSX, [join(API_ROOT, 'src/scripts/ledger-runtime-access.ts'), ...args],
    { cwd: API_ROOT, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000 });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

beforeAll(async () => {
  await bootstrapLedgerTestGates();
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  await prisma.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await prisma.$executeRawUnsafe(`GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO "${role}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role; url.password = password;
  // The harness process opens its own pool; allow for a loaded machine.
  url.searchParams.set('connect_timeout', '30');
  runtimeUrl = url.toString();
  // The documented, owner-run setup: install the approval key, apply and
  // verify the runtime grants.
  setup = runtimeAccess({ DATABASE_URL: runtimeUrl });
  app = new PrismaClient({ datasourceUrl: runtimeUrl, log: [] });
  f = await purchasedFixture(1000);
  approvers = await makeApprovers('runtime-role');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
  await prisma.$disconnect();
});

const oneLine = (error: unknown) =>
  String((error as Error).message).split('\n').map((line) => line.trim()).filter(Boolean).join(' ');

/** Runs statements as the runtime role, checks every deferred constraint and always rolls back. */
async function asApp(statements: Statement[]): Promise<string> {
  try {
    await app.$transaction(async (tx) => {
      for (const [sql, ...params] of statements) await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      throw new RolledBack('accepts');
    }, { timeout: 120_000 });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as string;
    return `rejects: ${oneLine(error)}`;
  }
  return 'committed';
}

/** Tries to COMMIT statements as the runtime role, leaving deferred checks to the commit. */
async function commitAsApp(statements: Statement[]): Promise<string> {
  try {
    await app.$transaction(statements.map(([sql, ...params]) => app.$executeRawUnsafe(sql, ...params)));
    return 'committed';
  } catch (error) {
    return `rejects: ${oneLine(error)}`;
  }
}

/** Everything a forged mint could touch for `userId`, read as the owner. */
async function ledgerFingerprint(userId: string): Promise<Record<string, string>> {
  const [row] = await prisma.$queryRawUnsafe<Record<string, string>[]>(`
    SELECT
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(o::text, ',' ORDER BY o."id")), '') FROM "economic_operations" o WHERE o."userId" = $1) AS operations,
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(e::text, ',' ORDER BY e."id")), '') FROM "coin_lot_entries" e WHERE e."userId" = $1) AS journal,
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(p::text, ',' ORDER BY p."id")), '') FROM "coin_provenance" p WHERE p."userId" = $1) AS lots,
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(r::text, ',' ORDER BY r."id")), '') FROM "legacy_balance_reviews" r WHERE r."userId" = $1) AS reviews,
      (SELECT w::text FROM "wallets" w WHERE w."userId" = $1) AS wallet,
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, ',' ORDER BY t."id")), '') FROM "wallet_transactions" t WHERE t."userId" = $1) AS "walletTransactions",
      (SELECT count(*) || ':' || COALESCE(md5(string_agg(a::text, ',' ORDER BY a."id")), '') FROM "admin_adjustment_approvals" a WHERE a."userId" = $1) AS approvals`,
  userId);
  const [{ present }] = await prisma.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regclass('ledger_approval_assertions') IS NOT NULL AS present`);
  if (present) {
    const [assertions] = await prisma.$queryRawUnsafe<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM "ledger_approval_assertions" WHERE "userId" = $1', userId);
    row.assertions = assertions.count;
  }
  return row;
}

/** What the API signs: the database's payload for these terms, under the API's key. */
async function apiSignature(client: PrismaClient, terms: { subjectType: string; subjectId: string; action: string;
  actorId: string; userId: string; amount: string; caseId: string; evidence: unknown }, key = process.env.LEDGER_APPROVAL_SIGNING_KEY!) {
  const nonce = randomBytes(24).toString('hex');
  const [{ payload }] = await client.$queryRawUnsafe<{ payload: string }[]>(
    `SELECT "ledger_approval_payload"($1, $2, $3, $4, $5, $6::numeric, $7, "ledger_evidence_digest"($8::jsonb), $9) AS payload`,
    terms.subjectType, terms.subjectId, terms.action, terms.actorId, terms.userId, terms.amount, terms.caseId,
    JSON.stringify(terms.evidence), nonce);
  return { keyId: process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary', nonce,
    signature: createHmac('sha256', Buffer.from(key, 'hex')).update(payload, 'utf8').digest('hex') };
}

const evidenceFor = (caseId: string) => ({ caseId, rationale: 'Documented historical balance correction',
  supportingEvidence: ['case-evidence-runtime'] });

/** A complete ADMIN_ADJUST credit as ordinary SQL, including a fabricated
 * two-administrator approval naming real, active SUPER_ADMINs. */
function fabricatedCredit(userId: string, amount: number, first: string, second: string,
  opts: { approval?: boolean } = {}) {
  const approval = uid('rr-approval'); const op = uid('rr-op'); const wtx = uid('rr-wtx'); const lot = uid('rr-lot');
  const review = uid('rr-review'); const caseId = uid('rr-case'); const evidence = JSON.stringify(evidenceFor(caseId));
  const statements: Statement[] = [];
  if (opts.approval ?? true) {
    statements.push(
      [`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy")
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, approval, userId, amount, caseId, evidence, first],
      [`UPDATE "admin_adjustment_approvals" SET "status" = 'FIRST_APPROVED', "firstApproverId" = $2, "firstApprovedAt" = now()
        WHERE "id" = $1`, approval, first]);
  }
  statements.push(
    [`INSERT INTO "wallet_transactions" ("id","walletId","userId","type","ledgerType","currency","amount","balanceBefore",
        "balanceAfter","referenceType","referenceId","description","status","createdAt")
      SELECT $1, w."id", w."userId", 'COIN_CREDIT', 'CREDIT', 'COINS', $2, w."coinsBalance", w."coinsBalance" + $2,
        'ADMIN', $3, 'Coin adjustment', 'SUCCEEDED', now() FROM "wallets" w WHERE w."userId" = $4`, wtx, amount, caseId, userId],
    ['UPDATE "wallets" SET "coinsBalance" = "coinsBalance" + $2, "updatedAt" = now() WHERE "userId" = $1', userId, amount],
    [`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy","snapshot")
      VALUES ($1,'ADMIN_ADJUST',$2,'ADMIN_ADJUSTMENT',$3,ARRAY[$4],$5,
        jsonb_build_object('evidence', $6::jsonb, 'approvalId', $7::text, 'amount', $8::int))`,
      op, userId, caseId, wtx, second, evidence, approval, amount],
    [`INSERT INTO "coin_provenance" ("id","userId","walletTransactionId","amount","provenanceType","restrictionStatus",
        "originalSource","lotClass","state","availableAmount","reservedAmount","requirementAmount","progressAmount",
        "mintedAt","availableAt","sourceOperationId","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,'ADMIN_ADJUSTMENT','RESTRICTED','ADMIN_ADJUSTMENT','UNCLASSIFIED','OPEN',0,0,0,0,
        now(),now(),$5,now(),now())`, lot, userId, wtx, amount, op],
    [`INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","evidence","status","createdAt")
      VALUES ($1,$2,$3,$4,jsonb_build_object('sourceOperationId', $5::text),'OPEN',now())`, review, userId, lot, amount, op],
    ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', lot, review],
    [`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
      VALUES ($1,$2,$3,0,'MINT',$4)`, op, lot, userId, amount]);
  if (opts.approval ?? true) {
    statements.push([`UPDATE "admin_adjustment_approvals" SET "status" = 'EXECUTED', "secondApproverId" = $2,
      "secondApprovedAt" = now(), "operationId" = $3, "walletTransactionId" = $4, "executedAt" = now() WHERE "id" = $1`,
    approval, second, op, wtx]);
  }
  return { approval, op, caseId, statements };
}

/** Invariant I3's findings when the runtime role itself runs the check. */
async function i3AsApp(): Promise<string[]> {
  try {
    await app.$transaction(async (tx) => {
      const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
      throw new RolledBack(run.violations.find((v) => v.invariant.startsWith('I3'))?.sample ?? []);
    }, { timeout: 120_000 });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as string[];
    throw error;
  }
  return [];
}

interface OperatorPlant { op: '=' | '<>'; type: string }

/**
 * A role that once could create objects in public (PostgreSQL 14 and earlier
 * grant that to PUBLIC by default) and has since been retired: it no longer
 * logs in or creates anything, and it is unrelated to the runtime role. It
 * left behind an exact-type public.to_jsonb(integer) and the given exact-type
 * operators, each of which PostgreSQL prefers to the polymorphic built-in
 * (to_jsonb(anyelement), anyenum = anyenum) wherever public is on the search
 * path, whatever the order. Each plant returns the genuine result, records
 * whom it ran as (in a table, seen once its transaction commits) and counts
 * every run under privileges other than the session's own in a sequence,
 * which no rollback undoes.
 */
async function retiredRoleWithPlants(operators: OperatorPlant[]) {
  const t = randomUUID().replaceAll('-', '').slice(0, 10);
  const retired = `playqube_retired_${t}`;
  const log = `rr_retired_log_${t}`;
  const elevated = `rr_retired_elevated_${t}`;
  const record = (via: string) => `
    INSERT INTO public."${log}" VALUES ('${via}', current_user, session_user);
    IF current_user OPERATOR(pg_catalog.<>) session_user THEN
      PERFORM pg_catalog.nextval('public."${elevated}"');
    END IF;`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${retired}" LOGIN NOSUPERUSER`);
  await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${retired}"`);
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL ROLE "${retired}"`),
    prisma.$executeRawUnsafe(`CREATE TABLE public."${log}" ("via" text NOT NULL, "ranAs" text NOT NULL, "sessionUser" text NOT NULL)`),
    prisma.$executeRawUnsafe(`GRANT INSERT ON public."${log}" TO PUBLIC`),
    prisma.$executeRawUnsafe(`CREATE SEQUENCE public."${elevated}"`),
    prisma.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE public."${elevated}" TO PUBLIC`),
    prisma.$executeRawUnsafe(`CREATE FUNCTION public.to_jsonb(integer) RETURNS jsonb LANGUAGE plpgsql AS $f$
      BEGIN ${record('to_jsonb(integer)')}
        RETURN pg_catalog.to_jsonb($1);
      END $f$`),
    ...operators.flatMap(({ op, type }, i) => [
      prisma.$executeRawUnsafe(`CREATE FUNCTION public."rr_retired_op_${i}_${t}"(${type}, ${type}) RETURNS boolean
        LANGUAGE plpgsql AS $f$
        BEGIN ${record(`${op} on ${type.replaceAll('"', '')}`)}
          RETURN $1::text OPERATOR(pg_catalog.${op}) $2::text;
        END $f$`),
      prisma.$executeRawUnsafe(`CREATE OPERATOR public.${op} (LEFTARG = ${type}, RIGHTARG = ${type},
        FUNCTION = public."rr_retired_op_${i}_${t}")`),
    ]),
  ]);
  // Retired: it can no longer log in or create anything; what it owns stays.
  await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${retired}"`);
  await prisma.$executeRawUnsafe(`ALTER ROLE "${retired}" NOLOGIN`);
  return {
    retired,
    runs: () => prisma.$queryRawUnsafe<{ via: string; ranAs: string; sessionUser: string }[]>(
      `SELECT "via", "ranAs", "sessionUser" FROM public."${log}"`),
    /** Runs under privileges other than the session's own, committed or not. */
    elevatedRuns: async () => {
      const [row] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT (CASE WHEN is_called THEN last_value ELSE 0 END)::int AS n FROM public."${elevated}"`);
      return row.n;
    },
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${retired}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${retired}"`);
    },
  };
}

describe('0. the owner-run setup script', () => {
  const key = () => process.env.LEDGER_APPROVAL_SIGNING_KEY!;

  it('installs the approval key, applies and verifies the runtime grants, and prints no secret', () => {
    expect(setup.status, setup.output).toBe(0);
    expect(setup.output).toMatch(/holds data access only .*Verified/s);
    expect(setup.output).not.toContain(key());
    expect(setup.output).not.toContain(password);
    const again = runtimeAccess({ DATABASE_URL: runtimeUrl }, ['--json']);
    expect(again.status, again.output).toBe(0);
    expect(JSON.parse(again.output)).toEqual({ applied: true, runtimeRole: role,
      approvalKeyId: process.env.LEDGER_APPROVAL_KEY_ID, failures: [] });
  });

  it('refuses when the API would still connect as the owner, or when the "owner" credential is the runtime role', () => {
    const shared = runtimeAccess({ DATABASE_URL: process.env.DATABASE_URL });
    expect(shared.status).toBe(1);
    expect(shared.output).toMatch(/DATABASE_URL is the owner credential/);
    const notOwner = runtimeAccess({ DATABASE_URL: undefined, LEDGER_OWNER_DATABASE_URL: runtimeUrl });
    expect(notOwner.status).toBe(1);
    expect(notOwner.output).toMatch(/does not connect as the owner of the ledger tables/);
    expect(notOwner.output).not.toContain(password);
  });

  it('refuses another secret under an installed key ID, changes nothing, and never prints either key', async () => {
    const other = randomBytes(32).toString('hex');
    const before = await prisma.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM "ledger_approval_keys"');
    const refused = runtimeAccess({ DATABASE_URL: runtimeUrl, LEDGER_APPROVAL_SIGNING_KEY: other });
    expect(refused.status).toBe(2);
    expect(refused.output).toMatch(/already installed with a different secret.*nothing was changed|nothing was changed.*already installed with a different secret/s);
    expect(refused.output).not.toContain(other);
    expect(refused.output).not.toContain(key());
    expect(await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "ledger_approval_keys"')).toEqual(before);
    const missing = runtimeAccess({ LEDGER_APPROVAL_SIGNING_KEY: undefined });
    expect(missing.status).toBe(2);
    expect(missing.output).toMatch(/LEDGER_APPROVAL_SIGNING_KEY not set/);
  });

  it('refuses a retired key ID: it verifies, it does not just apply', async () => {
    const retiredId = `retired-${randomUUID().slice(0, 8)}`;
    await prisma.$executeRawUnsafe('SELECT "ledger_install_approval_key"($1, decode($2, \'hex\'))', retiredId, key());
    await prisma.$executeRawUnsafe('SELECT "ledger_retire_approval_key"($1)', retiredId);
    const refused = runtimeAccess({ DATABASE_URL: runtimeUrl, LEDGER_APPROVAL_KEY_ID: retiredId }, ['--json']);
    expect(refused.status, refused.output).toBe(1);
    expect(JSON.parse(refused.output)).toMatchObject({ applied: false, failures: [`approval key ${retiredId} is retired: install a new key ID`] });
    expect(refused.output).not.toContain(key());
  });
});

describe('1. the documented runtime role holds data access only', () => {
  it('is an ordinary role: no superuser, no RLS bypass, owns nothing', async () => {
    const [facts] = await app.$queryRawUnsafe<{ superuser: boolean; bypass: boolean; owned: number; replication: string }[]>(`
      SELECT r."rolsuper" AS superuser, r."rolbypassrls" AS bypass,
             (SELECT count(*)::int FROM pg_class c WHERE c."relowner" = r."oid") AS owned,
             current_setting('session_replication_role') AS replication
      FROM pg_roles r WHERE r."rolname" = current_user`);
    expect(facts).toEqual({ superuser: false, bypass: false, owned: 0, replication: 'origin' });
  });

  it('cannot write approvals, assertions, the signing key, migration history, user roles or status, or rewrite history', async () => {
    const denied = /rejects: .*(permission denied|only the database owner)/;
    for (const sql of [
      `INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy")
         VALUES ('x', 'u', 1, 'c', '{}', 'a')`,
      'UPDATE "admin_adjustment_approvals" SET "closeReason" = \'x\' WHERE false',
      'DELETE FROM "admin_adjustment_approvals" WHERE false',
      `INSERT INTO "ledger_approval_assertions" ("subjectType","subjectId","action","actorId","userId","amount","caseId",
         "evidenceDigest","nonce","keyId","signature") VALUES ('ADMIN_ADJUSTMENT','s','REQUEST','a','u',1,'c','d',
         repeat('n', 40),'k','s')`,
      'SELECT * FROM "ledger_approval_keys"',
      'UPDATE "ledger_approval_keys" SET "retiredAt" = now()',
      'INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at","applied_steps_count") VALUES (\'x\',\'x\',\'x\',now(),0)',
      'UPDATE "_prisma_migrations" SET "finished_at" = now() WHERE false',
      'DELETE FROM "_prisma_migrations" WHERE false',
      'UPDATE "users" SET "role" = \'SUPER_ADMIN\' WHERE false',
      'UPDATE "users" SET "status" = \'ACTIVE\' WHERE false',
      `INSERT INTO "users" ("id","email","username","passwordHash","displayName","role","updatedAt")
         VALUES ('x','x@x.test','x','x','x','SUPER_ADMIN',now())`,
      `INSERT INTO "users" ("id","email","username","passwordHash","displayName","role","updatedAt")
         VALUES ('y','y@x.test','y','x','y','ADMIN',now())`,
      'DELETE FROM "users" WHERE false',
      'UPDATE "economic_operations" SET "createdBy" = "createdBy" WHERE false',
      'DELETE FROM "economic_operations" WHERE false',
      'UPDATE "coin_lot_entries" SET "availableDelta" = "availableDelta" WHERE false',
      'DELETE FROM "coin_lot_entries" WHERE false',
      'UPDATE "wallet_transactions" SET "amount" = "amount" WHERE false',
      'DELETE FROM "wallet_transactions" WHERE false',
      'UPDATE "agent_order_settlements" SET "coinAmount" = "coinAmount" WHERE false',
      'UPDATE "game_sessions" SET "betAmount" = "betAmount" WHERE false',
      'DELETE FROM "wallets" WHERE false',
      'DELETE FROM "coin_provenance" WHERE false',
      'DELETE FROM "coin_ledger_accounts" WHERE false',
      'UPDATE "legacy_balance_reviews" SET "status" = "status" WHERE false',
      'DELETE FROM "legacy_balance_reviews" WHERE false',
      'UPDATE "game_rules" SET "rulesHash" = "rulesHash" WHERE false',
      'SELECT "ledger_install_approval_key"(\'k\', decode(repeat(\'00\', 32), \'hex\'))',
      'SELECT "ledger_retire_approval_key"(\'k\')',
      'SELECT "ledger_apply_runtime_grants"(current_user)',
      `SELECT "ledger_record_assertion"('ADMIN_ADJUSTMENT','s','REQUEST','a','u',1,'c','{}'::jsonb,'k',repeat('n', 40),'s')`,
    ]) {
      expect(await asApp([[sql]]), sql).toMatch(denied);
    }
    // What the API and the preflight do need stays available.
    expect(await asApp([['SELECT count(*) FROM "_prisma_migrations"'], ['UPDATE "users" SET "displayName" = "displayName" WHERE false'],
      ['SELECT count(*) FROM "ledger_approval_assertions"'], ['SELECT "ledger_lock_economy_for_invariant_check"()']])).toBe('accepts');
  });

  it('the users trigger refuses a role or status change even where a grant would allow it, and re-applying the grants resets them', async () => {
    const [target] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "users" ("id","email","username","passwordHash","displayName","updatedAt")
       VALUES ($1, $1 || '@runtime.test', $1, 'x', 'x', now()) RETURNING "id"`, `rr-user-${randomUUID().slice(0, 8)}`);
    await prisma.$executeRawUnsafe(`GRANT UPDATE ("role", "status") ON "users" TO "${role}"`);
    // Privileges the grants function never gives, which only its reset removes.
    await prisma.$executeRawUnsafe(`GRANT TRUNCATE ON "wallets" TO "${role}"`);
    await prisma.$executeRawUnsafe(`GRANT TRIGGER ON "economic_operations" TO "${role}"`);
    try {
      for (const sql of [`UPDATE "users" SET "role" = 'SUPER_ADMIN' WHERE "id" = $1`,
        `UPDATE "users" SET "status" = 'SUSPENDED' WHERE "id" = $1`]) {
        expect(await asApp([[sql, target.id]]), sql).toMatch(/rejects: .*only the database owner changes a user's role or status/);
      }
    } finally {
      await prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
    }
    const [after] = await prisma.$queryRawUnsafe<{ role: boolean; status: boolean; display: boolean }[]>(
      `SELECT has_column_privilege($1, 'users', 'role', 'UPDATE') AS role,
              has_column_privilege($1, 'users', 'status', 'UPDATE') AS status,
              has_column_privilege($1, 'users', 'displayName', 'UPDATE') AS display`, role);
    expect(after).toEqual({ role: false, status: false, display: true });
    const [extra] = await prisma.$queryRawUnsafe<{ truncate: boolean; trigger: boolean }[]>(
      `SELECT has_table_privilege($1, 'wallets', 'TRUNCATE') AS truncate,
              has_table_privilege($1, 'economic_operations', 'TRIGGER') AS trigger`, role);
    expect(extra).toEqual({ truncate: false, trigger: false });
    await prisma.$executeRawUnsafe('DELETE FROM "users" WHERE "id" = $1', target.id);
  });

  it('the grants function refuses a superuser as the runtime role', async () => {
    const [superuser] = await prisma.$queryRawUnsafe<{ name: string }[]>(
      'SELECT rolname::text AS name FROM pg_roles WHERE rolsuper ORDER BY rolname LIMIT 1');
    await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', superuser.name))
      .rejects.toThrow(/must be neither a superuser nor exempt from row security/);
  });

  it('the grants function refuses a role that owns part of the schema', async () => {
    const owning = `playqube_owning_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const table = `rr_owned_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${owning}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE "${table}" ("x" int)`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" OWNER TO "${owning}"`);
      await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', owning))
        .rejects.toThrow(/must neither own nor be a member of the owner/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${owning}"`);
    }
  });

  it('the invariant check lock holds every economy table in SHARE mode for the caller\'s transaction', async () => {
    const tables = ['wallets', 'wallet_transactions', 'coin_provenance', 'coin_lot_entries', 'economic_operations',
      'coin_ledger_accounts', 'legacy_balance_reviews', 'withdrawal_holds', 'country_jurisdictions',
      'country_casino_policies', 'game_sessions'];
    const blocked: string[] = [];
    await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT "ledger_lock_economy_for_invariant_check"()');
      for (const table of tables) {
        try {
          await prisma.$transaction(async (writer) => {
            await writer.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
            await writer.$executeRawUnsafe(`LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`);
          });
        } catch (error) {
          if (/lock timeout/.test(String((error as Error).message))) blocked.push(table);
        }
      }
    }, { timeout: 60_000 });
    expect(blocked).toEqual(tables);
  });

  it('cannot switch off, drop or replace any guard', async () => {
    for (const sql of [
      'SET session_replication_role = replica',
      'SET LOCAL session_replication_role = replica',
      'ALTER TABLE "economic_operations" DISABLE TRIGGER ALL',
      'ALTER TABLE "coin_lot_entries" DISABLE TRIGGER "operation_authorization_guard"',
      'ALTER TABLE "admin_adjustment_approvals" DISABLE TRIGGER "admin_adjustment_approval_lifecycle_guard"',
      'DROP TRIGGER "authorized_operation_guard" ON "economic_operations"',
      'ALTER TABLE "admin_adjustment_approvals" DROP CONSTRAINT "admin_adjustment_approvals_independent_chk"',
      `CREATE OR REPLACE FUNCTION "admin_adjustment_violation"(operation_id TEXT, check_approvers_active BOOLEAN)
         RETURNS TEXT LANGUAGE sql AS $$ SELECT NULL::text $$`,
      `CREATE OR REPLACE FUNCTION "ledger_approval_signature_valid"(key_id TEXT, payload TEXT, signature TEXT, fresh BOOLEAN)
         RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT true $$`,
      `CREATE OR REPLACE FUNCTION "operation_authorization_guard"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      'ALTER FUNCTION "admin_adjustment_violation"(text, boolean) RESET search_path',
      'CREATE TRIGGER "bypass" BEFORE INSERT ON "economic_operations" FOR EACH ROW EXECUTE FUNCTION "operation_authorization_guard"()',
    ]) {
      expect(await asApp([[sql]]), sql).toMatch(/rejects: .*(permission denied|must be owner)/);
    }
  });
});

describe('2. the runtime role cannot forge an approval', () => {
  it('a fabricated approval naming two real, active SUPER_ADMINs rolls back and changes nothing', async () => {
    const before = await ledgerFingerprint(f.buyer.id);
    const fabricated = fabricatedCredit(f.buyer.id, 500, approvers.first.id, approvers.second.id);
    expect(await commitAsApp(fabricated.statements)).toMatch(/rejects: .*permission denied for table admin_adjustment_approvals/);
    // Without the approval rows, the operation, journal, lot, review and
    // wallet writes are each permitted, and the guard refuses them at COMMIT.
    const unapproved = fabricatedCredit(f.buyer.id, 500, approvers.first.id, approvers.second.id, { approval: false });
    expect(await commitAsApp(unapproved.statements)).toMatch(/rejects: .*is not the execution of any adjustment approval/);
    expect(await ledgerFingerprint(f.buyer.id)).toEqual(before);
    expect(await prisma.economicOperation.count({ where: { id: { in: [fabricated.op, unapproved.op] } } })).toBe(0);
  });

  it('the signed procedures refuse any signature not made with the API key', async () => {
    const before = await ledgerFingerprint(f.buyer.id);
    const approvalId = uid('rr-procedure');
    const caseId = uid('rr-case');
    const terms = { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, action: 'REQUEST', actorId: approvers.first.id,
      userId: f.buyer.id, amount: '500', caseId, evidence: evidenceFor(caseId) };
    const call = (signed: { keyId: string; nonce: string; signature: string }) => asApp([[
      'SELECT "ledger_adjustment_request"($1, $2, $3::numeric, $4, $5::jsonb, $6, $7, $8, $9)',
      approvalId, f.buyer.id, '500', caseId, JSON.stringify(evidenceFor(caseId)), approvers.first.id,
      signed.keyId, signed.nonce, signed.signature]]);
    const notSigned = /rejects: .*is not signed by an active approval key/;
    // A random signature, a key the attacker guessed, and an honest key id
    // with the right payload but a key it does not hold.
    expect(await call({ keyId: process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary', nonce: randomBytes(24).toString('hex'),
      signature: randomBytes(32).toString('hex') })).toMatch(notSigned);
    expect(await call(await apiSignature(app, terms, randomBytes(32).toString('hex')))).toMatch(notSigned);
    expect(await call({ ...(await apiSignature(app, terms)), keyId: 'no-such-key' })).toMatch(notSigned);
    // The genuine signature is accepted (only the API can make it).
    expect(await call(await apiSignature(app, terms))).toBe('accepts');
    expect(await ledgerFingerprint(f.buyer.id)).toEqual(before);
  });

  it('a signature binds every term: the same signature with any one term changed is refused', async () => {
    const approvalId = uid('rr-bind'); const caseId = uid('rr-case'); const evidence = evidenceFor(caseId);
    const terms = { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, action: 'REQUEST', actorId: approvers.first.id,
      userId: f.buyer.id, amount: '9', caseId, evidence };
    const request = (signed: { keyId: string; nonce: string; signature: string },
      change: Partial<{ approvalId: string; userId: string; amount: string; evidence: unknown; actorId: string }> = {}) =>
      asApp([['SELECT "ledger_adjustment_request"($1, $2, $3::numeric, $4, $5::jsonb, $6, $7, $8, $9)',
        change.approvalId ?? approvalId, change.userId ?? f.buyer.id, change.amount ?? '9', caseId,
        JSON.stringify(change.evidence ?? evidence), change.actorId ?? approvers.first.id, signed.keyId, signed.nonce, signed.signature]]);
    const notSigned = /rejects: .*is not signed by an active approval key/;
    const signed = await apiSignature(app, terms);
    expect(await request(signed)).toBe('accepts');
    const other = await makeApprovers('runtime-bind');
    for (const [term, change] of [
      ['subject', { approvalId: uid('rr-bind-other') }],
      ['user', { userId: other.first.id }],
      ['amount', { amount: '90' }],
      ['evidence', { evidence: { ...evidence, supportingEvidence: ['another-reference'] } }],
      ['actor', { actorId: approvers.second.id }],
    ] as const) {
      expect(await request(signed, change), term).toMatch(notSigned);
    }
    // The action, the subject type and the nonce are signed too.
    expect(await request(await apiSignature(app, { ...terms, action: 'FIRST_APPROVAL' })), 'action').toMatch(notSigned);
    expect(await request(await apiSignature(app, { ...terms, subjectType: 'LEGACY_REVIEW' })), 'subject type').toMatch(notSigned);
    expect(await request({ ...signed, nonce: randomBytes(24).toString('hex') }), 'nonce').toMatch(notSigned);
  });

  it('a recorded signature cannot be replayed for another approval, action or actor', async () => {
    const executed = await executeTestAdjustment(f.buyer.id, 3, approvers);
    const recorded = await prisma.$queryRawUnsafe<{ action: string; actorId: string; nonce: string; keyId: string; signature: string }[]>(
      'SELECT "action", "actorId", "nonce", "keyId", "signature" FROM "ledger_approval_assertions" WHERE "subjectId" = $1',
      executed.approvalId);
    const request = recorded.find((a) => a.action === 'REQUEST')!;
    const pending = uid('rr-replay');
    const caseId = uid('rr-case');
    // The same signature for a new approval: another payload, and a used nonce.
    expect(await asApp([['SELECT "ledger_adjustment_request"($1, $2, 3::numeric, $3, $4::jsonb, $5, $6, $7, $8)',
      pending, f.buyer.id, caseId, JSON.stringify(evidenceFor(caseId)), request.actorId, request.keyId, request.nonce,
      request.signature]])).toMatch(/rejects: /);
    const legit = await prisma.adminAdjustmentApproval.findFirstOrThrow({ where: { status: 'EXECUTED', id: executed.approvalId } });
    expect(legit.status).toBe('EXECUTED');
    expect(recorded.map((a) => a.action).sort()).toEqual(['FIRST_APPROVAL', 'REQUEST', 'SECOND_APPROVAL']);
  });

  it('a retired key signs nothing new, while what it signed stays valid', async () => {
    const oldKey = randomBytes(32).toString('hex');
    const oldKeyId = `rr-old-${randomUUID().slice(0, 8)}`;
    await prisma.$executeRawUnsafe('SELECT "ledger_install_approval_key"($1, decode($2, \'hex\'))', oldKeyId, oldKey);
    const approvalId = uid('rr-retired'); const caseId = uid('rr-case');
    const requestTerms = { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, action: 'REQUEST', actorId: approvers.first.id,
      userId: f.buyer.id, amount: '4', caseId, evidence: evidenceFor(caseId) };
    const requested = { ...(await apiSignature(app, requestTerms, oldKey)), keyId: oldKeyId };
    expect(await commitAsApp([['SELECT "ledger_adjustment_request"($1, $2, 4::numeric, $3, $4::jsonb, $5, $6, $7, $8)',
      approvalId, f.buyer.id, caseId, JSON.stringify(evidenceFor(caseId)), approvers.first.id,
      requested.keyId, requested.nonce, requested.signature]])).toBe('committed');
    await prisma.$executeRawUnsafe('SELECT "ledger_retire_approval_key"($1)', oldKeyId);
    const first = { ...(await apiSignature(app, { ...requestTerms, action: 'FIRST_APPROVAL', actorId: approvers.second.id }, oldKey)),
      keyId: oldKeyId };
    expect(await asApp([['SELECT "ledger_adjustment_first_approval"($1, $2, $3, $4, $5)', approvalId, approvers.second.id,
      first.keyId, first.nonce, first.signature]])).toMatch(/rejects: .*is not signed by an active approval key/);
    const [recorded] = await prisma.$queryRawUnsafe<{ valid: boolean }[]>(
      'SELECT "ledger_assertion_valid"(a) AS valid FROM "ledger_approval_assertions" a WHERE a."subjectId" = $1', approvalId);
    expect(recorded.valid).toBe(true);
  });

  it('a first approval cannot be replayed after its review was reopened', async () => {
    const opened = await executeTestAdjustment(f.buyer.id, 7, approvers);
    const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: opened.reviewLotId! } });
    const proposal = { decision: 'WITHDRAWABLE', rationale: 'Two administrators verified the source',
      supportingEvidence: ['rr-reopen'], amount: 7, policyId: null, policyVersion: null, requirementAmount: 0 };
    const reviewTerms = { subjectType: 'LEGACY_REVIEW', subjectId: review.id, userId: f.buyer.id, amount: '7', caseId: review.id };
    const first = await apiSignature(app, { ...reviewTerms, action: 'FIRST_APPROVAL', actorId: approvers.first.id, evidence: proposal });
    const approve: Statement = ['SELECT "ledger_review_first_approval"($1, $2, $3::jsonb, $4, $5, $6)', review.id,
      approvers.first.id, JSON.stringify(proposal), first.keyId, first.nonce, first.signature];
    expect(await commitAsApp([approve])).toBe('committed');
    const reason = 'Reviewed amount changed; renew the first approval';
    const reopen = await apiSignature(app, { ...reviewTerms, action: 'REOPEN', actorId: approvers.second.id,
      evidence: { reason, observedAvailableAmount: null } });
    expect(await commitAsApp([['SELECT "ledger_review_reopen"($1, $2, $3, NULL::integer, $4, $5, $6)', review.id,
      approvers.second.id, reason, reopen.keyId, reopen.nonce, reopen.signature]])).toBe('committed');
    // The same signed first approval, replayed: every term matches, but its nonce was used.
    expect(await asApp([approve])).toMatch(/rejects: .*23505.*Key \(nonce\)=/);
    expect((await prisma.legacyBalanceReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('OPEN');
  });

  it('the procedures keep the approval rules even for a correctly signed decision', async () => {
    const outsider = await prisma.user.create({ data: { email: `${uid('rr-out')}@runtime.test`, username: uid('rr-out'),
      passwordHash: 'x', displayName: 'Not an administrator' } });
    const A = approvers.first.id; const B = approvers.second.id;
    const adjustment = async (userId: string, amount: string) => {
      const approvalId = uid('rr-rules'); const caseId = uid('rr-case');
      const terms = { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, userId, amount, caseId, evidence: evidenceFor(caseId) };
      const signed = async (action: string, actorId: string, evidence: unknown = terms.evidence) =>
        apiSignature(app, { ...terms, action, actorId, evidence });
      const request = async (actorId: string): Promise<Statement> => {
        const s = await signed('REQUEST', actorId);
        return ['SELECT "ledger_adjustment_request"($1, $2, $3::numeric, $4, $5::jsonb, $6, $7, $8, $9)', approvalId, userId,
          amount, caseId, JSON.stringify(terms.evidence), actorId, s.keyId, s.nonce, s.signature];
      };
      const firstApproval = async (actorId: string): Promise<Statement> => {
        const s = await signed('FIRST_APPROVAL', actorId);
        return ['SELECT "ledger_adjustment_first_approval"($1, $2, $3, $4, $5)', approvalId, actorId, s.keyId, s.nonce, s.signature];
      };
      const close = async (actorId: string, outcome: 'REJECTED' | 'CANCELLED', reason = 'Closed in a runtime-role test'): Promise<Statement> => {
        const s = await signed(outcome === 'REJECTED' ? 'REJECT' : 'CANCEL', actorId, { evidence: terms.evidence, closeReason: reason });
        return ['SELECT "ledger_adjustment_close"($1, $2, $3, $4, $5, $6, $7)', approvalId, actorId, outcome, reason,
          s.keyId, s.nonce, s.signature];
      };
      return { request, firstApproval, close };
    };
    // An administrator requesting an adjustment of their own Coins, and a
    // request by someone who is not an active SUPER_ADMIN.
    const own = await adjustment(A, '5');
    expect(await asApp([await own.request(A)])).toMatch(/rejects: .*cannot request an adjustment of their own Coins/);
    const byOutsider = await adjustment(f.buyer.id, '5');
    expect(await asApp([await byOutsider.request(outsider.id)])).toMatch(/rejects: .*must be requested by an active SUPER_ADMIN/);
    // A first approval by someone who is not an active SUPER_ADMIN.
    const plain = await adjustment(f.buyer.id, '5');
    expect(await asApp([await plain.request(A), await plain.firstApproval(outsider.id)]))
      .toMatch(/rejects: .*needs an active SUPER_ADMIN other than the user/);
    // A second first approval.
    const twice = await adjustment(f.buyer.id, '5');
    expect(await asApp([await twice.request(A), await twice.firstApproval(A), await twice.firstApproval(B)]))
      .toMatch(/rejects: /);
    // A cancel by anyone but the requester.
    const cancel = await adjustment(f.buyer.id, '5');
    expect(await asApp([await cancel.request(A), await cancel.close(B, 'CANCELLED')]))
      .toMatch(/rejects: .*cancelled only by its requester/);
    expect(await asApp([await cancel.request(A), await cancel.close(outsider.id, 'REJECTED')]))
      .toMatch(/rejects: .*can be rejected by an active SUPER_ADMIN/);
    expect(await asApp([await cancel.request(A), await cancel.close(B, 'REJECTED')])).toBe('accepts');

    // Legacy reviews: the first approver must be an active SUPER_ADMIN, and
    // the proposal a whole number of Coins.
    const opened = await executeTestAdjustment(f.buyer.id, 8, approvers);
    const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: opened.reviewLotId! } });
    const proposal = (amount: number) => ({ decision: 'WITHDRAWABLE', rationale: 'Two administrators verified the source',
      supportingEvidence: ['rr-rules'], amount, policyId: null, policyVersion: null, requirementAmount: 0 });
    const approveReview = async (actorId: string, amount: number): Promise<Statement> => {
      const s = await apiSignature(app, { subjectType: 'LEGACY_REVIEW', subjectId: review.id, action: 'FIRST_APPROVAL', actorId,
        userId: f.buyer.id, amount: String(amount), caseId: review.id, evidence: proposal(amount) });
      return ['SELECT "ledger_review_first_approval"($1, $2, $3::jsonb, $4, $5, $6)', review.id, actorId,
        JSON.stringify(proposal(amount)), s.keyId, s.nonce, s.signature];
    };
    expect(await asApp([await approveReview(outsider.id, 8)])).toMatch(/rejects: .*needs an active SUPER_ADMIN other than its owner/);
    expect(await asApp([await approveReview(A, 1.5)])).toMatch(/rejects: .*must be a positive whole number of Coins/);
    expect(await asApp([await approveReview(A, 8)])).toBe('accepts');
    const reason = 'Reopened in a runtime-role test';
    const firstThenReopen = async (actorId: string): Promise<Statement[]> => {
      const s = await apiSignature(app, { subjectType: 'LEGACY_REVIEW', subjectId: review.id, action: 'REOPEN', actorId,
        userId: f.buyer.id, amount: '8', caseId: review.id, evidence: { reason, observedAvailableAmount: null } });
      return [await approveReview(A, 8), ['SELECT "ledger_review_reopen"($1, $2, $3, NULL::integer, $4, $5, $6)', review.id,
        actorId, reason, s.keyId, s.nonce, s.signature]];
    };
    expect(await asApp(await firstThenReopen(outsider.id))).toMatch(/rejects: .*can be reopened only by an active SUPER_ADMIN/);
    expect(await asApp(await firstThenReopen(B))).toBe('accepts');
  });

  it('a forged LEGACY_RESOLVE of an open review rolls back and changes nothing', async () => {
    const opened = await executeTestAdjustment(f.buyer.id, 6, approvers);
    const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: opened.reviewLotId! } });
    const before = await ledgerFingerprint(f.buyer.id);
    const proposal = { decision: 'WITHDRAWABLE', rationale: 'Two administrators verified the source',
      supportingEvidence: ['forged'], amount: 6, policyId: null, policyVersion: null, requirementAmount: 0 };
    expect(await asApp([['UPDATE "legacy_balance_reviews" SET "status" = \'FIRST_APPROVED\', "resolvedBy" = $2 WHERE "id" = $1',
      review.id, approvers.first.id]])).toMatch(/rejects: .*permission denied/);
    expect(await asApp([['SELECT "ledger_review_first_approval"($1, $2, $3::jsonb, $4, $5, $6)', review.id, approvers.first.id,
      JSON.stringify(proposal), process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary', randomBytes(24).toString('hex'),
      randomBytes(32).toString('hex')]])).toMatch(/rejects: .*is not signed by an active approval key/);
    const op = uid('rr-resolve'); const child = uid('rr-child');
    expect(await commitAsApp([
      [`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy","snapshot")
        VALUES ($1,'LEGACY_RESOLVE',$2,'REVIEW',$3,'{}',$4, jsonb_build_object('evidence', '{}'::jsonb,
          'firstApproverId', $5::text, 'secondApproverId', $4::text, 'decision', 'WITHDRAWABLE', 'amount', 6))`,
        op, f.buyer.id, review.id, approvers.second.id, approvers.first.id],
      [`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
        VALUES ($1,$2,$3,0,'RECLASS_OUT',-6)`, op, review.lotId, f.buyer.id],
      [`INSERT INTO "coin_provenance" ("id","userId","amount","provenanceType","restrictionStatus","originalSource",
          "lotClass","state","availableAmount","reservedAmount","requirementAmount","progressAmount",
          "mintedAt","availableAt","sourceOperationId","parentLotId","rootLotId","createdAt","updatedAt")
        VALUES ($1,$2,6,'ADMIN_ADJUSTMENT','UNRESTRICTED','ADMIN_ADJUSTMENT','WITHDRAWABLE','OPEN',0,0,0,0,
          now(),now(),$3,$4,$4,now(),now())`, child, f.buyer.id, op, review.lotId],
      [`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
        VALUES ($1,$2,$3,1,'RECLASS_IN',6)`, op, child, f.buyer.id],
      ['UPDATE "coin_provenance" SET "state" = \'RECLASSIFIED\', "closedAt" = now() WHERE "id" = $1', review.lotId],
    ])).toMatch(/rejects: .*is not the resolution of any legacy review/);
    expect(await ledgerFingerprint(f.buyer.id)).toEqual(before);
  });

  it('cannot make the guards read TEMP tables instead of the real rows', async () => {
    const forged = fabricatedCredit(f.buyer.id, 30, approvers.first.id, approvers.second.id, { approval: false });
    const shadow: Statement[] = [
      ['CREATE TEMP TABLE "admin_adjustment_approvals" (LIKE public."admin_adjustment_approvals") ON COMMIT DROP'],
      ['CREATE TEMP TABLE "ledger_approval_assertions" (LIKE public."ledger_approval_assertions") ON COMMIT DROP'],
      ['CREATE TEMP TABLE "users" ("id" text, "role" text, "status" text) ON COMMIT DROP'],
      [`INSERT INTO pg_temp."users" VALUES ('ghost-1', 'SUPER_ADMIN', 'ACTIVE'), ('ghost-2', 'SUPER_ADMIN', 'ACTIVE')`],
      [`INSERT INTO pg_temp."admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","status","createdBy",
          "createdAt","firstApproverId","secondApproverId","operationId")
        VALUES ($1,$2,30,$3,$4::jsonb,'EXECUTED','ghost-1',now(),'ghost-1','ghost-2',$5)`,
      uid('ghost-approval'), f.buyer.id, forged.caseId, JSON.stringify(evidenceFor(forged.caseId)), forged.op],
    ];
    expect(await asApp([...shadow, ...forged.statements])).toMatch(/rejects: .*is not the execution of any adjustment approval/);
  });
});

describe('3. amounts are never rounded before validation', () => {
  it('the signed procedure refuses fractional, zero and out-of-range amounts, and stores accepted ones exactly', async () => {
    const request = async (amount: string) => {
      const approvalId = uid('rr-amount'); const caseId = uid('rr-case');
      const signed = await apiSignature(app, { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, action: 'REQUEST',
        actorId: approvers.first.id, userId: f.buyer.id, amount, caseId, evidence: evidenceFor(caseId) }).catch(() => (
        { keyId: 'primary', nonce: randomBytes(24).toString('hex'), signature: randomBytes(32).toString('hex') }));
      // Accepted only if the stored whole amount equals the one requested.
      return asApp([
        ['SELECT "ledger_adjustment_request"($1, $2, $3::numeric, $4, $5::jsonb, $6, $7, $8, $9)', approvalId, f.buyer.id,
          amount, caseId, JSON.stringify(evidenceFor(caseId)), approvers.first.id, signed.keyId, signed.nonce, signed.signature],
        [`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM "admin_adjustment_approvals" WHERE "id" = '${approvalId}'
            AND "amount"::numeric = '${amount}'::numeric) THEN RAISE EXCEPTION 'amount not stored exactly'; END IF; END $$`],
      ]);
    };
    for (const amount of ['0', '0.1', '0.5', '1.5', '-0.5', '-1.5', '-0', '0.0000001', '1000000000.5', '-1000000000.5',
      '1000000001', '-1000000001', '99999999999999999999', '1e20', 'NaN', 'Infinity', '-Infinity']) {
      expect(await request(amount), amount).toMatch(/rejects: .*must be a nonzero whole number of Coins/);
    }
    for (const amount of ['1', '-1', '1000000000', '-1000000000', '1e3', '1.0', '+7', '25.000', '-3.00']) {
      expect(await request(amount), amount).toBe('accepts');
    }
  });

  it('a direct write of a fractional amount is refused, never rounded into a valid approval', async () => {
    for (const amount of ['0.5', '1.5', '-0.5', '-1.5']) {
      const caseId = uid('rr-direct');
      expect(await asApp([[`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy")
        VALUES ($1,$2,$3::numeric,$4,$5::jsonb,$6)`, uid('rr-direct'), f.buyer.id, amount, caseId,
        JSON.stringify(evidenceFor(caseId)), approvers.first.id]]), amount).toMatch(/rejects: .*permission denied/);
    }
  });
});

describe('4. the API and the worker work under the runtime role', () => {
  it('registers, plays, settles a signed adjustment and review, enables a gate and runs the worker', async () => {
    const method = await prisma.paymentMethodDefinition.findFirstOrThrow({ where: { countryId: f.country.id } });
    await prisma.userPayoutAccount.create({ data: { userId: f.buyer.id, countryId: f.country.id, methodDefId: method.id,
      accountDetails: { label: 'runtime-role' }, status: 'ACTIVE' } });
    const admins = await makeApprovers('runtime-e2e');
    const who = async (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, username: true, email: true } });
    const input = { player: await who(f.buyer.id), adminA: await who(admins.first.id), adminB: await who(admins.second.id) };
    const env = { ...process.env, DATABASE_URL: runtimeUrl, LOG_LEVEL: 'fatal', LOG_PRETTY: 'false' };
    const harness = spawnSync(TSX, [join(API_ROOT, 'src/test/runtime-role-harness.ts'), JSON.stringify(input)],
      { cwd: API_ROOT, env, encoding: 'utf8', timeout: 240_000 });
    const line = harness.stdout.split('\n').reverse().find((l) => l.startsWith('{"steps"') || l.startsWith('{"fatal"'));
    expect(line, `${harness.stdout}\n${harness.stderr}`).toBeTruthy();
    const result = JSON.parse(line!) as { steps?: { step: string; ok: boolean; detail: unknown }[]; fatal?: string };
    expect(result.fatal, result.fatal).toBeUndefined();
    for (const step of result.steps!) expect(step.ok, `${step.step}: ${JSON.stringify(step.detail)}`).toBe(true);
    expect(result.steps!.map((s) => s.step)).toHaveLength(7);

    const adjustment = await prisma.economicOperation.findMany({ where: { userId: f.buyer.id, type: { in: ['ADMIN_ADJUST', 'LEGACY_RESOLVE'] },
      createdBy: admins.second.id } });
    expect(adjustment.map((o) => o.type).sort()).toEqual(['ADMIN_ADJUST', 'LEGACY_RESOLVE']);
    const scan = await inRolledBackTransaction((tx) => runLedgerInvariantCheckInTransaction(tx, null, false));
    expect(scan.violations).toEqual([]);

    const worker = spawnSync(TSX, [join(API_ROOT, 'src/worker.ts'), '--once'], { cwd: API_ROOT, env, encoding: 'utf8', timeout: 240_000 });
    expect(worker.status, `${worker.stdout}\n${worker.stderr}`).toBe(0);
  }, 300_000);
});

describe('6. nothing the runtime role could plant runs in the privileged approval context', () => {
  // The approval functions run as the owner (SECURITY DEFINER, and what they
  // call and fire). A role that could create objects in a schema their code
  // resolves names in could plant an operator or an overload that PostgreSQL
  // prefers to the owner's own (a better match than one needing an implicit
  // cast) and have it run with the owner's privileges. These are exactly two
  // such plants: `numeric > integer` (the amount check) and an integer-amount
  // overload of ledger_record_assertion (the procedures pass an INTEGER).
  const plant = (tag: string): Statement[] => [
    [`CREATE TABLE public."rr_hijack_${tag}" ("who" text, "via" text)`],
    [`CREATE FUNCTION public."rr_hijack_gt_${tag}"(numeric, integer) RETURNS boolean LANGUAGE plpgsql AS $f$
       BEGIN INSERT INTO public."rr_hijack_${tag}" VALUES (current_user, 'operator >'); RETURN $1 > $2::numeric; END $f$`],
    [`CREATE OPERATOR public.> (LEFTARG = numeric, RIGHTARG = integer, FUNCTION = public."rr_hijack_gt_${tag}")`],
    [`CREATE FUNCTION public."ledger_record_assertion"(text, text, text, text, text, integer, text, jsonb, text, text, text)
       RETURNS void LANGUAGE plpgsql AS $f$
       BEGIN INSERT INTO public."rr_hijack_${tag}" VALUES (current_user, 'ledger_record_assertion overload'); END $f$`],
  ];
  const noHijack = (tag: string): Statement => [`DO $d$ BEGIN
      IF EXISTS (SELECT 1 FROM public."rr_hijack_${tag}") THEN
        RAISE EXCEPTION 'hijacked: %', (SELECT string_agg("who" || ' via ' || "via", ', ') FROM public."rr_hijack_${tag}");
      END IF;
    END $d$`];
  /** A Coin adjustment request, signed with the API's key or with a random signature. */
  const request = async (signature: 'valid' | 'random'): Promise<Statement> => {
    const approvalId = uid('rr-plant'); const caseId = uid('rr-case'); const evidence = evidenceFor(caseId);
    const signed = signature === 'valid'
      ? await apiSignature(app, { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, action: 'REQUEST',
        actorId: approvers.first.id, userId: f.buyer.id, amount: '5', caseId, evidence })
      : { keyId: process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary', nonce: randomBytes(24).toString('hex'),
        signature: randomBytes(32).toString('hex') };
    return ['SELECT "ledger_adjustment_request"($1, $2, 5::numeric, $3, $4::jsonb, $5, $6, $7, $8)', approvalId, f.buyer.id,
      caseId, JSON.stringify(evidence), approvers.first.id, signed.keyId, signed.nonce, signed.signature];
  };
  const tag = () => randomUUID().replaceAll('-', '').slice(0, 10);
  const canCreate = async () => {
    const [row] = await prisma.$queryRawUnsafe<{ can: boolean }[]>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS can`, role);
    return row.can;
  };
  const publicCanCreate = async () => {
    const [row] = await prisma.$queryRawUnsafe<{ can: boolean }[]>(`
      SELECT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                     WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS can`);
    return row.can;
  };

  it('setup removes CREATE granted to PUBLIC; the runtime role then cannot create anything there', async () => {
    await prisma.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      expect(await canCreate()).toBe(true);
      expect(await asApp(plant(tag())), 'the PUBLIC grant is effective before setup').toBe('accepts');
      expect(await i3AsApp(), 'invariant I3, run by the runtime role, reports the grant').toContain('create:public');
      await prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
      expect(await publicCanCreate()).toBe(false);
      expect(await canCreate()).toBe(false);
      expect(await asApp(plant(tag()))).toMatch(/rejects: .*permission denied for schema public/);
      expect(await i3AsApp()).not.toContain('create:public');
    } finally {
      await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }
  });

  it('setup refuses a runtime role that can create there through a role it belongs to', async () => {
    // Inherited, and usable only by SET ROLE (the member made NOINHERIT for the grant).
    for (const inherit of [true, false]) {
      const via = `playqube_via_${tag()}`;
      await prisma.$executeRawUnsafe(`CREATE ROLE "${via}" NOLOGIN NOSUPERUSER`);
      try {
        await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${via}"`);
        if (!inherit) await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
        await prisma.$executeRawUnsafe(`GRANT "${via}" TO "${role}"`);
        await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role), `inherit=${inherit}`)
          .rejects.toThrow(new RegExp(`can still create objects in schema public, through ${via}`));
        if (inherit) {
          const refused = runtimeAccess({ DATABASE_URL: runtimeUrl });
          expect(refused.status, refused.output).toBe(1);
          expect(refused.output).toMatch(/NOT verified; nothing was changed:\n.*can still create objects in schema public, through/);
        }
      } finally {
        await prisma.$executeRawUnsafe(`REVOKE "${via}" FROM "${role}"`);
        await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" INHERIT`);
        await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${via}"`);
        await prisma.$executeRawUnsafe(`DROP ROLE "${via}"`);
      }
    }
    await prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
    expect(await canCreate()).toBe(false);
    expect(await asApp(plant(tag()))).toMatch(/rejects: .*permission denied for schema public/);
  });

  it('setup refuses a runtime role that can become the schema\'s owner, even with no CREATE in the schema\'s ACL', async () => {
    const [before] = await prisma.$queryRawUnsafe<{ owner: string; acl: string[] }[]>(
      `SELECT n.nspowner::regrole::text AS owner, (SELECT array_agg(item::text ORDER BY item::text) FROM unnest(n.nspacl) AS item) AS acl
       FROM pg_namespace n WHERE n.nspname = 'public'`);
    const via = `playqube_via_${tag()}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${via}" NOLOGIN NOSUPERUSER`);
    try {
      // The owner's CREATE needs no ACL entry (an owner can always grant it to
      // itself), and SET ROLE is not seen by has_schema_privilege.
      await prisma.$executeRawUnsafe(`ALTER SCHEMA public OWNER TO "${via}"`);
      await prisma.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM "${via}"`);
      await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
      await prisma.$executeRawUnsafe(`GRANT "${via}" TO "${role}"`);
      await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role))
        .rejects.toThrow(new RegExp(`can still create objects in schema public, through ${via}`));
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE "${via}" FROM "${role}"`);
      await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" INHERIT`);
      await prisma.$executeRawUnsafe(`ALTER SCHEMA public OWNER TO ${before.owner}`);
      await prisma.$executeRawUnsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${before.owner}`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${via}"`);
    }
    const [after] = await prisma.$queryRawUnsafe<{ owner: string; acl: string[] }[]>(
      `SELECT n.nspowner::regrole::text AS owner, (SELECT array_agg(item::text ORDER BY item::text) FROM unnest(n.nspacl) AS item) AS acl
       FROM pg_namespace n WHERE n.nspname = 'public'`);
    expect(after).toEqual(before);
    await prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
  });

  it('setup refuses a runtime role that still owns what it planted before its CREATE was removed', async () => {
    const t = tag();
    await prisma.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      // A function and an operator (a table it owned would be refused by the
      // older check on the schema's relations).
      expect(await commitAsApp(plant(t).slice(1, 3))).toBe('committed');
      await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role))
        .rejects.toThrow(new RegExp(`owns objects in schema public: function public\\.rr_hijack_gt_${t}\\(numeric,integer\\), operator public\\.>\\(numeric,integer\\)`));
      // The refusal changed nothing, not even the revoke that preceded it.
      expect(await publicCanCreate()).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe('DROP OPERATOR IF EXISTS public.> (numeric, integer)');
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."rr_hijack_gt_${t}"(numeric, integer)`);
      await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }
    await prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
    expect(await canCreate()).toBe(false);
  });

  it('even a role that can create there cannot make the approval functions run what it planted', async () => {
    // As if setup had never run: CREATE inherited through another role.
    const via = `playqube_via_${tag()}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${via}" NOLOGIN NOSUPERUSER`);
    try {
      await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${via}"`);
      await prisma.$executeRawUnsafe(`GRANT "${via}" TO "${role}"`);
      expect(await canCreate()).toBe(true);
      // Each attempt first drops the session's cached plans, so the procedures
      // resolve names afresh whatever the pooled connection ran before.
      // An unsigned request is still refused: the planted overload never replaces the signature check.
      const unsigned = tag();
      expect(await asApp([['DISCARD PLANS'], ...plant(unsigned), await request('random'), noHijack(unsigned)]))
        .toMatch(/rejects: .*is not signed by an active approval key/);
      // A genuine request succeeds, and neither the planted operator nor the overload ran.
      const signed = tag();
      expect(await asApp([['DISCARD PLANS'], ...plant(signed), await request('valid'), noHijack(signed)])).toBe('accepts');
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE "${via}" FROM "${role}"`);
      await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${via}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${via}"`);
    }
  });

  it('the approval functions run with a fixed search path, and invariant I3 reports one that loses it', async () => {
    const privileged = ['ledger_evidence_digest', 'ledger_approval_payload', 'ledger_approval_signature_valid',
      'ledger_assertion_valid', 'ledger_install_approval_key', 'ledger_retire_approval_key', 'ledger_record_assertion',
      'ledger_is_active_super_admin', 'ledger_require_whole_coin_amount', 'ledger_adjustment_request',
      'ledger_adjustment_first_approval', 'ledger_adjustment_execute', 'ledger_adjustment_close',
      'ledger_review_first_approval', 'ledger_review_reopen', 'ledger_review_resolve',
      'ledger_lock_economy_for_invariant_check', 'ledger_apply_runtime_grants', 'admin_adjustment_evidence_valid',
      'admin_adjustment_approval_lifecycle_guard', 'legacy_review_lifecycle_guard',
      // The older guards and validators a signed decision fires, which run as the owner too.
      'operation_authorization_guard', 'admin_adjustment_violation', 'legacy_resolution_violation',
      'review_coverage_guard', 'unclassified_lot_review_violation', 'coin_provenance_guard'];
    const functions = await prisma.$queryRawUnsafe<{ name: string; config: string[] | null }[]>(`
      SELECT p.proname::text AS name, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`, privileged);
    expect(functions.map((fn) => fn.name).sort()).toEqual([...privileged].sort());
    for (const fn of functions) expect(fn.config, fn.name).toEqual(['search_path=pg_catalog, pg_temp']);
    const i3 = await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER FUNCTION public."ledger_require_whole_coin_amount"(numeric) SET search_path = public, pg_temp');
      const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
      return run.violations.find((v) => v.invariant.startsWith('I3'));
    });
    expect(i3?.sample).toContain('search_path:ledger_require_whole_coin_amount(numeric)');
  });
});

describe('7. a retired role\'s overload of a built-in never runs in the privileged approval context', () => {
  // The retired role (retiredRoleWithPlants) is unrelated to the runtime
  // role, so the runtime role's own checks never see it. Its
  // public.to_jsonb(integer) is what admin_adjustment_violation would call on
  // the approval's INTEGER amount, and its `=` on the lots' restriction
  // status what coin_provenance_guard (SECURITY DEFINER) would use on every
  // lot update. The adjustment still succeeds either way; only the plants'
  // own records show whether they ran.
  const retire = () => retiredRoleWithPlants([{ op: '=', type: 'public.coin_restriction_status' }]);

  /**
   * A valid Coin adjustment, run by the runtime role as the API runs it: the
   * signed request and first approval, then in one transaction the credit
   * and the signed second approval (ledger_adjustment_execute). `immediate`
   * checks the execution guard at the end of that procedure's UPDATE, so
   * inside the SECURITY DEFINER procedure, as the owner; `deferred` leaves
   * it (and every other guard) to COMMIT.
   */
  const signedAdjustment = async (timing: 'immediate' | 'deferred') => {
    const approvalId = randomUUID(); const caseId = uid('rr-retired-case'); const evidence = evidenceFor(caseId);
    const amount = 5;
    const terms = { subjectType: 'ADMIN_ADJUSTMENT', subjectId: approvalId, userId: f.buyer.id, amount: String(amount),
      caseId, evidence };
    const request = await apiSignature(app, { ...terms, action: 'REQUEST', actorId: approvers.first.id });
    const first = await apiSignature(app, { ...terms, action: 'FIRST_APPROVAL', actorId: approvers.first.id });
    const second = await apiSignature(app, { ...terms, action: 'SECOND_APPROVAL', actorId: approvers.second.id });
    expect(await commitAsApp([
      ['SELECT "ledger_adjustment_request"($1, $2, $3::numeric, $4, $5::jsonb, $6, $7, $8, $9)', approvalId, f.buyer.id,
        String(amount), caseId, JSON.stringify(evidence), approvers.first.id, request.keyId, request.nonce, request.signature],
      ['SELECT "ledger_adjustment_first_approval"($1, $2, $3, $4, $5)', approvalId, approvers.first.id,
        first.keyId, first.nonce, first.signature],
    ])).toBe('committed');
    await app.$transaction(async (tx) => {
      // Names resolve afresh, whatever this pooled connection planned before.
      await tx.$executeRawUnsafe('DISCARD PLANS');
      const credit = await creditCoins(tx, f.buyer.id, amount, {
        type: 'ADMIN_ADJUST', scopeType: 'ADMIN_ADJUSTMENT', scopeId: caseId, referenceType: 'ADMIN', referenceId: caseId,
        description: evidence.rationale, createdBy: approvers.second.id, evidence,
        adjustmentApproval: { id: approvalId, amount },
      });
      if (timing === 'immediate') await tx.$executeRawUnsafe('SET CONSTRAINTS "adjustment_execution_guard" IMMEDIATE');
      await tx.$executeRawUnsafe('SELECT "ledger_adjustment_execute"($1, $2, $3, $4, $5, $6, $7)', approvalId,
        approvers.second.id, credit.operationId, credit.walletTransactionId, second.keyId, second.nonce, second.signature);
    }, { timeout: 120_000 });
    return approvalId;
  };

  it('setup refuses the database while a role outside the owner\'s trust owns objects in public, and prints no key', async () => {
    const plant = await retire();
    try {
      await expect(prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role))
        .rejects.toThrow(new RegExp(`function public\\.to_jsonb\\(integer\\) \\(owner ${plant.retired}\\)`));
      const refused = runtimeAccess({ DATABASE_URL: runtimeUrl });
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toMatch(new RegExp(
        `NOT verified; nothing was changed:\\n.*function public\\.to_jsonb\\(integer\\) \\(owner ${plant.retired}\\)`));
      expect(refused.output).not.toContain(process.env.LEDGER_APPROVAL_SIGNING_KEY!);
      expect(refused.output).not.toContain(password);
    } finally {
      await plant.drop();
    }
    // With the retired role's objects gone, the setup applies again.
    const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
    expect(applied.status, applied.output).toBe(0);
  });

  for (const timing of ['immediate', 'deferred'] as const) {
    it(`even if it were left in place, it never runs with elevated privileges in a signed adjustment (${timing} checks)`, async () => {
      const plant = await retire();
      try {
        const approvalId = await signedAdjustment(timing);
        const executed = await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: approvalId } });
        expect(executed.status).toBe('EXECUTED');
        expect(await prisma.economicOperation.count({ where: { id: executed.operationId!, type: 'ADMIN_ADJUST' } })).toBe(1);
        // Elevated: running as a role other than the session's own, which is
        // what a SECURITY DEFINER context (the owner's) would show.
        const runs = await plant.runs();
        expect(runs.filter((run) => run.ranAs !== run.sessionUser), JSON.stringify(runs)).toEqual([]);
        expect(await plant.elevatedRuns()).toBe(0);
      } finally {
        await plant.drop();
      }
    });
  }
});

describe('8. the older SECURITY DEFINER guards never run a planted operator with elevated privileges', () => {
  // Five older guards run as the owner (SECURITY DEFINER) whenever they fire:
  // game_sessions_validate_rules_snapshot on every wager's session row,
  // game_definitions_prevent_metadata_drift on a catalog update (which the
  // runtime role may make), game_rules_validate_parent and
  // game_rules_immutable on rules writes, and coin_allocations_guard on the
  // frozen allocations. The game guards compare enum columns with = and <>
  // (IS DISTINCT FROM is =), where an exact-type operator in public would
  // beat anyenum = anyenum: the retired role leaves exactly those.
  const gamePlants: OperatorPlant[] = ['public.game_mode', 'public.game_family', 'public."CurrencyType"']
    .flatMap((type) => (['=', '<>'] as const).map((op) => ({ op, type })));

  /**
   * A Dice wager through the game service, its transaction on the runtime
   * role's connection. `immediate` runs every deferred check as soon as the
   * wager's writes are done, inside the transaction (a wager balances only
   * once all of them are written); `deferred` leaves them to COMMIT.
   */
  const wagerAsRuntimeRole = async (timing: 'immediate' | 'deferred') => {
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
      run: (tx: unknown) => Promise<unknown>, options?: Parameters<PrismaClient['$transaction']>[1],
    ) => app.$transaction(async (tx) => {
      // Names resolve afresh, whatever this pooled connection planned before.
      await tx.$executeRawUnsafe('DISCARD PLANS');
      const played = await run(tx);
      if (timing === 'immediate') await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return played;
    }, { ...options, timeout: 120_000 })) as never);
    try {
      return await playGame({ userId: f.buyer.id, gameKey: 'dice', betAmount: 10, idempotencyKey: uid('rr-wager') });
    } finally {
      spy.mockRestore();
    }
  };
  const timingStatements = (timing: 'immediate' | 'deferred'): Statement[] =>
    [['DISCARD PLANS'], ...(timing === 'immediate' ? [['SET CONSTRAINTS ALL IMMEDIATE'] as Statement] : [])];

  beforeAll(async () => {
    // Play resolves the player's jurisdiction from a payout account (as in section 4).
    if (!await prisma.userPayoutAccount.findFirst({ where: { userId: f.buyer.id } })) {
      const method = await prisma.paymentMethodDefinition.findFirstOrThrow({ where: { countryId: f.country.id } });
      await prisma.userPayoutAccount.create({ data: { userId: f.buyer.id, countryId: f.country.id, methodDefId: method.id,
        accountDetails: { label: 'runtime-role' }, status: 'ACTIVE' } });
    }
  });

  for (const timing of ['immediate', 'deferred'] as const) {
    it(`a Coin wager's session row (${timing} checks)`, async () => {
      const plant = await retiredRoleWithPlants(gamePlants);
      try {
        const played = await wagerAsRuntimeRole(timing);
        expect(played.isReplay).toBe(false);
        const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: played.sessionId } });
        // The guard compared the session with its rules version.
        expect(session.rulesVersion).not.toBeNull();
        expect(await plant.elevatedRuns(), JSON.stringify(await plant.runs())).toBe(0);
      } finally {
        await plant.drop();
      }
    });

    it(`a catalog update the runtime role can make (${timing} checks)`, async () => {
      const plant = await retiredRoleWithPlants(gamePlants);
      try {
        expect(await commitAsApp([...timingStatements(timing),
          ['UPDATE "game_definitions" SET "mode" = "mode", "currentRulesVersion" = "currentRulesVersion" WHERE "key" = \'dice\''],
        ])).toBe('committed');
        expect(await plant.elevatedRuns(), JSON.stringify(await plant.runs())).toBe(0);
      } finally {
        await plant.drop();
      }
    });
  }

  it('the rules and allocation guards: the runtime role reaches them only to be refused, never running a plant', async () => {
    const plant = await retiredRoleWithPlants(gamePlants);
    try {
      // game_rules_validate_parent fires on INSERT: the runtime role may not
      // write game_rules at all, no cascade inserts, and no procedure writes it.
      expect(await asApp([['INSERT INTO "game_rules" DEFAULT VALUES']])).toMatch(/rejects: .*permission denied for table game_rules/);
      expect(await asApp([['UPDATE "game_rules" SET "version" = "version"']])).toMatch(/rejects: .*permission denied for table game_rules/);
      // game_rules_immutable is reached only through the ON UPDATE CASCADE of
      // a game's id, and the setup took UPDATE on that key from the runtime
      // role (section 10 covers the cascade itself, granted back).
      const dice = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
      expect(await asApp([['DISCARD PLANS'], ['UPDATE "game_definitions" SET "id" = "id" || \'-renamed\' WHERE "id" = $1', dice.id]]))
        .toMatch(/rejects: .*permission denied for table game_definitions/);
      // coin_allocations_guard fires after coin_allocations_frozen (trigger
      // name order), which refuses every write; the runtime role can switch
      // neither the trigger nor replication mode off.
      expect(await asApp([['INSERT INTO "coin_allocations" DEFAULT VALUES']])).toMatch(/rejects: .*coin_allocations is frozen/);
      expect(await asApp([['ALTER TABLE "coin_allocations" DISABLE TRIGGER "coin_allocations_frozen"']]))
        .toMatch(/rejects: .*must be owner of table coin_allocations/);
      expect(await asApp([['SET LOCAL session_replication_role = replica']])).toMatch(/rejects: .*permission denied to set parameter/);
      expect(await plant.elevatedRuns(), JSON.stringify(await plant.runs())).toBe(0);
    } finally {
      await plant.drop();
    }
  });

  it('every SECURITY DEFINER function of the schema runs with the fixed search path, and invariant I3 reports one that loses it', async () => {
    const unpinned = await prisma.$queryRawUnsafe<{ name: string }[]>(`
      SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, pg_temp']`);
    expect(unpinned).toEqual([]);
    const i3 = await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER FUNCTION public."game_rules_immutable"() SET search_path = public, pg_temp');
      const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
      return run.violations.find((v) => v.invariant.startsWith('I3'));
    });
    expect(i3?.sample).toEqual(['search_path:game_rules_immutable()']);
  });
});

describe('9. the setup refuses any role outside the owner\'s trust that could still create where the owner resolves names', () => {
  // Migrations, the preflight, the invariant scan and every function the
  // owner runs resolve names in public (and pg_catalog): an object a role
  // outside the owner's trust creates there after the setup ran would be
  // picked like one it left before. So no such role may hold CREATE there,
  // by grant or through a role it can become; one that can act as the
  // tables' owner or a superuser is already inside the boundary.
  const t9 = () => randomUUID().replaceAll('-', '').slice(0, 10);
  const grants = () => prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);
  const refusal = (who: string, through: string) =>
    new RegExp(`roles outside the owner's trust can still create objects in schema public: .*${who} \\(through ${through}\\)`);

  it('a direct grant to an unrelated role: refused and named, the script prints no key, and I3 reports it', async () => {
    const other = `playqube_other_${t9()}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${other}" NOLOGIN`);
    try {
      await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${other}"`);
      await expect(grants()).rejects.toThrow(refusal(other, other));
      const refused = runtimeAccess({ DATABASE_URL: runtimeUrl });
      expect(refused.status, refused.output).toBe(1);
      expect(refused.output).toMatch(/NOT verified; nothing was changed:\n.*roles outside the owner's trust can still create objects in schema public/);
      expect(refused.output).not.toContain(process.env.LEDGER_APPROVAL_SIGNING_KEY!);
      expect(refused.output).not.toContain(password);
      // A grant made after the setup ran is reported by the invariant scan.
      expect(await i3AsApp()).toContain('create:public');
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${other}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${other}"`);
    }
    expect(await i3AsApp()).not.toContain('create:public');
    const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
    expect(applied.status, applied.output).toBe(0);
  });

  it('a membership usable only by SET ROLE in a role holding CREATE: refused, naming the path', async () => {
    const holder = `playqube_holder_${t9()}`;
    const other = `playqube_other_${t9()}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${holder}" NOLOGIN`);
    await prisma.$executeRawUnsafe(`CREATE ROLE "${other}" LOGIN NOINHERIT`);
    try {
      await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${holder}"`);
      await prisma.$executeRawUnsafe(`GRANT "${holder}" TO "${other}"`);
      const [row] = await prisma.$queryRawUnsafe<{ direct: boolean }[]>(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS direct`, other);
      expect(row.direct, 'has_schema_privilege does not see a SET ROLE path').toBe(false);
      await expect(grants()).rejects.toThrow(refusal(other, holder));
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE "${holder}" FROM "${other}"`);
      await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${holder}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${other}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${holder}"`);
    }
    await grants();
  });

  it('a role that can act as the tables\' owner may hold CREATE: accepted', async () => {
    const [{ owner }] = await prisma.$queryRawUnsafe<{ owner: string }[]>(
      `SELECT c.relowner::regrole::text AS owner FROM pg_class c WHERE c.oid = 'public.economic_operations'::regclass`);
    const deputy = `playqube_deputy_${t9()}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${deputy}" NOLOGIN`);
    try {
      await prisma.$executeRawUnsafe(`GRANT ${owner} TO "${deputy}"`);
      await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${deputy}"`);
      await grants();
      expect(await i3AsApp()).not.toContain('create:public');
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE CREATE ON SCHEMA public FROM "${deputy}"`);
      await prisma.$executeRawUnsafe(`REVOKE ${owner} FROM "${deputy}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${deputy}"`);
    }
  });
});

describe('10. no cascade the runtime role can start runs a planted object with the owner\'s privileges', () => {
  // A foreign key's ON UPDATE / ON DELETE action writes the referencing
  // table as its owner, and that table's triggers then run with the owner's
  // privileges. The runtime role starts such a cascade by changing a key (an
  // Agent's id cascades to its orders and reservations) or by deleting a row
  // (a policy's lots lose their policy). The setup takes the key changes away
  // and refuses objects in public that are not the owner's, but only when it
  // runs: here an unrelated role is given CREATE on public after it ran,
  // and the triggers must still never pick what it creates.
  type OwnerOnlyPlant = { toJsonb: string } | { op: '=' | '<>'; type: string };
  const grants = () => prisma.$executeRawUnsafe('SELECT "ledger_apply_runtime_grants"($1)', role);

  /**
   * After the setup ran, an unrelated role is given CREATE on public (as a
   * later grant might) and creates the given exact-type plants there. Each
   * returns the genuine result and tries to advance its own owner-only
   * sequence, which only a run with the owner's privileges can (anyone
   * else's attempt is refused, and the plant swallows the refusal). A
   * sequence is not transactional: an advance outlives a rejected or
   * rolled-back transaction.
   */
  async function unrelatedCreatorPlants(plants: OwnerOnlyPlant[]) {
    const t = randomUUID().replaceAll('-', '').slice(0, 10);
    const creator = `playqube_creator_${t}`;
    const sequence = (i: number) => `public."rr_owner_only_${i}_${t}"`;
    const label = (plant: OwnerOnlyPlant) => ('toJsonb' in plant
      ? `to_jsonb(${plant.toJsonb})` : `${plant.op} on ${plant.type.replaceAll('"', '')}`);
    const advance = (i: number) => `
      BEGIN
        PERFORM pg_catalog.nextval('${sequence(i)}'::regclass);
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;`;
    // Owner-only: created by the owner, with no privilege for anyone else.
    await prisma.$transaction(plants.map((_, i) => prisma.$executeRawUnsafe(`CREATE SEQUENCE ${sequence(i)}`)));
    await prisma.$executeRawUnsafe(`CREATE ROLE "${creator}" NOLOGIN NOSUPERUSER`);
    await prisma.$executeRawUnsafe(`GRANT CREATE ON SCHEMA public TO "${creator}"`);
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL ROLE "${creator}"`),
      ...plants.flatMap((plant, i) => ('toJsonb' in plant ? [
        prisma.$executeRawUnsafe(`CREATE FUNCTION public.to_jsonb(${plant.toJsonb}) RETURNS jsonb LANGUAGE plpgsql AS $f$
          BEGIN ${advance(i)}
            RETURN pg_catalog.to_jsonb($1);
          END $f$`),
      ] : [
        prisma.$executeRawUnsafe(`CREATE FUNCTION public."rr_creator_op_${i}_${t}"(${plant.type}, ${plant.type}) RETURNS boolean
          LANGUAGE plpgsql AS $f$
          BEGIN ${advance(i)}
            RETURN $1::text OPERATOR(pg_catalog.${plant.op}) $2::text;
          END $f$`),
        prisma.$executeRawUnsafe(`CREATE OPERATOR public.${plant.op} (LEFTARG = ${plant.type}, RIGHTARG = ${plant.type},
          FUNCTION = public."rr_creator_op_${i}_${t}")`),
      ])),
    ]);
    return {
      /** The plants that ran with the owner's privileges, whatever became of their transaction. */
      advanced: async () => {
        const [row] = await prisma.$queryRawUnsafe<Record<string, boolean>[]>(
          `SELECT ${plants.map((_, i) => `(SELECT is_called FROM ${sequence(i)}) AS "s${i}"`).join(', ')}`);
        return plants.filter((_, i) => row[`s${i}`]).map(label);
      },
      drop: async () => {
        await prisma.$executeRawUnsafe(`DROP OWNED BY "${creator}"`);
        await prisma.$executeRawUnsafe(`DROP ROLE "${creator}"`);
        await prisma.$transaction(plants.map((_, i) => prisma.$executeRawUnsafe(`DROP SEQUENCE ${sequence(i)}`)));
      },
    };
  }

  /**
   * Runs `statement` with the runtime role's privileges (SET LOCAL ROLE)
   * inside an owner transaction that is always rolled back, after the
   * owner's `prepare` (grants given back, a recreated foreign key), with
   * every check immediate from the start or left until the end.
   */
  async function asRuntimeRoleRolledBack(prepare: Statement[], statement: Statement, immediate: boolean): Promise<string> {
    try {
      await prisma.$transaction(async (tx) => {
        for (const [sql, ...params] of prepare) await tx.$executeRawUnsafe(sql, ...params);
        // Names resolve afresh, whatever this pooled connection planned before.
        await tx.$executeRawUnsafe('DISCARD PLANS');
        if (immediate) await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        const [sql, ...params] = statement;
        await tx.$executeRawUnsafe(sql, ...params);
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        throw new RolledBack('accepts');
      }, { timeout: 120_000 });
    } catch (error) {
      if (error instanceof RolledBack) return error.value as string;
      return `rejects: ${oneLine(error)}`;
    }
    return 'committed';
  }

  /** The buyer's Agent, with its settled order and settled reservation. */
  const settledAgent = async () => {
    const [row] = await prisma.$queryRawUnsafe<{ agentId: string; orderId: string; reservationId: string }[]>(`
      SELECT o."agentId", o."id" AS "orderId", r."id" AS "reservationId"
      FROM "agent_order_settlements" s
      JOIN "agent_orders" o ON o."id" = s."orderId"
      JOIN "agent_reservations" r ON r."id" = s."reservationId" AND r."agentId" = o."agentId"
      WHERE o."userId" = $1 LIMIT 1`, f.buyer.id);
    expect(row, 'the purchase fixture settled an order through a reservation').toBeTruthy();
    return row;
  };
  const moveAgent = (agentId: string): Statement => ['UPDATE "agents" SET "id" = "id" || \'-moved\' WHERE "id" = $1', agentId];

  it('an Agent id change: the setup took it away; granted back later, the settled order\'s proof guard runs as the owner but never the planted to_jsonb(agent_orders)', async () => {
    // 1. The setup runs.
    const setup = runtimeAccess({ DATABASE_URL: runtimeUrl });
    expect(setup.status, setup.output).toBe(0);
    const agent = await settledAgent();
    // 2-3. After it, an unrelated role may create in public, and plants an
    // exact-type to_jsonb(public.agent_orders): the order proof guard calls
    // to_jsonb(NEW) on the order row a cascade rewrites.
    const plant = await unrelatedCreatorPlants([{ toJsonb: 'public.agent_orders' }]);
    try {
      // 4. The runtime role changes the Agent's id: as the setup left it,
      // it may not change that key at all.
      const refused = await asApp([['DISCARD PLANS'], moveAgent(agent.agentId)]);
      // With UPDATE on agents granted back after the setup (a later
      // GRANT ... ON ALL TABLES), the cascade runs, as the owner, and the
      // proof guard refuses to rewrite the settled order, whether the
      // transaction would roll back or commit.
      await prisma.$executeRawUnsafe(`GRANT UPDATE ON "agents" TO "${role}"`);
      const rolledBack = await asApp([['DISCARD PLANS'], moveAgent(agent.agentId)]);
      const committed = await commitAsApp([['DISCARD PLANS'], moveAgent(agent.agentId)]);
      // 5. The owner-only sequence never advanced.
      expect({ refused, rolledBack, committed, advanced: await plant.advanced() }).toEqual({
        refused: expect.stringMatching(/rejects: .*permission denied for table agents/),
        rolledBack: expect.stringMatching(/rejects: .*settled Agent order purchase proof is immutable/),
        committed: expect.stringMatching(/rejects: .*settled Agent order purchase proof is immutable/),
        advanced: [],
      });
    } finally {
      await plant.drop();
      await grants();
    }
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.agentId } })).id).toBe(agent.agentId);
  });

  it('an Agent id change reaching the settled reservation first (its foreign keys recreated in another order): the reservation proof guard never runs the planted to_jsonb(agent_reservations)', async () => {
    const agent = await settledAgent();
    // Cascades fire in the order their foreign keys were created: the
    // orders' before the reservations', so today the order guard refuses
    // first. Recreating the orders' foreign key (as a later migration
    // might) puts the reservations first.
    const [fk] = await prisma.$queryRawUnsafe<{ name: string; definition: string }[]>(`
      SELECT c.conname::text AS name, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid = 'agent_orders'::regclass AND c.confrelid = 'agents'::regclass`);
    const plant = await unrelatedCreatorPlants([{ toJsonb: 'public.agent_reservations' }, { toJsonb: 'public.agent_orders' }]);
    try {
      const outcomes: string[] = [];
      for (const immediate of [true, false]) {
        outcomes.push(await asRuntimeRoleRolledBack([
          [`GRANT UPDATE ON "agents" TO "${role}"`],
          [`ALTER TABLE "agent_orders" DROP CONSTRAINT "${fk.name}"`],
          [`ALTER TABLE "agent_orders" ADD CONSTRAINT "${fk.name}" ${fk.definition}`],
        ], moveAgent(agent.agentId), immediate));
      }
      expect({ outcomes, advanced: await plant.advanced() }).toEqual({
        outcomes: [0, 1].map(() => expect.stringMatching(/rejects: .*settled Agent reservation purchase proof is immutable/)),
        advanced: [],
      });
    } finally {
      await plant.drop();
    }
  });

  it('every other cascade the runtime role can start, by a key change granted back after setup or a delete it may make, never runs a plant as the owner (immediate and deferred checks)', async () => {
    // Every single-column foreign key that cascades (or nulls) on UPDATE of
    // a text key the runtime role may otherwise update, or on DELETE of a
    // row it may delete, with a live row to cascade from.
    const cascades = await prisma.$queryRawUnsafe<{ parent: string; key: string; child: string; column: string; action: string }[]>(`
      SELECT p.relname::text AS parent, pa.attname::text AS key, ch.relname::text AS child, ca.attname::text AS "column",
             a.action
      FROM pg_constraint c
      JOIN pg_class p ON p.oid = c.confrelid JOIN pg_class ch ON ch.oid = c.conrelid
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
      CROSS JOIN LATERAL (VALUES
        (CASE WHEN c.confupdtype IN ('c', 'n', 'd') AND pa.atttypid IN ('text'::regtype, 'varchar'::regtype)
                AND has_any_column_privilege($1, c.confrelid, 'UPDATE') THEN 'UPDATE' END),
        (CASE WHEN c.confdeltype IN ('c', 'n', 'd') AND has_table_privilege($1, c.confrelid, 'DELETE') THEN 'DELETE' END)) a(action)
      WHERE c.contype = 'f' AND cardinality(c.confkey) = 1 AND a.action IS NOT NULL
        AND p.relnamespace = 'public'::regnamespace
      ORDER BY 1, 3`, role);
    const paths = new Map<string, { parent: string; key: string; value: string; action: string }>();
    for (const cascade of cascades) {
      const [row] = await prisma.$queryRawUnsafe<{ value: string }[]>(
        `SELECT "${cascade.column}"::text AS value FROM "${cascade.child}" WHERE "${cascade.column}" IS NOT NULL LIMIT 1`);
      if (!row) continue;
      paths.set(`${cascade.action} ${cascade.parent}.${cascade.key}=${row.value}`,
        { parent: cascade.parent, key: cascade.key, value: row.value, action: cascade.action });
    }
    // The paths the review named are among them.
    const names = [...paths.values()].map((path) => `${path.action} ${path.parent}`);
    expect(names).toEqual(expect.arrayContaining(['UPDATE agents', 'UPDATE agent_orders', 'UPDATE coin_provenance',
      'UPDATE country_casino_policies', 'UPDATE wallets', 'UPDATE game_definitions', 'DELETE agents']));
    const children = await prisma.$queryRawUnsafe<{ type: string }[]>(`
      SELECT DISTINCT format('public.%I', ch.relname) AS type FROM pg_constraint c JOIN pg_class ch ON ch.oid = c.conrelid
      WHERE c.contype = 'f' AND (c.confupdtype IN ('c', 'n', 'd') OR c.confdeltype IN ('c', 'n', 'd'))`);
    const enums = await prisma.$queryRawUnsafe<{ type: string }[]>(`
      SELECT format('public.%I', t.typname) AS type FROM pg_type t
      WHERE t.typtype = 'e' AND t.typnamespace = 'public'::regnamespace ORDER BY 1`);
    const plant = await unrelatedCreatorPlants([
      ...children.map(({ type }) => ({ toJsonb: type })),
      ...enums.flatMap(({ type }) => (['=', '<>'] as const).map((op) => ({ op, type }))),
    ]);
    try {
      const outcomes: string[] = [];
      for (const path of paths.values()) {
        for (const immediate of [true, false]) {
          const statement: Statement = path.action === 'UPDATE'
            ? [`UPDATE "${path.parent}" SET "${path.key}" = "${path.key}" || '-moved' WHERE "${path.key}" = $1`, path.value]
            : [`DELETE FROM "${path.parent}" WHERE "${path.key}" = $1`, path.value];
          const prepare: Statement[] = path.action === 'UPDATE' ? [[`GRANT UPDATE ON "${path.parent}" TO "${role}"`]] : [];
          const outcome = await asRuntimeRoleRolledBack(prepare, statement, immediate);
          outcomes.push(`${path.action} ${path.parent}.${path.key} (${immediate ? 'immediate' : 'deferred'}): ${outcome.slice(0, 160)}`);
        }
      }
      expect(await plant.advanced(), outcomes.join('\n')).toEqual([]);
    } finally {
      await plant.drop();
    }
  }, 300_000);

  it('a role the runtime role can become, NOINHERIT and directly or through another role, that can change an Agent id: the setup refuses it', async () => {
    const t = randomUUID().replaceAll('-', '').slice(0, 10);
    const holder = `playqube_keyholder_${t}`;
    const middle = `playqube_middle_${t}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${holder}" NOLOGIN`);
    await prisma.$executeRawUnsafe(`CREATE ROLE "${middle}" NOLOGIN`);
    // An agents editor: it may read and change agents, their id included.
    await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON "agents" TO "${holder}"`);
    await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
    const memberships = {
      direct: [`GRANT "${holder}" TO "${role}"`],
      transitive: [`GRANT "${holder}" TO "${middle}"`, `GRANT "${middle}" TO "${role}"`],
    };
    try {
      for (const [path, grantsFor] of Object.entries(memberships)) {
        for (const sql of grantsFor) await prisma.$executeRawUnsafe(sql);
        try {
          // The runtime role inherits nothing from it, yet can become it and change the key.
          const [row] = await prisma.$queryRawUnsafe<{ inherited: boolean }[]>(
            `SELECT has_column_privilege($1, 'agents', 'id', 'UPDATE') AS inherited`, role);
          expect(row.inherited, path).toBe(false);
          expect(await asApp([[`SET LOCAL ROLE "${holder}"`], ['UPDATE "agents" SET "id" = "id" || \'-moved\' WHERE false']]), path)
            .toBe('accepts');
          // The setup refuses it, naming the key and the role, and changes nothing.
          const refusal = new RegExp(`can still change keys other tables follow by cascade, as a role it can become: .*public\\.agents\\.id through ${holder}`);
          await expect(grants(), path).rejects.toThrow(refusal);
          const refused = runtimeAccess({ DATABASE_URL: runtimeUrl });
          expect(refused.status, `${path}: ${refused.output}`).toBe(1);
          // The script refuses before it changes anything, naming the role it can become.
          expect(refused.output).toMatch(new RegExp(
            `NOT verified; nothing was changed:\\n[\\s\\S]*can still change agents\\.id as ${holder}, a role it can become, a key other tables follow by cascade`));
          expect(refused.output).not.toContain(process.env.LEDGER_APPROVAL_SIGNING_KEY!);
          expect(refused.output).not.toContain(password);
        } finally {
          await prisma.$executeRawUnsafe(`REVOKE "${holder}" FROM "${role}"`);
          await prisma.$executeRawUnsafe(`REVOKE "${middle}" FROM "${role}"`);
          await prisma.$executeRawUnsafe(`REVOKE "${holder}" FROM "${middle}"`);
        }
      }
    } finally {
      await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" INHERIT`);
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${holder}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${middle}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${holder}"`);
    }
    // Without those memberships, the setup applies and verifies again.
    const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
    expect(applied.status, applied.output).toBe(0);
  });

  it('the setup leaves no key other tables follow by cascade updatable by the runtime role, while it can still update what the API does', async () => {
    await grants();
    const keys = await prisma.$queryRawUnsafe<{ key: string }[]>(`
      SELECT DISTINCT c.confrelid::regclass::text || '.' || a.attname::text AS key
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
      WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd') AND has_column_privilege($1, c.confrelid, a.attname::text, 'UPDATE')`,
    role);
    expect(keys).toEqual([]);
    const [kept] = await prisma.$queryRawUnsafe<Record<string, boolean>[]>(`
      SELECT has_column_privilege($1, 'wallets', 'coinsBalance', 'UPDATE') AS "walletBalance",
             has_column_privilege($1, 'agent_orders', 'status', 'UPDATE') AS "orderStatus",
             has_column_privilege($1, 'agents', 'displayName', 'UPDATE') AS "agentName",
             has_column_privilege($1, 'game_definitions', 'catalogStatus', 'UPDATE') AS "catalogStatus"`, role);
    expect(kept).toEqual({ walletBalance: true, orderStatus: true, agentName: true, catalogStatus: true });
  });

  it('every trigger a cascade can fire runs with the fixed search path, and invariant I3 reports one that loses it', async () => {
    const unpinned = await prisma.$queryRawUnsafe<{ name: string }[]>(`
      SELECT DISTINCT p.proname::text AS name
      FROM pg_trigger t JOIN pg_constraint c ON c.contype = 'f' AND c.conrelid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND (((c.confupdtype IN ('c','n','d') OR c.confdeltype IN ('n','d')) AND t.tgtype & 16 = 16
              AND (cardinality(t.tgattr::int2[]) = 0 OR t.tgattr::int2[] && c.conkey))
          OR (c.confdeltype = 'c' AND t.tgtype & 8 = 8))
        AND NOT COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, pg_temp']`);
    expect(unpinned).toEqual([]);
    const i3 = await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER FUNCTION public."settled_agent_order_proof_immutable"() SET search_path = public, pg_temp');
      const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
      return run.violations.find((v) => v.invariant.startsWith('I3'));
    });
    expect(i3?.sample).toEqual(['search_path:settled_agent_order_proof_immutable()']);
  });
});

describe('11. the setup checks every role the runtime role can become, and a refusal changes nothing', () => {
  // The setup changes only the runtime role's own grants (and PUBLIC's
  // CREATE on the schema). A role the runtime role can become by SET ROLE,
  // directly or through other roles, keeps whatever it holds, and
  // has_*_privilege sees none of it when the membership is NOINHERIT; nor
  // does has_table_privilege see a grant on some columns only. So every
  // check applies to each such role too, and to PUBLIC, before anything
  // changes. Here the runtime role, and the role in the middle of a
  // transitive path, are NOINHERIT: only SET ROLE reaches the holder.
  const t11 = () => randomUUID().replaceAll('-', '').slice(0, 10);
  const key = () => process.env.LEDGER_APPROVAL_SIGNING_KEY!;
  const paths = ['direct', 'transitive'] as const;
  type Path = typeof paths[number];
  type Expected = string | ReturnType<typeof expect.stringContaining>;

  /** Every grant, ACL, ownership and membership the setup reads or could change, and the installed key IDs, as one text. */
  const accessSnapshot = async () => {
    const [row] = await prisma.$queryRawUnsafe<{ snapshot: string }[]>(`
      SELECT jsonb_build_object(
        'relations', (SELECT jsonb_object_agg(c.oid::regclass::text, jsonb_build_array(c.relowner::regrole::text,
                        (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(c.relacl) AS x)))
                      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace),
        'columns', (SELECT jsonb_object_agg(a.attrelid::regclass::text || '.' || a.attname::text,
                      (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(a.attacl) AS x))
                    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND cardinality(a.attacl) > 0),
        'functions', (SELECT jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_array(p.proowner::regrole::text,
                        (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) AS x)))
                      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
        'schemas', (SELECT jsonb_object_agg(n.nspname::text, jsonb_build_array(n.nspowner::regrole::text,
                      (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(n.nspacl) AS x)))
                    FROM pg_namespace n),
        'database', (SELECT jsonb_build_array(d.datdba::regrole::text,
                       (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(d.datacl) AS x))
                     FROM pg_database d WHERE d.datname = current_database()),
        'defaults', (SELECT jsonb_agg(da.defaclacl::text[] ORDER BY da.oid) FROM pg_default_acl da),
        'memberships', (SELECT jsonb_agg(m.roleid::regrole::text || ' to ' || m.member::regrole::text
                          || CASE WHEN m.admin_option THEN ' with admin' ELSE '' END
                          ORDER BY m.roleid::regrole::text, m.member::regrole::text) FROM pg_auth_members m),
        'runtimeRole', (SELECT jsonb_build_array(r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
                          r.rolbypassrls) FROM pg_roles r WHERE r.rolname = $1),
        'keys', (SELECT jsonb_agg(k."keyId" || CASE WHEN k."retiredAt" IS NULL THEN '' ELSE ' (retired)' END ORDER BY k."keyId")
                 FROM "ledger_approval_keys" k)
      )::text AS snapshot`, role);
    return row.snapshot;
  };

  /** Neither the signing key (hex in either case, or base64) nor the runtime role's password appears. */
  const expectNoSecrets = (text: string) => {
    expect(text.toLowerCase()).not.toContain(key().toLowerCase());
    expect(text).not.toContain(Buffer.from(key(), 'hex').toString('base64'));
    expect(text).not.toContain(password);
  };

  /**
   * Makes the runtime role able to become a new role, the holder, by a
   * NOINHERIT membership, directly or through a NOINHERIT role in the
   * middle; `prepare` gives the holder what the case needs and `restore`
   * puts back what it moved. Afterwards every grant, ACL, membership and
   * key is as it was.
   */
  async function withAssumableRole(path: Path, options: { attributes?: string; prepare: (holder: string) => Promise<string[]>;
    restore?: (holder: string) => string[] }, body: (holder: string) => Promise<void>) {
    const initial = await accessSnapshot();
    const t = t11();
    const holder = `playqube_holder_${t}`;
    const middle = `playqube_middle_${t}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${holder}" NOLOGIN ${options.attributes ?? ''}`);
    await prisma.$executeRawUnsafe(`CREATE ROLE "${middle}" NOLOGIN NOINHERIT`);
    await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" NOINHERIT`);
    try {
      const memberships = path === 'direct' ? [`GRANT "${holder}" TO "${role}"`]
        : [`GRANT "${holder}" TO "${middle}"`, `GRANT "${middle}" TO "${role}"`];
      for (const sql of [...memberships, ...await options.prepare(holder)]) await prisma.$executeRawUnsafe(sql);
      await body(holder);
    } finally {
      for (const sql of options.restore?.(holder) ?? []) await prisma.$executeRawUnsafe(sql);
      await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" INHERIT`);
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${holder}", "${middle}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${middle}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${holder}"`);
    }
    expect(await accessSnapshot(), 'the case leaves nothing behind').toBe(initial);
  }

  /**
   * Runs a setup that must be refused while it has something to change: a
   * key ID not yet installed, a stray grant to the runtime role (which its
   * grants function revokes) and CREATE for PUBLIC (which it revokes too).
   * It must report `expected` and leave every grant, ACL, membership and
   * key exactly as they were.
   */
  async function refusedChangingNothing(expected: Expected[],
    run: (keyId: string) => Promise<string[]> = (keyId) => applyRuntimeAccess(prisma, role, keyId, key().toLowerCase())) {
    const keyId = `k11-${t11()}`;
    await prisma.$executeRawUnsafe(`GRANT DELETE ON "wallets" TO "${role}"`);
    await prisma.$executeRawUnsafe('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      const before = await accessSnapshot();
      const failures = await run(keyId);
      expect(failures).toEqual(expect.arrayContaining(expected));
      expectNoSecrets(failures.join('\n'));
      expect(await accessSnapshot(), 'a refused setup changes nothing').toBe(before);
      const [installed] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM "ledger_approval_keys" WHERE "keyId" = $1', keyId);
      expect(installed.n).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await prisma.$executeRawUnsafe(`REVOKE DELETE ON "wallets" FROM "${role}"`);
    }
  }

  /** The owner-run script itself, JSON and text, refused: its failures, having checked its output for secrets. */
  const scriptRefused = async (keyId: string) => {
    const json = runtimeAccess({ DATABASE_URL: runtimeUrl, LEDGER_APPROVAL_KEY_ID: keyId }, ['--json']);
    expect(json.status, json.output).toBe(1);
    expectNoSecrets(json.output);
    const report = JSON.parse(json.output) as { applied: boolean; failures: string[] };
    expect(report.applied).toBe(false);
    const text = runtimeAccess({ DATABASE_URL: runtimeUrl, LEDGER_APPROVAL_KEY_ID: keyId });
    expect(text.status, text.output).toBe(1);
    expectNoSecrets(text.output);
    expect(text.output).toMatch(/Ledger runtime access NOT verified; nothing was changed:\n/);
    for (const failure of report.failures) expect(text.output).toContain(`  ${failure}\n`);
    return report.failures;
  };

  const keyTable = {
    'SELECT on the key table': {
      grant: (holder: string) => `GRANT SELECT ON "ledger_approval_keys" TO "${holder}"`,
      failure: (holder: string) => `${role} still holds SELECT on ledger_approval_keys as ${holder}, a role it can become`,
    },
    'column-only SELECT on ledger_approval_keys.secret': {
      grant: (holder: string) => `GRANT SELECT ("secret") ON "ledger_approval_keys" TO "${holder}"`,
      failure: (holder: string) => `${role} still holds SELECT on ledger_approval_keys.secret as ${holder}, a role it can become`,
    },
  };
  for (const [what, grant] of Object.entries(keyTable)) {
    for (const path of paths) {
      it(`${what}, through a ${path} NOINHERIT membership: the setup refuses it by name before changing anything, and prints no key`, async () => {
        await withAssumableRole(path, { prepare: async (holder) => [grant.grant(holder)] }, async (holder) => {
          const [seen] = await prisma.$queryRawUnsafe<{ inherited: boolean; tableLevel: boolean }[]>(
            `SELECT has_column_privilege($1, 'ledger_approval_keys', 'secret', 'SELECT') AS inherited,
                    has_table_privilege($2, 'ledger_approval_keys', 'SELECT') AS "tableLevel"`, role, holder);
          expect(seen.inherited, 'the runtime role inherits nothing').toBe(false);
          expect(seen.tableLevel, 'has_table_privilege sees a table grant only').toBe(what === 'SELECT on the key table');
          // Yet the path is real: as the holder, the runtime role reads the secret column (no row is fetched here).
          expect(await asApp([[`SET LOCAL ROLE "${holder}"`], ['SELECT length("secret") FROM "ledger_approval_keys" LIMIT 0']]))
            .toBe('accepts');
          expect(await asApp([['SELECT length("secret") FROM "ledger_approval_keys" LIMIT 0']]))
            .toMatch(/rejects: .*permission denied for table ledger_approval_keys/);
          await refusedChangingNothing([grant.failure(holder)], scriptRefused);
        });
        const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
        expect(applied.status, applied.output).toBe(0);
      });
    }
  }

  // Every other denied privilege, the same way: held by a role the runtime
  // role can become, as a table grant and, where PostgreSQL has one, as a
  // grant on one column only.
  const deniedTables: [table: string, privilege: string][] = [
    ['ledger_approval_keys', 'INSERT'], ['ledger_approval_keys', 'UPDATE'], ['ledger_approval_keys', 'DELETE'],
    ['admin_adjustment_approvals', 'INSERT'], ['admin_adjustment_approvals', 'UPDATE'], ['admin_adjustment_approvals', 'DELETE'],
    ['ledger_approval_assertions', 'INSERT'], ['ledger_approval_assertions', 'UPDATE'], ['ledger_approval_assertions', 'DELETE'],
    ['economic_operations', 'UPDATE'], ['economic_operations', 'DELETE'],
    ['coin_lot_entries', 'UPDATE'], ['coin_lot_entries', 'DELETE'],
    ['wallet_transactions', 'UPDATE'], ['wallet_transactions', 'DELETE'],
    ['agent_order_settlements', 'UPDATE'], ['agent_order_settlements', 'DELETE'],
    ['game_sessions', 'UPDATE'], ['game_sessions', 'DELETE'],
    ['legacy_balance_reviews', 'UPDATE'], ['legacy_balance_reviews', 'DELETE'],
    ['wallets', 'DELETE'], ['coin_provenance', 'DELETE'], ['coin_ledger_accounts', 'DELETE'], ['users', 'DELETE'],
    ['game_rules', 'INSERT'], ['game_rules', 'UPDATE'], ['game_rules', 'DELETE'],
    ['_prisma_migrations', 'INSERT'], ['_prisma_migrations', 'UPDATE'], ['_prisma_migrations', 'DELETE'],
    ['wallets', 'TRUNCATE'], ['economic_operations', 'TRUNCATE'], ['ledger_approval_keys', 'TRUNCATE'],
    ['economic_operations', 'TRIGGER'], ['users', 'TRIGGER'], ['ledger_approval_keys', 'TRIGGER'],
  ];
  const firstColumn = async (table: string) => (await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT a.attname::text AS name FROM pg_attribute a
     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 1`, table))[0].name;
  const ownerFunctions: [name: string, signature: string][] = [
    ['ledger_install_approval_key', '(text, bytea)'], ['ledger_retire_approval_key', '(text)'],
    ['ledger_apply_runtime_grants', '(text)'],
    ['ledger_record_assertion', '(text, text, text, text, text, numeric, text, jsonb, text, text, text)'],
  ];
  const denials: { name: string; grant: (holder: string) => Promise<string>; expected: (holder: string) => Promise<Expected[]> }[] = [
    ...deniedTables.flatMap(([table, privilege]) => [
      { name: `${privilege} on ${table}`, grant: async (holder: string) => `GRANT ${privilege} ON "${table}" TO "${holder}"`,
        expected: async (holder: string) => [`${role} still holds ${privilege} on ${table} as ${holder}, a role it can become`] },
      ...(['SELECT', 'INSERT', 'UPDATE'].includes(privilege) ? [{
        name: `${privilege} on one column of ${table}`,
        grant: async (holder: string) => `GRANT ${privilege} ("${await firstColumn(table)}") ON "${table}" TO "${holder}"`,
        expected: async (holder: string) =>
          [`${role} still holds ${privilege} on ${table}.${await firstColumn(table)} as ${holder}, a role it can become`] }] : []),
    ]),
    ...['role', 'status'].map((column) => ({ name: `UPDATE on users.${column}`,
      grant: async (holder: string) => `GRANT UPDATE ("${column}") ON "users" TO "${holder}"`,
      expected: async (holder: string) => [`${role} can still change users.${column} as ${holder}, a role it can become`] })),
    { name: 'UPDATE on users', grant: async (holder: string) => `GRANT UPDATE ON "users" TO "${holder}"`,
      expected: async (holder: string) => ['role', 'status'].map((column) =>
        `${role} can still change users.${column} as ${holder}, a role it can become`) },
    ...ownerFunctions.map(([name, signature]) => ({ name: `EXECUTE on ${name}`,
      grant: async (holder: string) => `GRANT EXECUTE ON FUNCTION "${name}"${signature} TO "${holder}"`,
      expected: async (holder: string) => [`${role} can still run ${name} as ${holder}, a role it can become`] })),
    { name: 'UPDATE on agents.id, a key other tables follow by cascade',
      grant: async (holder: string) => `GRANT UPDATE ("id") ON "agents" TO "${holder}"`,
      expected: async (holder: string) =>
        [`${role} can still change agents.id as ${holder}, a role it can become, a key other tables follow by cascade`] },
    // Refused by the grants function, after the key was installed and
    // PUBLIC's CREATE revoked: the refusal rolls both back.
    { name: 'CREATE on schema public', grant: async (holder: string) => `GRANT CREATE ON SCHEMA public TO "${holder}"`,
      expected: async (holder: string) => [expect.stringContaining(
        `runtime role ${role} can still create objects in schema public, through ${holder}:`)] },
  ];
  for (const denial of denials) {
    it(`${denial.name}, held by a role the runtime role can become (direct and transitive NOINHERIT): refused, changing nothing`, async () => {
      for (const path of paths) {
        await withAssumableRole(path, { prepare: async (holder) => [await denial.grant(holder)] }, async (holder) => {
          await refusedChangingNothing(await denial.expected(holder));
        });
      }
    });
  }

  it('a denied privilege held by PUBLIC reaches the runtime role too: refused, naming PUBLIC, changing nothing', async () => {
    const initial = await accessSnapshot();
    await prisma.$executeRawUnsafe('GRANT SELECT ("secret") ON "ledger_approval_keys" TO PUBLIC');
    await prisma.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION "ledger_install_approval_key"(text, bytea) TO PUBLIC');
    try {
      await refusedChangingNothing([`${role} still holds SELECT on ledger_approval_keys.secret through PUBLIC`,
        `${role} can still run ledger_install_approval_key through PUBLIC`]);
    } finally {
      await prisma.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION "ledger_install_approval_key"(text, bytea) FROM PUBLIC');
      await prisma.$executeRawUnsafe('REVOKE SELECT ("secret") ON "ledger_approval_keys" FROM PUBLIC');
    }
    expect(await accessSnapshot()).toBe(initial);
  });

  // Roles no runtime role may be or become, whatever their grants: refused
  // before anything changes.
  /** The database, and the owners a case moves or names, read before any case moves them. */
  const originals = async () => (await prisma.$queryRawUnsafe<{ database: string; databaseOwner: string; schemaOwner: string;
    tablesOwner: string }[]>(`
    SELECT current_database()::text AS database,
           (SELECT d.datdba::regrole::text FROM pg_database d WHERE d.datname = current_database()) AS "databaseOwner",
           (SELECT n.nspowner::regrole::text FROM pg_namespace n WHERE n.nspname = 'public') AS "schemaOwner",
           (SELECT c.relowner::regrole::text FROM pg_class c WHERE c.oid = 'public.economic_operations'::regclass) AS "tablesOwner"`))[0];
  type Originals = Awaited<ReturnType<typeof originals>>;
  const unsafe: { name: string; attributes?: string; prepare?: (holder: string, o: Originals) => string[];
    restore?: (o: Originals) => string[]; expected: (holder: string, o: Originals) => string }[] = [
    { name: 'a superuser', attributes: 'SUPERUSER', expected: (holder) => `${role} can become ${holder}, which is a superuser` },
    { name: 'a role exempt from row security', attributes: 'BYPASSRLS',
      expected: (holder) => `${role} can become ${holder}, which is exempt from row security` },
    { name: 'a role that can create roles', attributes: 'CREATEROLE',
      expected: (holder) => `${role} can become ${holder}, which is allowed to create roles (before PostgreSQL 16, `
        + 'to grant itself any role but a superuser, the tables\' owner included)' },
    { name: 'a replication role', attributes: 'REPLICATION',
      expected: (holder) => `${role} can become ${holder}, which is allowed to replicate, and so to copy every row, `
        + 'the signing key included' },
    { name: 'a role that reads the server\'s files', prepare: (holder) => [`GRANT pg_read_server_files TO "${holder}"`],
      expected: () => `${role} can become pg_read_server_files, which is allowed to run programs or read or write files `
        + 'on the database server' },
    { name: 'the database\'s owner', prepare: (holder, o) => [`ALTER DATABASE "${o.database}" OWNER TO "${holder}"`],
      restore: (o) => [`ALTER DATABASE "${o.database}" OWNER TO ${o.databaseOwner}`],
      expected: (holder, o) => `${role} can become ${holder}, which is the owner of database ${o.database}` },
    { name: 'the schema\'s owner', prepare: (holder) => [`ALTER SCHEMA public OWNER TO "${holder}"`],
      restore: (o) => [`ALTER SCHEMA public OWNER TO ${o.schemaOwner}`],
      expected: (holder) => `${role} can become ${holder}, which is the owner of schema public` },
    { name: 'the ledger tables\' owner', prepare: (holder, o) => [`GRANT ${o.tablesOwner} TO "${holder}"`],
      expected: (holder, o) => `${role} can become ${o.tablesOwner}, which is the owner of the ledger tables` },
    { name: 'the owner of a table in the schema',
      prepare: (holder) => [`CREATE TABLE public."rr11_${holder}" ("x" int)`, `ALTER TABLE public."rr11_${holder}" OWNER TO "${holder}"`],
      expected: (holder) => `${role} can become ${holder}, which is the owner of relation rr11_${holder} in schema public` },
    { name: 'the owner of a function in the schema',
      prepare: (holder) => [`CREATE FUNCTION public."rr11_${holder}"() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        `ALTER FUNCTION public."rr11_${holder}"() OWNER TO "${holder}"`],
      expected: (holder) => `${role} can become ${holder}, which is the owner of function rr11_${holder}() in schema public` },
  ];
  for (const unsafeCase of unsafe) {
    it(`a runtime role that can become ${unsafeCase.name} (direct and transitive NOINHERIT): refused before anything changes`, async () => {
      const o = await originals();
      for (const path of paths) {
        await withAssumableRole(path, { attributes: unsafeCase.attributes,
          prepare: async (holder) => unsafeCase.prepare?.(holder, o) ?? [], restore: () => unsafeCase.restore?.(o) ?? [] },
        async (holder) => { await refusedChangingNothing([unsafeCase.expected(holder, o)]); });
      }
    });
  }

  it('a runtime role that can become a superuser, through the script: refused by name, nothing changed, no key printed', async () => {
    await withAssumableRole('transitive', { attributes: 'SUPERUSER', prepare: async () => [] }, async (holder) => {
      await refusedChangingNothing([`${role} can become ${holder}, which is a superuser`], scriptRefused);
    });
    const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
    expect(applied.status, applied.output).toBe(0);
  });

  it('a runtime role that can itself create roles: refused before anything changes', async () => {
    const initial = await accessSnapshot();
    await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" CREATEROLE`);
    try {
      await refusedChangingNothing([`${role} is allowed to create roles (before PostgreSQL 16, to grant itself any role but `
        + 'a superuser, the tables\' owner included)']);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER ROLE "${role}" NOCREATEROLE`);
    }
    expect(await accessSnapshot()).toBe(initial);
  });

  it('a role it can become that holds only what the runtime role may hold: the setup applies and verifies', async () => {
    expect(await applyRuntimeAccess(prisma, role, process.env.LEDGER_APPROVAL_KEY_ID!, key().toLowerCase())).toEqual([]);
    for (const path of paths) {
      await withAssumableRole(path, { prepare: async (holder) => [`GRANT SELECT ON "wallets" TO "${holder}"`,
        `GRANT UPDATE ("displayName") ON "users" TO "${holder}"`] }, async () => {
        expect(await applyRuntimeAccess(prisma, role, process.env.LEDGER_APPROVAL_KEY_ID!, key().toLowerCase())).toEqual([]);
        const applied = runtimeAccess({ DATABASE_URL: runtimeUrl });
        expect(applied.status, applied.output).toBe(0);
        expectNoSecrets(applied.output);
      });
    }
  });
});
