// Stages the exact already-built web output, never builds or downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

assert.equal(process.argv.length,6,'expected --source BASE --output STATIC');
assert.deepEqual([process.argv[2],process.argv[4]],['--source','--output']);
assert.ok(process.env.QA_BUILD_ATTESTATION,'No same-job isolated build receipt supplied');
const head='9cf32da8bd7d8b9a5a0bbe6077210d0e1b79dc18';
const lock='ad42d49852ba70bad961cd109d881779a5986a944bcd30f04e3303c6c42e307a';
const input=resolve(process.argv[3]),out=resolve(process.argv[5]),dist=resolve(input,'apps/web/dist');
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(execFileSync('git',['-C',input,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),head);
assert.equal(execFileSync('git',['-C',input,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}),'');
assert.equal(sha(await readFile(resolve(input,'pnpm-lock.yaml'))),lock);
const at=JSON.parse(await readFile(process.env.QA_BUILD_ATTESTATION,'utf8'));
assert.equal(at.sourceCommit,head);
assert.equal(at.sourceTree,'18cacd832ad2a3bfdac5b26a5be80db1ecdd5278');
assert.equal(at.pnpmLockSha256,lock);
assert.equal(at.node,'20.20.2');
assert.equal(at.pnpm,'8.15.9');
assert.equal(at.frozenOfflineBuild,true);
assert.equal(at.publicApiOrigin,'');
assert.ok(at.files && typeof at.files==='object');
const map=new Map(Object.entries(at.files));
assert.ok(map.has('index.html')&&[...map.keys()].some(p=>/^assets\/.+\.js$/.test(p)));
assert.ok(!out.startsWith(dist+'/')&&out!==dist);
await mkdir(out,{recursive:false});
async function copy(folder=''){
  for(const item of await readdir(resolve(dist,folder),{withFileTypes:true})){
    assert.match(item.name,/^[A-Za-z0-9_. @+~-]+$/);
    assert.ok(item.name!=='.'&&item.name!=='..'&&!/^\.env(?:\.|$)/.test(item.name));
    const source=folder+item.name;
    assert.ok(!/^(api|sg|graphql|ws|socket\.io)(\/|$)/i.test(source));
    if(item.isDirectory()){await copy(source+'/');continue;}
    assert.ok(item.isFile(),'refuse non-regular static file');
    const pin=map.get(source),bytes=await readFile(resolve(dist,source));
    assert.ok(pin&&pin.size===bytes.length&&pin.sha256===sha(bytes),'dist manifest mismatch');
    map.delete(source);
    const to=resolve(out,source);
    await mkdir(dirname(to),{recursive:true});
    await writeFile(to,bytes,{flag:'wx'});
  }
}
await copy();
assert.equal(map.size,0,'attested output missing files');
console.log(JSON.stringify({staticFixtureBuild:true,sourceCommit:head,files:Object.keys(at.files).length}));
