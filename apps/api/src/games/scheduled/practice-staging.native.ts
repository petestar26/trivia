import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const source = process.env.DATABASE_URL;
const url = source ? new URL(source) : null;
if (!url || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
    url.pathname !== '/playqube_scheduled_throwaway' ||
    process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') throw new Error('Throwaway database required');
const owner = new PrismaClient({ datasourceUrl: source, log: [] });
const suffix = randomUUID().replaceAll('-','').slice(0,20);
const apiRole = `spin_rehearsal_api_${suffix}`;
const workerRole = `spin_rehearsal_worker_${suffix}`;
const apiPassword = randomBytes(32).toString('hex');
const workerPassword = randomBytes(32).toString('hex');
const cli = fileURLToPath(new URL('../../../dist/scripts/staging-practice-owner.js', import.meta.url));
let originalPublicProcedures: { signature: string }[] = [];
beforeAll(async()=>{
  originalPublicProcedures = await owner.$queryRaw<{signature:string}[]>`
    SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
      AND a.grantee=0 AND a.privilege_type='EXECUTE'`;
});

async function run(command: string, override: Record<string,string | undefined> = {}) {
  const child = spawn(process.execPath,[cli,command],{
    env: { ...process.env, NODE_ENV:'test', RAILWAY_ENVIRONMENT_ID:undefined,
      PRACTICE_STAGING_ACK:'throwaway-ci', PRACTICE_API_ROLE:apiRole,
      PRACTICE_API_PASSWORD:apiPassword, PRACTICE_WORKER_ROLE:workerRole,
      PRACTICE_WORKER_PASSWORD:workerPassword, ...override },
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',resolve);
  });
  expect(output).not.toContain(apiPassword);
  expect(output).not.toContain(workerPassword);
  expect(output).not.toContain(source!);
  return {code,output};
}

afterAll(async()=>{
  try {
    // Restore this disposable CI fixture's original ACL before other suites run.
    for(const procedure of originalPublicProcedures) {
      await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${procedure.signature} TO PUBLIC`);
    }
    for(const role of [apiRole,workerRole]) {
      const [row] = await owner.$queryRaw<{ exists:boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${role}) AS exists`;
      if(row?.exists) {
        await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
        await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
      }
    }
  } finally { await owner.$disconnect(); }
});

describe('disposable staging owner CLI',()=>{
  it('refuses a missing acknowledgement and a different database before making changes',async()=>{
    expect((await run('--setup',{PRACTICE_STAGING_ACK:undefined})).code).toBe(1);
    const other = new URL(url!); other.pathname='/postgres';
    expect((await run('--setup',{DATABASE_URL:other.toString()})).code).toBe(1);
    expect((await run('--setup',{RAILWAY_ENVIRONMENT_ID:'production'})).code).toBe(1);
    const [row] = await owner.$queryRaw<{ exists:boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${apiRole} OR rolname=${workerRole}) AS exists`;
    expect(row?.exists).toBe(false);
  });

  it('provisions separate accounts, verifies least privilege and supports repeat setup',async()=>{
    const first=await run('--setup');
    const publicDefiners = first.code === 0 ? [] : await owner.$queryRaw<{name:string}[]>`
      SELECT p.oid::regprocedure::text AS name
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE n.nspname='public' AND p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`;
    const publicRelations = first.code === 0 ? [] : await owner.$queryRaw<{name:string;privilege:string}[]>`
      SELECT c.relname::text AS name,a.privilege_type AS privilege
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char",c.relowner))) a
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S') AND a.grantee=0`;
    expect(first.code, first.output + JSON.stringify({publicDefiners,publicRelations})).toBe(0);
    expect((await run('--setup')).code).toBe(0);
    const workerUrl = new URL(url!); workerUrl.username=workerRole; workerUrl.password=workerPassword;
    const runtime = new PrismaClient({datasourceUrl:workerUrl.toString(),log:[]});
    try {
      const [row] = await runtime.$queryRaw<{user:string;tickets:boolean;wallet:boolean;keys:boolean;insert:boolean;update:boolean}[]>`
        SELECT current_user AS user,
          has_table_privilege(current_user,'public.scheduled_practice_tickets','SELECT') AS tickets,
          has_table_privilege(current_user,'public.wallets','SELECT') AS wallet,
          has_table_privilege(current_user,'public.ledger_approval_keys','SELECT') AS keys,
          has_table_privilege(current_user,'public.scheduled_game_rounds','INSERT') AS insert,
          has_column_privilege(current_user,'public.scheduled_game_rounds','outcome','UPDATE') AS update`;
      expect(row).toEqual({user:workerRole,tickets:false,wallet:false,keys:false,insert:true,update:true});
    } finally { await runtime.$disconnect(); }
    const [api] = await owner.$queryRaw<{keys:boolean;draw:boolean;ticket:boolean}[]>`
      SELECT has_table_privilege(${apiRole},'public.ledger_approval_keys','SELECT') AS keys,
        has_column_privilege(${apiRole},'public.scheduled_game_rounds','outcome','UPDATE') AS draw,
        has_table_privilege(${apiRole},'public.scheduled_practice_tickets','INSERT') AS ticket`;
    expect(api).toEqual({keys:false,draw:false,ticket:true});
    const [procedures] = await owner.$queryRaw<{worker:boolean;api:boolean}[]>`
      SELECT has_function_privilege(${workerRole},'public.ledger_adjustment_first_approval(text,text,text,text,text)','EXECUTE') AS worker,
        has_function_privilege(${apiRole},'public.ledger_adjustment_first_approval(text,text,text,text,text)','EXECUTE') AS api`;
    expect(procedures).toEqual({worker:false,api:true});
  });

  it('refuses excess existing worker privileges and rolls back without exposing credentials',async()=>{
    await owner.$executeRawUnsafe(`GRANT SELECT ON public.wallets TO "${workerRole}"`);
    try {
      const result=await run('--setup');
      expect(result.code).toBe(1);
      expect(JSON.parse(result.output)).toEqual({status:'REFUSED',reason:'WORKER_TABLES'});
    } finally { await owner.$executeRawUnsafe(`REVOKE SELECT ON public.wallets FROM "${workerRole}"`); }
    expect((await run('--setup')).code).toBe(0);
  });

  it('reports only practice status and refuses arbitrary commands or credential syntax',async()=>{
    const result=await run('--status');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({mode:'PRACTICE',coinsAccepted:false});
    expect((await run('--drop')).code).toBe(1);
    expect((await run('--setup',{PRACTICE_WORKER_ROLE:'bad-role;drop'})).code).toBe(1);
    expect((await run('--setup',{PRACTICE_WORKER_PASSWORD:"password'"})).code).toBe(1);
  });
});
