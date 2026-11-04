import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activationTarget,
  NUMBER_ROLE,
  PRACTICE_ENVIRONMENT,
  PRACTICE_PROJECT,
  PRACTICE_TABLES,
  provisionPractice,
  practiceDiagnostics,
  restrictKnownPublicCapabilities,
  WORKER_ROLE,
  type ActivationDb,
} from './provision.js';

const marker = 'salem-practice-activation-20261104';
const settings = () => ({
  RAILWAY_PROJECT_ID: PRACTICE_PROJECT,
  RAILWAY_ENVIRONMENT_ID: PRACTICE_ENVIRONMENT,
  RAILWAY_SERVICE_ID: 'ffe7dd49-e409-4a46-95a8-7614d2e96095',
  PRACTICE_ACTIVATION_ACK: marker,
  PRACTICE_WORKER_PASSWORD: 'a'.repeat(64),
  NUMBER_WORKER_PASSWORD: 'b'.repeat(64),
});
let db: PGlite;
let emptyDatabase: Blob;
beforeAll(async () => {
  // Reload a pristine initialized cluster to avoid PGlite's fresh-start shared
  // catalog cache bug when testing ordinary GRANT/REVOKE ON DATABASE.
  const seed = new PGlite();
  await seed.waitReady;
  emptyDatabase = await seed.dumpDataDir('gzip');
  await seed.close();
});

function adapter(connection: Pick<PGlite, 'query' | 'exec'>): ActivationDb {
  return {
    query: async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await connection.query<T>(sql, values)).rows,
    execute: (sql) => connection.exec(sql),
  };
}
const apply = (env: Record<string, string | undefined> = settings()) =>
  db.transaction((tx) => provisionPractice(adapter(tx), env));

beforeEach(async () => {
  db = new PGlite({ loadDataDir: emptyDatabase });
  await db.exec(`
    CREATE TABLE users(id text PRIMARY KEY,status text,password_hash text,role text);
    INSERT INTO users VALUES ('member','ACTIVE','private-password-hash','USER');
    CREATE TABLE wallets(id text PRIMARY KEY,balance integer);
    INSERT INTO wallets VALUES ('wallet',100);
    CREATE TABLE ledger(id text PRIMARY KEY,amount integer);
    CREATE TABLE number_practice_rounds(id text PRIMARY KEY);
    CREATE TABLE number_timed_rounds(id text PRIMARY KEY,target integer,round_number bigint);
    CREATE TABLE number_timed_entries(id text PRIMARY KEY);
    CREATE TABLE scheduled_game_streams(id text PRIMARY KEY,enabled boolean,mode text,game_key text);
    INSERT INTO scheduled_game_streams VALUES ('spin-win-practice-v1',false,'PRACTICE','spin_win');
    CREATE TABLE scheduled_game_rounds(id text PRIMARY KEY,state text,outcome jsonb,drawn_at timestamptz,mode text);
    CREATE TABLE scheduled_practice_tickets(id text PRIMARY KEY);
    ${PRACTICE_TABLES.map((table) => `CREATE TABLE public.${table}(id text PRIMARY KEY,balance integer,state text);`).join('\n')}
  `);
});
afterEach(async () => {
  await db.close();
});

