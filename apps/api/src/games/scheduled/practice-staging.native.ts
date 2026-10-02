import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { setTimeout as delay } from 'node:timers/promises';

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
const workerCli = fileURLToPath(new URL('../../../dist/scripts/scheduled-practice-worker.js', import.meta.url));
let originalPublicProcedures: { signature: string }[] = [];
let originalPublicProofReads: { name: string }[] = [];
beforeAll(async()=>{
  originalPublicProcedures = await owner.$queryRaw<{signature:string}[]>`
    SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='public' AND p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
      AND a.grantee=0 AND a.privilege_type='EXECUTE'`;
  originalPublicProofReads = await owner.$queryRaw<{name:string}[]>`
    SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE n.nspname='public' AND c.relname IN ('house_round_beacon_pins','house_publication_requests','house_publication_receipts')
      AND a.grantee=0 AND a.privilege_type='SELECT'`;
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

async function workerOnce(streamId: string) {
  const workerUrl = new URL(url!);
  workerUrl.username = workerRole;
  workerUrl.password = workerPassword;
  workerUrl.searchParams.set('connection_limit','1');
  const child = spawn(process.execPath,[workerCli,'--once',`--stream=${streamId}`],{
    env:{...process.env,DATABASE_URL:workerUrl.toString(),SCHEDULED_PRACTICE_WORKER_ENABLED:'true'},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk.toString();});
  child.stderr.on('data',chunk=>{output+=chunk.toString();});
  const deadline=setTimeout(()=>child.kill('SIGKILL'),25_000);
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{
      child.once('error',reject); child.once('close',resolve);
    });
    expect(output).not.toContain(workerPassword);
    expect(output).not.toContain(workerUrl.toString());
    return {code,output};
  } finally {clearTimeout(deadline);}
}
async function freshWorkerStream(id: string) {
  await owner.$executeRawUnsafe(`INSERT INTO public.scheduled_game_streams
    (id,game_key,rules_id,enabled,anchor_ms,betting_ms,reveal_ms,result_ms)
    VALUES ($1,'spin_win','single-zero-rtp90-v2',true,
      floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,10000,1000,1000)`,id);
}

