import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { SystemPracticeHealth, listenSystemPracticeHealth } from './system-practice-worker-runtime.js';

const exec=promisify(execFile);
let directory:string,script:string;
beforeAll(async()=>{
  directory=await mkdtemp(join(tmpdir(),'system-practice-inert-')); script=join(directory,'worker.mjs');
  const result=await build({
    entryPoints:[fileURLToPath(new URL('./system-practice-worker.ts',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'node',target:'node20',packages:'external',
    external:['@prisma/client','./system-practice-worker-services.js'],
  });
  await writeFile(script,result.outputFiles[0].contents);
});
afterAll(async()=>{await rm(directory,{recursive:true,force:true});});

describe('native local process controls without adapter, packages or database',()=>{
  it('compiled help works without the adapter or a database environment',async()=>{
    const result=await exec(process.execPath,[script,'--help'],{env:{PATH:process.env.PATH},timeout:3000});
    expect(result.stdout).toContain('six system-practice family flags'); expect(result.stderr).toBe('');
  });
  it('compiled import is inert without the adapter or database environment',async()=>{
    const result=await exec(process.execPath,['--input-type=module','--eval',`await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('INERT')`],{env:{PATH:process.env.PATH},timeout:3000});
    expect(result.stdout.trim()).toBe('INERT'); expect(result.stderr).toBe('');
  });
  it.each([{}, {SYSTEM_PRACTICE_WORKER_ENABLED:'true'}])('compiled disabled admission refuses promptly without loading an absent adapter (%j)',async extra=>{
    let error:any;
    try {await exec(process.execPath,[script],{env:{PATH:process.env.PATH,...extra},timeout:3000});}catch(value){error=value;}
    expect(error.code).toBe(1); expect(error.stderr.trim()).toBe('{"event":"SYSTEM_PRACTICE_ADMISSION_REFUSED"}');
    expect(error.killed).toBe(false);
  });
  it('an admitted but unavailable adapter produces only sanitized terminal events',async()=>{
    let error:any;
    try {await exec(process.execPath,[script],{env:{PATH:process.env.PATH,SYSTEM_PRACTICE_WORKER_ENABLED:'true',SKY_CRASH_PRACTICE_ENABLED:'true',DATABASE_URL:'postgresql://restricted:private@127.0.0.1:9/unused'},timeout:3000});}catch(value){error=value;}
    expect(error.code).toBe(1); expect(error.stderr).toContain('SYSTEM_PRACTICE_START_FAILED'); expect(error.stderr).toContain('"cleanup":"UNCONFIRMED"');
    expect(error.stderr).not.toMatch(/ERR_MODULE|worker\.mjs|private|postgresql|stack/);
  });
});

describe('native loopback health transport; no service factories or ticks',()=>{
  it('GET/HEAD and failing readiness reflect each enabled family; other paths/methods reject',async()=>{
    const health=new SystemPracticeHealth(['SKY_CRASH','SYSTEM_DICE']);
    const server=await listenSystemPracticeHealth(health,0);
    const address=server.address(); if(!address||typeof address==='string') throw new Error('LOCAL_ADDRESS_MISSING');
    const url=`http://127.0.0.1:${address.port}`;
    const request=(path='/health',method='GET')=>fetch(url+path,{method,headers:{connection:'close'}});
    try {
      expect((await request()).status).toBe(503); health.succeeded('SKY_CRASH'); expect((await request()).status).toBe(503);
      health.succeeded('SYSTEM_DICE'); const ready=await request(); expect(ready.status).toBe(200); expect(ready.headers.get('cache-control')).toBe('no-store');
      const snapshot=await ready.json() as {families:{family:string;status:string}[]};
      expect(snapshot.families).toEqual([{family:'SKY_CRASH',status:'OK'},{family:'SYSTEM_DICE',status:'OK'}]);
      const head=await request('/health','HEAD'); expect(head.status).toBe(200); expect(await head.text()).toBe('');
      health.failed('SKY_CRASH'); expect((await request()).status).toBe(503);
      expect((await request('/health','POST')).status).toBe(405); expect((await request('/health?x=1')).status).toBe(404);
      health.stop(); expect((await request()).status).toBe(503);
    } finally {await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
  });
});
