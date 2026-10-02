/** Owner-only controls for the explicitly disposable Spin staging database.
 * Never used by API or worker startup. No credential or SQL error is printed.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const STAGING_ENVIRONMENT = '7de0c716-24df-4e97-a998-ed99abfa256f';
const STAGING_DATABASE = 'playqube_spin_rehearsal_20261002';
const STAGING_HOST = 'spin-practice-db-20261002.railway.internal';
const STREAM = 'spin-win-practice-v1';
const command = process.argv[2];

function connection(): string {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('refused');
  const url = new URL(source);
  const staging = process.env.RAILWAY_ENVIRONMENT_ID === STAGING_ENVIRONMENT &&
    process.env.PRACTICE_STAGING_ACK === 'spin-practice-rehearsal-20261002' &&
    url.hostname === STAGING_HOST && url.pathname === '/' + STAGING_DATABASE;
  const ci = process.env.NODE_ENV === 'test' &&
    process.env.SCHEDULED_NATIVE_DB_ACK === 'throwaway' &&
    process.env.PRACTICE_STAGING_ACK === 'throwaway-ci' &&
    !process.env.RAILWAY_ENVIRONMENT_ID &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.pathname === '/playqube_scheduled_throwaway';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!staging && !ci)) {
    throw new Error('refused');
  }
  return source;
}

function credential(prefix: 'API' | 'WORKER') {
  const role = process.env[`PRACTICE_${prefix}_ROLE`];
  const password = process.env[`PRACTICE_${prefix}_PASSWORD`];
  if (!role || !/^spin_rehearsal_(api|worker)_[a-z0-9_]{1,32}$/.test(role) ||
      !password || !/^[0-9a-f]{64}$/.test(password)) throw new Error('refused');
  return { role, password };
}

async function safeRole(tx: Prisma.TransactionClient, role: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ exists: boolean; unsafe: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${role}) AS exists,
      EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=${role}
        AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass
            AND d.refobjid=r.oid AND d.deptype='o'))) AS unsafe`;
  if (!row || row.unsafe) throw new Error('refused');
  return row.exists;
}

async function verifyWorker(tx: Prisma.TransactionClient, role: string) {
  const [row] = await tx.$queryRaw<{ denied: boolean; required: boolean }[]>`
    SELECT
      pg_catalog.has_schema_privilege(${role},'public','CREATE') OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND (
          (pg_catalog.has_table_privilege(${role},c.oid,'SELECT') AND c.relname NOT IN ('scheduled_game_streams','scheduled_game_rounds')) OR
          (pg_catalog.has_table_privilege(${role},c.oid,'INSERT') AND c.relname <> 'scheduled_game_rounds') OR
          pg_catalog.has_table_privilege(${role},c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND (
            (pg_catalog.has_column_privilege(${role},c.oid,a.attname,'SELECT') AND c.relname NOT IN ('scheduled_game_streams','scheduled_game_rounds')) OR
            (pg_catalog.has_column_privilege(${role},c.oid,a.attname,'INSERT') AND c.relname <> 'scheduled_game_rounds') OR
            (pg_catalog.has_column_privilege(${role},c.oid,a.attname,'UPDATE') AND NOT
              (c.relname='scheduled_game_rounds' AND a.attname IN ('state','outcome','drawn_at'))) OR
            pg_catalog.has_column_privilege(${role},c.oid,a.attname,'REFERENCES'))))) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='S' AND pg_catalog.has_sequence_privilege(${role},c.oid,'USAGE,SELECT,UPDATE')) OR
      EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef AND pg_catalog.has_function_privilege(${role},p.oid,'EXECUTE')) AS denied,
      pg_catalog.has_schema_privilege(${role},'public','USAGE') AND
      pg_catalog.has_table_privilege(${role},'public.scheduled_game_streams','SELECT') AND
      pg_catalog.has_table_privilege(${role},'public.scheduled_game_rounds','SELECT') AND
      pg_catalog.has_table_privilege(${role},'public.scheduled_game_rounds','INSERT') AND
      pg_catalog.has_column_privilege(${role},'public.scheduled_game_rounds','state','UPDATE') AND
      pg_catalog.has_column_privilege(${role},'public.scheduled_game_rounds','outcome','UPDATE') AND
      pg_catalog.has_column_privilege(${role},'public.scheduled_game_rounds','drawn_at','UPDATE') AS required`;
  if (!row || row.denied || !row.required) throw new Error('refused');
}

async function setup(tx: Prisma.TransactionClient) {
  const api = credential('API');
  const worker = credential('WORKER');
  if (api.role === worker.role) throw new Error('refused');
  for (const account of [api, worker]) {
    const exists = await safeRole(tx, account.role);
    // An existing worker with excess privileges is refused, not silently repaired.
    if (exists && account === worker) await verifyWorker(tx, account.role);
    const verb = exists ? 'ALTER' : 'CREATE';
    // Both interpolated values are restricted above to identifier/hex alphabets.
    await tx.$executeRawUnsafe(`${verb} ROLE "${account.role}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS`);
  }
  await tx.$executeRaw`SELECT public.ledger_apply_runtime_grants(${api.role}::text)`;
  await tx.$executeRawUnsafe(`REVOKE ALL ON public.scheduled_game_streams, public.scheduled_game_rounds, public.scheduled_practice_tickets FROM "${api.role}"`);
  await tx.$executeRawUnsafe(`GRANT SELECT ON public.scheduled_game_streams, public.scheduled_game_rounds, public.scheduled_practice_tickets TO "${api.role}"`);
  await tx.$executeRawUnsafe(`GRANT INSERT ON public.scheduled_practice_tickets TO "${api.role}"`);
  await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${worker.role}"`);
  await tx.$executeRawUnsafe(`GRANT SELECT ON public.scheduled_game_streams, public.scheduled_game_rounds TO "${worker.role}"`);
  await tx.$executeRawUnsafe(`GRANT INSERT ON public.scheduled_game_rounds TO "${worker.role}"`);
  await tx.$executeRawUnsafe(`GRANT UPDATE (state,outcome,drawn_at) ON public.scheduled_game_rounds TO "${worker.role}"`);
  await verifyWorker(tx, worker.role);
  const [keys] = await tx.$queryRaw<{ readable: boolean }[]>`
    SELECT pg_catalog.has_table_privilege(${api.role},'public.ledger_approval_keys','SELECT') AS readable`;
  if (!keys || keys.readable) throw new Error('refused');
}

async function main() {
  if (command === '--help' && process.argv.length === 3) {
    console.log('staging-practice-owner --guard|--setup|--status|--enable|--pause');
    return;
  }
  if (process.argv.length !== 3 || !['--guard','--setup','--status','--enable','--pause'].includes(command ?? '')) {
    throw new Error('refused');
  }
  const db = new PrismaClient({ datasourceUrl: connection(), log: [] });
  try {
    const [owner] = await db.$queryRaw<{ owns: boolean }[]>`
      SELECT current_user::text = pg_catalog.pg_get_userbyid(datdba) AS owns
      FROM pg_catalog.pg_database WHERE datname=current_database()`;
    if (!owner?.owns) throw new Error('refused');
    if (command === '--setup') await db.$transaction(setup, { timeout: 25_000 });
    if (command === '--enable' || command === '--pause') {
      const changed = await db.$executeRaw`
        UPDATE public.scheduled_game_streams SET enabled=${command === '--enable'} WHERE id=${STREAM}`;
      if (changed !== 1) throw new Error('refused');
    }
    if (command === '--status') {
      const [snapshot] = await db.$queryRaw<{ enabled: boolean; rounds: unknown; tickets: number }[]>`
        SELECT s.enabled,
          COALESCE((SELECT jsonb_agg(r) FROM (SELECT id,state,outcome FROM public.scheduled_game_rounds
            WHERE stream_id=${STREAM} ORDER BY sequence DESC LIMIT 12) r),'[]'::jsonb) AS rounds,
          (SELECT count(*)::int FROM public.scheduled_practice_tickets t JOIN public.scheduled_game_rounds r
            ON r.id=t.round_id WHERE r.stream_id=${STREAM}) AS tickets
        FROM public.scheduled_game_streams s WHERE s.id=${STREAM}`;
      if (!snapshot) throw new Error('refused');
      console.log(JSON.stringify({ status: 'READY', mode: 'PRACTICE', coinsAccepted: false, ...snapshot }));
    } else console.log(JSON.stringify({ status: 'READY', action: command, coinsAccepted: false }));
  } finally {
    await db.$disconnect();
  }
}

main().catch(() => {
  console.error('{"status":"REFUSED"}');
  process.exitCode = 1;
});