afterAll(async()=>{
  try {
    // Restore this disposable CI fixture's original ACL before other suites run.
    for(const procedure of originalPublicProcedures) {
      await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${procedure.signature} TO PUBLIC`);
    }
    for(const relation of originalPublicProofReads) {
      await owner.$executeRawUnsafe(`GRANT SELECT ON public."${relation.name}" TO PUBLIC`);
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
    const [procedures] = await owner.$queryRaw<{worker:boolean;api:boolean;workerProof:boolean}[]>`
      SELECT has_function_privilege(${workerRole},'public.ledger_adjustment_first_approval(text,text,text,text,text)','EXECUTE') AS worker,
        has_function_privilege(${apiRole},'public.ledger_adjustment_first_approval(text,text,text,text,text)','EXECUTE') AS api,
        has_table_privilege(${workerRole},'public.house_publication_receipts','SELECT') AS "workerProof"`;
    expect(procedures).toEqual({worker:false,api:true,workerProof:false});
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


  it('admits an immutable ticket with the exact API role without round or schedule write privileges',async()=>{
    const id=`staging-api-${suffix}`;
    await freshWorkerStream(id);
    expect((await workerOnce(id)).code).toBe(0);
    const [round]=await owner.$queryRawUnsafe<{id:string;closes_ms:bigint}[]>(
      'SELECT id,closes_ms FROM public.scheduled_game_rounds WHERE stream_id=$1',id);
    const user=await owner.user.create({data:{username:`api-ticket-${suffix}`}});
    const late=await owner.user.create({data:{username:`api-late-${suffix}`}});
    const apiUrl=new URL(url!); apiUrl.username=apiRole; apiUrl.password=apiPassword;
    const runtime=new PrismaClient({datasourceUrl:apiUrl.toString(),log:[]});
    try {
      const [access]=await runtime.$queryRaw<{draw:boolean;schedule:boolean;triggerOwner:boolean}[]>`
        SELECT has_any_column_privilege(current_user,'public.scheduled_game_rounds','UPDATE') AS draw,
          has_any_column_privilege(current_user,'public.scheduled_game_streams','UPDATE') AS schedule,
          (SELECT prosecdef FROM pg_proc WHERE oid='public.scheduled_practice_ticket_guard()'::regprocedure) AS "triggerOwner"`;
      expect(access).toEqual({draw:false,schedule:false,triggerOwner:false});
      const [accepted]=await runtime.$queryRawUnsafe<{accepted_at:Date}[]>(
        "INSERT INTO public.scheduled_practice_tickets(round_id,user_id,bets) VALUES ($1,$2,'[{\"marketId\":\"red\",\"amount\":40}]'::JSONB) RETURNING accepted_at",
        round.id,user.id);
      expect(accepted.accepted_at.getTime()).toBeLessThan(Number(round.closes_ms));
      expect(await owner.scheduledPracticeTicket.count({where:{roundId:round.id}})).toBe(1);
      await expect(runtime.$executeRawUnsafe('UPDATE public.scheduled_game_rounds SET outcome=1 WHERE id=$1',round.id))
        .rejects.toMatchObject({meta:{code:'42501'}});
      await expect(runtime.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',id))
        .rejects.toMatchObject({meta:{code:'42501'}});
      await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',id);
      await expect(runtime.$executeRawUnsafe(
        "INSERT INTO public.scheduled_practice_tickets(round_id,user_id,bets) VALUES ($1,$2,'[{\"marketId\":\"red\",\"amount\":40}]'::JSONB)",round.id,late.id))
        .rejects.toMatchObject({meta:{code:'23514'}});
      const [saved]=await runtime.$queryRawUnsafe<{bets:unknown;accepted_at:Date}[]>(
        'SELECT bets,accepted_at FROM public.scheduled_practice_tickets WHERE round_id=$1 AND user_id=$2',round.id,user.id);
      expect(saved).toEqual({bets:[{marketId:'red',amount:40}],accepted_at:accepted.accepted_at});
    } finally {await runtime.$disconnect();}
  });

  it.each(['RepeatableRead','Serializable'] as const)('refuses practice ticket inserts under %s with no row persisted',async(isolationLevel)=>{
    const id=`staging-snapshot-${isolationLevel.toLowerCase()}-${suffix}`;
    await freshWorkerStream(id);
    expect((await workerOnce(id)).code).toBe(0);
    const [round]=await owner.$queryRawUnsafe<{id:string}[]>('SELECT id FROM public.scheduled_game_rounds WHERE stream_id=$1',id);
    const user=await owner.user.create({data:{username:`api-snapshot-${isolationLevel}-${suffix}`}});
    const apiUrl=new URL(url!);apiUrl.username=apiRole;apiUrl.password=apiPassword;
    const runtime=new PrismaClient({datasourceUrl:apiUrl.toString(),log:[]});
    try {
      await expect(runtime.$transaction(tx=>tx.$executeRawUnsafe(
        "INSERT INTO public.scheduled_practice_tickets(round_id,user_id,bets) VALUES ($1,$2,'[{\"marketId\":\"red\",\"amount\":40}]'::JSONB)",round.id,user.id),
        {isolationLevel})).rejects.toThrow(/could not serialize|write conflict/i);
      expect(await owner.scheduledPracticeTicket.count({where:{roundId:round.id}})).toBe(0);
    } finally {
      await runtime.$disconnect();
      await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',id);
    }
  });

  it('persists and draws with the exact setup role while direct invariant and approval calls stay denied',async()=>{
    const id=`staging-worker-${suffix}`;
    await freshWorkerStream(id);
    const first=await workerOnce(id);
    expect(first.code,first.output).toBe(0);
    const rounds=await owner.$queryRawUnsafe<{id:string;state:string;closes_ms:bigint}[]>(
      'SELECT id,state,closes_ms FROM public.scheduled_game_rounds WHERE stream_id=$1',id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].state).toBe('OPEN');
    expect(JSON.parse(first.output)).toMatchObject({created:rounds[0].id,mode:'PRACTICE',coinsAccepted:false});
    await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',id);
    await delay(Math.max(0,Number(rounds[0].closes_ms)-Date.now())+100);
    const drawn=await workerOnce(id);
    expect(drawn.code,drawn.output).toBe(0);
    expect(JSON.parse(drawn.output).drawn).toEqual([rounds[0].id]);
    const [before]=await owner.$queryRawUnsafe<{state:string;outcome:number}[]>(
      'SELECT state,outcome FROM public.scheduled_game_rounds WHERE id=$1',rounds[0].id);
    expect(before.state).toBe('DRAWN');
    expect(before.outcome).toBeGreaterThanOrEqual(0);
    expect(before.outcome).toBeLessThanOrEqual(36);
    expect((await workerOnce(id)).code).toBe(0);
    const [after]=await owner.$queryRawUnsafe<{state:string;outcome:number}[]>(
      'SELECT state,outcome FROM public.scheduled_game_rounds WHERE id=$1',rounds[0].id);
    expect(after).toEqual(before);
    const [access]=await owner.$queryRaw<{direct:boolean;triggerOwner:boolean}[]>`
      SELECT has_function_privilege(${workerRole},'public.house_round_randomness_failures()','EXECUTE') AS direct,
        (SELECT prosecdef FROM pg_proc WHERE oid='public.house_round_randomness_constraint()'::regprocedure) AS "triggerOwner"`;
    expect(access).toEqual({direct:false,triggerOwner:false});
  });

  it('does not publish a created round when a deferred commit check rolls it back',async()=>{
    const id=`staging-failure-${suffix}`;
    const fixture=`staging_commit_failure_${suffix}`;
    await freshWorkerStream(id);
    await owner.$executeRawUnsafe(`CREATE FUNCTION public."${fixture}"() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
      BEGIN RAISE EXCEPTION 'deferred commit refused fixture'; END $$`);
    try {
      await owner.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER "${fixture}"
        AFTER INSERT ON public.scheduled_game_rounds DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.stream_id='${id}') EXECUTE FUNCTION public."${fixture}"()`);
      const result=await workerOnce(id);
      expect(result.code,result.output).toBe(1);
      expect(result.output).toContain('Practice round tick failed; no result published by this tick.');
      expect(result.output).not.toContain('"created"');
      expect(await owner.$queryRawUnsafe('SELECT id FROM public.scheduled_game_rounds WHERE stream_id=$1',id)).toEqual([]);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${fixture}" ON public.scheduled_game_rounds`);
      await owner.$executeRawUnsafe(`DROP FUNCTION public."${fixture}"()`);
      await owner.$executeRawUnsafe('UPDATE public.scheduled_game_streams SET enabled=false WHERE id=$1',id);
    }
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