async function markedWorker(extra = '') {
  await db.exec(`CREATE ROLE "${WORKER_ROLE}" LOGIN ${extra || 'NOSUPERUSER'} NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
    COMMENT ON ROLE "${WORKER_ROLE}" IS '${marker}';`);
}
async function asRole(role: string, sql: string) {
  await db.exec(`SET ROLE "${role.replaceAll('"', '""')}"`);
  try {
    return await db.exec(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}
async function unchangedWallet() {
  expect((await db.query<{ balance: number }>('SELECT balance FROM wallets')).rows).toEqual([{ balance: 100 }]);
}
async function unchanged() {
  expect(
    (await db.query<{ enabled: boolean }>('SELECT enabled FROM scheduled_game_streams')).rows
  ).toEqual([{ enabled: false }]);
  expect((await db.query<{ balance: number }>('SELECT balance FROM wallets')).rows).toEqual([
    { balance: 100 },
  ]);
}


const signedFinancialRoutines = [
  'public.ledger_adjustment_close(text,text,text,text,text,text,text)',
  'public.ledger_adjustment_execute(text,text,text,text,text,text,text)',
  'public.ledger_adjustment_first_approval(text,text,text,text,text)',
  'public.ledger_adjustment_request(text,text,numeric,text,jsonb,text,text,text,text)',
  'public.ledger_lock_economy_for_invariant_check()',
  'public.ledger_review_first_approval(text,text,jsonb,text,text,text)',
  'public.ledger_review_reopen(text,text,text,integer,text,text,text)',
  'public.ledger_review_resolve(text,text,text,text,text,text)',
] as const;
const routineCall = (signature: string) => {
  const [name, tail] = signature.split('(');
  const argumentsList = tail.slice(0, -1);
  const values: Record<string, string> = { text: "'test'", numeric: '0', integer: '0', jsonb: "'{}'::jsonb" };
  return `SELECT ${name}(${argumentsList ? argumentsList.split(',').map((type) => values[type]).join(',') : ''})`;
};

async function knownPublicCapabilities() {
  await db.exec(`
    CREATE FUNCTION public.ledger_approval_signature_valid(text,text,text,boolean) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS 'SELECT true';
    CREATE FUNCTION public.house_round_randomness_failures() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 0';
    CREATE FUNCTION public.house_public_spin_proof(text) RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT $1';
    ${signedFinancialRoutines.map(signature => `CREATE FUNCTION ${signature} RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RAISE EXCEPTION 'financial routine must not run during provisioning'; END $$;`).join('\n')}
    CREATE TABLE house_round_beacon_pins(id text);
    CREATE TABLE house_publication_requests(id text);
    CREATE TABLE house_publication_receipts(id text);
    GRANT SELECT ON house_round_beacon_pins,house_publication_requests,house_publication_receipts TO PUBLIC;
  `);
}

describe('restricted practice provisioning on real PostgreSQL semantics (PGlite)', () => {


  it('denies the migrated SECURITY DEFINER trigger escape through temporary tables', async () => {
    const migration = readFileSync(new URL('../../../../packages/database/prisma/migrations/20260924040000_ledger_function_search_path/migration.sql', import.meta.url), 'utf8');
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION "coin_allocations_guard"()');
    const endMarker = '$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;';
    const end = migration.indexOf(endMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    await db.exec(`CREATE TABLE public.coin_provenance(id text,"userId" text,amount integer);
      CREATE TABLE public.coin_allocations(id text,"provenanceId" text,"userId" text,"allocatedAmount" integer);
      INSERT INTO public.coin_provenance VALUES('known-id','private-owner',853);
      ${migration.slice(start,end+endMarker.length)}`);
    await apply();
    for (const role of [WORKER_ROLE, NUMBER_ROLE]) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege($1,'coin_provenance','SELECT') AS allowed", [role])).rows).toEqual([{ allowed: false }]);
      await expect(asRole(role, `CREATE TEMP TABLE probe(id text,"provenanceId" text,"userId" text,"allocatedAmount" integer);
        CREATE TRIGGER exploit BEFORE INSERT ON probe FOR EACH ROW EXECUTE FUNCTION public.coin_allocations_guard();
        INSERT INTO probe VALUES('probe','known-id','guessed-owner',1);`)).rejects.toThrow(/permission denied/i);
      expect((await db.query<{ create: boolean; temp: boolean; connect: boolean }>(`SELECT has_database_privilege($1,current_database(),'CREATE') AS create,
        has_database_privilege($1,current_database(),'TEMPORARY') AS temp,
        has_database_privilege($1,current_database(),'CONNECT') AS connect`,[role])).rows).toEqual([{create:false,temp:false,connect:true}]);
    }
    expect((await db.query('SELECT * FROM coin_provenance')).rows).toEqual([{id:'known-id',userId:'private-owner',amount:853}]);
    await unchangedWallet();
  });

  it.each(['CREATE','TEMPORARY'])('refuses a marked worker with explicit database %s and restores PUBLIC TEMP on rollback', async (privilege) => {
    await markedWorker();
    const [{ name }] = (await db.query<{name:string}>('SELECT current_database() AS name')).rows;
    await db.exec(`GRANT ${privilege} ON DATABASE "${name.replaceAll('"','""')}" TO "${WORKER_ROLE}"`);
    const before = await practiceDiagnostics(adapter(db));
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    expect(await practiceDiagnostics(adapter(db))).toEqual(before);
    expect((await db.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
      WHERE a.grantee=0 AND a.privilege_type='TEMPORARY') AS present FROM pg_database d WHERE datname=current_database()`)).rows).toEqual([{present:true}]);
    expect((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[NUMBER_ROLE])).rows).toEqual([]);
    await unchanged();
  });

  it('isolates known PUBLIC capabilities while preserving existing login and NOLOGIN callers', async () => {
    await knownPublicCapabilities();
    await db.exec(`CREATE ROLE "api""quoted" LOGIN NOINHERIT;
      CREATE ROLE group_reader NOLOGIN; CREATE ROLE inheriting_api LOGIN INHERIT;
      GRANT group_reader TO inheriting_api;
      GRANT SELECT ON wallets TO group_reader;
      CREATE FUNCTION unrelated_invoker() RETURNS integer LANGUAGE sql AS 'SELECT 7';
      REVOKE EXECUTE ON FUNCTION unrelated_invoker() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION unrelated_invoker() TO group_reader WITH GRANT OPTION;`);
    expect(await apply()).toMatchObject({
      restrictedWorkersReady: true,
      publicCapabilities: { functionsRestricted: 11, proofTablesRestricted: 3, databaseTempRestricted: true, callersPreserved: 4 },
    });
    for (const role of ['api"quoted', 'group_reader', 'inheriting_api']) {
      await asRole(role, 'CREATE TEMP TABLE retained_temp(id integer); DROP TABLE retained_temp;');
      expect((await db.query<{allowed:boolean}>("SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",[role])).rows).toEqual([{allowed:true}]);
      await asRole(role, `
        SELECT ledger_approval_signature_valid('a','b','c',false);
        SELECT house_round_randomness_failures(); SELECT house_public_spin_proof('round');
        SELECT * FROM house_round_beacon_pins; SELECT * FROM house_publication_requests; SELECT * FROM house_publication_receipts;`);
      for (const signature of signedFinancialRoutines) {
        await expect(asRole(role, routineCall(signature))).rejects.toThrow('financial routine must not run during provisioning');
      }
    }
    await asRole('group_reader', 'SELECT * FROM wallets; SELECT unrelated_invoker();');
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('group_reader','unrelated_invoker()','EXECUTE WITH GRANT OPTION') AS allowed")).rows).toEqual([{ allowed: true }]);
    for (const role of [WORKER_ROLE, NUMBER_ROLE]) {
      for (const sql of [
        "SELECT ledger_approval_signature_valid('a','b','c',false)",
        'SELECT house_round_randomness_failures()', "SELECT house_public_spin_proof('round')",
        'SELECT * FROM house_round_beacon_pins', 'SELECT * FROM house_publication_requests',
        'SELECT * FROM house_publication_receipts', 'SELECT * FROM wallets',
        ...signedFinancialRoutines.map(routineCall),
      ]) await expect(asRole(role, sql)).rejects.toThrow(/permission denied/i);
    }
    await unchangedWallet();
    expect(await apply()).toMatchObject({
      restrictedWorkersReady: true,
      publicCapabilities: { functionsRestricted: 0, proofTablesRestricted: 0, databaseTempRestricted: false, callersPreserved: 4 },
    });
  });

  it('rolls known PUBLIC ACL changes back when an unexpected PUBLIC financial function remains', async () => {
    await knownPublicCapabilities();
    await db.exec(`CREATE ROLE existing_api LOGIN;
      CREATE FUNCTION unknown_financial_escape() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN UPDATE wallets SET balance=999; RETURN 999; END $$;`);
    const before = await practiceDiagnostics(adapter(db));
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    expect(await practiceDiagnostics(adapter(db))).toEqual(before);
    expect((await db.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[WORKER_ROLE, NUMBER_ROLE]])).rows).toEqual([]);
    await unchanged();
  });

  it('refuses a changed caller role set and rolls its ACL changes back', async () => {
    await knownPublicCapabilities();
    const before = await practiceDiagnostics(adapter(db));
    let inserted = false;
    await expect(db.transaction(async (tx) => {
      const original = adapter(tx);
      return provisionPractice({
        query: original.query,
        execute: async (sql) => {
          await original.execute(sql);
          if (!inserted && sql.startsWith('GRANT EXECUTE')) {
            inserted = true;
            await tx.exec('CREATE ROLE unexpected_caller LOGIN');
          }
        },
      }, settings());
    })).rejects.toThrow('PRACTICE_CALLER_SET_CHANGED');
    expect(inserted).toBe(true);
    expect(await practiceDiagnostics(adapter(db))).toEqual(before);
    await unchanged();
  });

  it('refuses known PUBLIC capability cleanup without object ownership authority', async () => {
    await knownPublicCapabilities();
    await db.exec('CREATE ROLE unprivileged_api LOGIN; SET ROLE unprivileged_api');
    try {
      await expect(restrictKnownPublicCapabilities(adapter(db))).rejects.toThrow('PRACTICE_PUBLIC_CAPABILITY_REFUSED');
    } finally { await db.exec('RESET ROLE'); }
    expect((await db.query<{ present: boolean }>(`SELECT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS present
      FROM pg_proc p WHERE p.oid='ledger_approval_signature_valid(text,text,text,boolean)'::regprocedure`)).rows).toEqual([{ present: true }]);
    await unchanged();
  });


  it('diagnoses PUBLIC catalog privileges without executing functions, reading data or changing grants', async () => {
    await db.exec(`CREATE ROLE diagnostic_api LOGIN; CREATE ROLE diagnostic_operator;
      GRANT diagnostic_operator TO diagnostic_api;
      GRANT SELECT ON wallets TO PUBLIC,diagnostic_operator;
      GRANT SELECT(password_hash) ON users TO PUBLIC;
      CREATE SEQUENCE diagnostic_sequence; GRANT USAGE ON SEQUENCE diagnostic_sequence TO PUBLIC;
      CREATE SCHEMA diagnostic_schema; GRANT CREATE ON SCHEMA diagnostic_schema TO PUBLIC;
      CREATE FUNCTION public.diagnostic_escape() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN UPDATE wallets SET balance=999; RETURN 999; END $$;
      GRANT EXECUTE ON FUNCTION diagnostic_escape() TO diagnostic_operator;`);
    const statements: string[] = [];
    const diagnostic = await practiceDiagnostics({
      query: async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => {
        statements.push(sql);
        return (await db.query<T>(sql, values)).rows;
      },
    });
    expect(statements).toHaveLength(6);
    expect(statements.every((sql) => sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(diagnostic.identity).toMatchObject({ owns_database: true, superuser: true });
    expect(diagnostic.roles).toContainEqual(expect.objectContaining({ role: 'diagnostic_api', login: true }));
    expect(diagnostic.memberships).toContainEqual(expect.objectContaining({ role: 'diagnostic_operator', member: 'diagnostic_api' }));
    expect(diagnostic.publicSecurityDefinerFunctions).toContainEqual(expect.objectContaining({
      schema: 'public', name: 'diagnostic_escape', arguments: '',
      acl: expect.arrayContaining([
        expect.objectContaining({ grantee: 'PUBLIC', privilege: 'EXECUTE' }),
        expect.objectContaining({ grantee: 'diagnostic_operator', privilege: 'EXECUTE' }),
      ]),
    }));
    expect(diagnostic.publicRelationPrivileges).toContainEqual(expect.objectContaining({
      name: 'wallets', column: null, practice_table: false,
      acl: expect.arrayContaining([expect.objectContaining({ grantee: 'PUBLIC', privilege: 'SELECT' })]),
    }));
    expect(diagnostic.publicRelationPrivileges).toContainEqual(expect.objectContaining({ name: 'users', column: 'password_hash' }));
    expect(diagnostic.publicRelationPrivileges).toContainEqual(expect.objectContaining({ name: 'diagnostic_sequence', kind: 'S' }));
    expect(diagnostic.publicSchemaCreate).toContainEqual(expect.objectContaining({ schema: 'diagnostic_schema' }));
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-password-hash|UPDATE wallets|\"balance\":100|\.repeat\(64\)/);
    await unchanged();
    expect((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [WORKER_ROLE])).rows).toEqual([]);
  });

  it('provisions restricted roles atomically and enables only the practice stream', async () => {
    expect(await apply()).toMatchObject({
      databaseOwner: true,
      canCreateRole: true,
      spinEnabled: true,
      restrictedWorkersReady: true,
    });
    expect((await db.query<{ balance: number }>('SELECT balance FROM wallets')).rows).toEqual([
      { balance: 100 },
    ]);
    expect(
      (
        await db.query<{
          safe: boolean;
        }>(`SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit) AS safe
      FROM pg_roles WHERE rolname IN ('${WORKER_ROLE}','${NUMBER_ROLE}')`)
      ).rows
    ).toEqual([{ safe: true }, { safe: true }]);
  });

  it('allows required practice tick writes and narrowly scoped reads', async () => {
    await apply();
    await asRole(
      WORKER_ROLE,
      `
      SELECT id,status FROM users;
      SELECT * FROM scheduled_game_streams;
      INSERT INTO scheduled_game_rounds(id,state,mode) VALUES ('spin','OPEN','PRACTICE');
      UPDATE scheduled_game_rounds SET state='DRAWN',outcome='{"number":1}',drawn_at=now() WHERE id='spin';
      ${PRACTICE_TABLES.map((table) => `INSERT INTO ${table}(id,balance,state) VALUES ('tick',0,'OPEN'); UPDATE ${table} SET balance=1,state='DRAWN' WHERE id='tick'; SELECT * FROM ${table};`).join('\n')}
    `
    );
    await asRole(
      NUMBER_ROLE,
      `INSERT INTO number_timed_rounds(id,round_number) VALUES ('number',1); UPDATE number_timed_rounds SET target=50 WHERE id='number'; SELECT * FROM number_timed_rounds;`
    );
  });

  it('denies wallet/ledger access, destructive table operations and extra columns', async () => {
    await apply();
    for (const role of [WORKER_ROLE, NUMBER_ROLE]) {
      for (const sql of [
        'SELECT * FROM wallets',
        'UPDATE wallets SET balance=999',
        "INSERT INTO ledger VALUES ('bad',100)",
        'DELETE FROM system_dice_practice_accounts',
        'TRUNCATE number_timed_rounds',
        'DROP TABLE wallets',
      ]) {
        await expect(asRole(role, sql)).rejects.toThrow(/permission denied|must be owner/i);
      }
    }
    await expect(asRole(WORKER_ROLE, 'SELECT password_hash FROM users')).rejects.toThrow(
      /permission denied/i
    );
    await expect(asRole(WORKER_ROLE, "UPDATE users SET role='ADMIN'")).rejects.toThrow(
      /permission denied/i
    );
    await expect(
      asRole(WORKER_ROLE, 'UPDATE scheduled_game_streams SET enabled=false')
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asRole(WORKER_ROLE, "UPDATE scheduled_game_rounds SET mode='FINANCIAL'")
    ).rejects.toThrow(/permission denied/i);
    await expect(asRole(NUMBER_ROLE, 'SELECT id,status FROM users')).rejects.toThrow(
      /permission denied/i
    );
    await expect(
      asRole(NUMBER_ROLE, 'UPDATE number_timed_rounds SET round_number=2')
    ).rejects.toThrow(/permission denied/i);
  });

  it.each(['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID'])(
    'refuses a different %s before database mutation',
    async (key) => {
      const env = { ...settings(), [key]: 'wrong-target' };
      expect(() => activationTarget(env, true)).toThrow('PRACTICE_TARGET_REFUSED');
      await expect(apply(env)).rejects.toThrow('PRACTICE_TARGET_REFUSED');
      await unchanged();
      expect(
        (await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [WORKER_ROLE])).rows
      ).toEqual([]);
    }
  );

  it.each(['ack', 'short', 'equal'])(
    'refuses invalid credential setup %s atomically',
    async (kind) => {
      const env = settings();
      if (kind === 'ack') env.PRACTICE_ACTIVATION_ACK = 'wrong';
      if (kind === 'short') env.PRACTICE_WORKER_PASSWORD = 'short';
      if (kind === 'equal') env.NUMBER_WORKER_PASSWORD = env.PRACTICE_WORKER_PASSWORD;
      await expect(apply(env)).rejects.toThrow('PRACTICE_CREDENTIAL_SETUP_REFUSED');
      await unchanged();
    }
  );

  it('refuses an existing unmarked role', async () => {
    await db.exec(`CREATE ROLE "${WORKER_ROLE}" LOGIN`);
    await expect(apply()).rejects.toThrow('PRACTICE_EXISTING_ROLE_REFUSED');
    await unchanged();
  });

  it('refuses a marked role with unsafe role attributes', async () => {
    await markedWorker('SUPERUSER');
    await expect(apply()).rejects.toThrow('PRACTICE_EXISTING_ROLE_REFUSED');
    await unchanged();
  });

  it('refuses existing financial-table grants and rolls back new roles', async () => {
    await markedWorker();
    await db.exec(`GRANT SELECT ON wallets TO "${WORKER_ROLE}"`);
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    expect((await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [NUMBER_ROLE])).rows).toEqual(
      []
    );
    await unchanged();
  });

  it.each([
    'SELECT(password_hash) ON users',
    'UPDATE(role) ON users',
    'UPDATE(enabled) ON scheduled_game_streams',
  ])('refuses extra privileges on allowed support tables: %s', async (grant) => {
    await markedWorker();
    await db.exec(`GRANT ${grant} TO "${WORKER_ROLE}"`);
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    await unchanged();
  });

  it('refuses PUBLIC SECURITY DEFINER access to financial state', async () => {
    await db.exec(`CREATE FUNCTION public.financial_escape() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN UPDATE wallets SET balance=999; RETURN 999; END $$;`);
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    await unchanged();
  });

  it('refuses foreign financial grants in a non-system schema beginning with pg', async () => {
    await markedWorker();
    await db.exec(`CREATE SCHEMA pgfinancial;
      CREATE TABLE pgfinancial.wallets(id text,balance integer);
      GRANT USAGE ON SCHEMA pgfinancial TO "${WORKER_ROLE}";
      GRANT SELECT ON pgfinancial.wallets TO "${WORKER_ROLE}";`);
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    await unchanged();
  });

  it('refuses existing sequence grants', async () => {
    await markedWorker();
    await db.exec(`CREATE SEQUENCE public.financial_sequence;
      GRANT USAGE ON SEQUENCE public.financial_sequence TO "${WORKER_ROLE}";`);
    await expect(apply()).rejects.toThrow('PRACTICE_WORKER_PRIVILEGES_REFUSED');
    await unchanged();
  });

  it('handles unrelated sequences and views without treating them as granted tables', async () => {
    await db.exec(`CREATE SEQUENCE public.unrelated_sequence;
      CREATE VIEW public.unrelated_wallet_view AS SELECT * FROM wallets;`);
    expect(await apply()).toMatchObject({ restrictedWorkersReady: true });
  });
});
