const {spawn,spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {readFileSync,openSync,closeSync}=require('node:fs');
const {resolve,dirname}=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const [root]=process.argv.slice(2);
const url=new URL(process.env.DATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.port!=='55448'||url.username!=='playqube_app'||!/^\/salem_backing_[a-f0-9]{16}$/.test(url.pathname))process.exit(6);
const hex=()=>randomBytes(32).toString('hex');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function run(side,port){
 const cwd=resolve('/opt/salem',side,'apps/api');
 const r=createRequire(resolve(cwd,'package.json'));
 const lib=r('@prisma/client');
 const client=r.resolve('@prisma/client');
 const generated=dirname(createRequire(client).resolve('.prisma/client/default'));
 if(!generated.startsWith('/opt/salem/'+side+'/')||lib.Prisma.prismaVersion.client!=='5.22.0'||lib.InventoryLedgerType.MANAGER_DEPOSIT_ALLOCATION!=='MANAGER_DEPOSIT_ALLOCATION')throw Error('CLIENT_IDENTITY');
 const db=new lib.PrismaClient({datasourceUrl:url.href,log:[]});
 try{const rows=await db.$queryRaw`SELECT current_user='playqube_app' AND session_user=current_user AND NOT rolsuper AND NOT rolbypassrls AND inet_server_addr()='127.0.0.1'::inet AS ok FROM pg_roles WHERE rolname=current_user`;
 if(rows.length!==1||rows[0].ok!==true)throw Error('ROLE');}finally{await db.$disconnect();}
 console.log('SALEM_EXACT_CLIENT',side,process.version,lib.Prisma.prismaVersion.client,hash(resolve(generated,'schema.prisma')),hash(resolve(cwd,'dist/server.js')));
 const env={HOME:root,PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:url.href,
 JWT_ACCESS_SECRET:hex(),JWT_REFRESH_SECRET:hex(),LOG_PRETTY:'false',LOG_LEVEL:'warn',STORAGE_LOCAL_PATH:root+'/uploads',
 LEDGER_APPROVAL_SIGNING_KEY:process.env.LEDGER_APPROVAL_SIGNING_KEY,LEDGER_APPROVAL_KEY_ID:'fixture-rollback',
 PLAY_TOGETHER_WORKER_MODE:'external',GROUP_PVP_GAME_POINTS_ENABLED:'false',SALEM_MONITOR_ENABLED:'false'};
 const check=spawnSync(process.execPath,['dist/scripts/ledger-runtime-identity-check.js'],{cwd,env,timeout:20000,stdio:'ignore'});
 if(check.status!==0)throw Error('RUNTIME_IDENTITY_SCRIPT');
 const fd=openSync(root+'/'+side+'.log','wx',0o600);
 const child=spawn(process.execPath,['dist/server.js'],{cwd,env,stdio:['ignore',fd,fd]});
 closeSync(fd);
 let result;
 const done=new Promise(r=>{child.once('error',()=>{result={code:-1};r(result)});child.once('exit',(code,signal)=>{result={code,signal};r(result)})});
 try{
  let healthy=false;
  for(let i=0;i<60&&!result&&!healthy;i++) {
   try{const r=await fetch('http://127.0.0.1:'+port+'/health?detailed=1',{redirect:'error',signal:AbortSignal.timeout(1000)});
    healthy=r.status===200&&(await r.json()).services?.database==='ok';
   }catch{}
   if(!healthy)await sleep(250);
  }
  if(!healthy||result)throw Error('HTTP_HEALTH');
  console.log('SALEM_EXACT_HEALTH',side,200);
 }finally{
  if(!result)child.kill('SIGTERM');
  let timer;const stopped=await Promise.race([done,new Promise(r=>{timer=setTimeout(()=>r(null),20000)})]);clearTimeout(timer);
  if(!stopped){child.kill('SIGKILL');await done;throw Error('SHUTDOWN_TIMEOUT');}
  if(stopped.code!==0)throw Error('SHUTDOWN_STATUS');
  console.log('SALEM_EXACT_GRACEFUL_EXIT',side,0);
 }
}
(async()=>{await run('source',55450);await run('fallback',55449);})().catch(e=>{console.log('SALEM_EXACT_SMOKE_FAIL',/^[A-Z_]+$/.test(e?.message)?e.message:'RUNTIME_PROBE_ERROR');process.exitCode=1});

