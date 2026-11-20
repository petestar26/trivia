// Same-job receipt producer. No remote/cache attestation or arbitrary supplied dist.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { BASELINE: root, HARNESS: harness, STORE: store, QA_BUILD_ATTESTATION: receipt }=process.env;
assert.equal(process.env.QA_ISOLATION_ATTESTED,'loopback-only-static-deny-v1');
assert.ok(root && harness && store && receipt && existsSync(store));
const head='9cf32da8bd7d8b9a5a0bbe6077210d0e1b79dc18';
const tree='18cacd832ad2a3bfdac5b26a5be80db1ecdd5278';
const lock='ad42d49852ba70bad961cd109d881779a5986a944bcd30f04e3303c6c42e307a';
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),head);
assert.equal(git('rev-parse','HEAD^{tree}'),tree);
assert.equal(git('status','--porcelain'),'');
assert.equal(sha(readFileSync(join(root,'pnpm-lock.yaml'))),lock);
assert.equal(process.versions.node,'20.20.2');
const pins=JSON.parse(readFileSync(join(harness,'PR90-SOURCE-INPUTS.json')));
assert.equal(pins.sourceCommit,head);
for(const [path,pin] of Object.entries(pins.hashes)) {
  assert.equal(git('rev-parse','HEAD:'+path),pin.gitBlob);
  assert.equal(sha(readFileSync(join(root,path))),pin.sha256);
}
for(const folder of ['.','apps/web']) {
  assert.ok(!readdirSync(join(root,folder)).some(n=>/^\.env(?:\.|$)/.test(n)&&n!=='.env.example'));
}
const dist=join(root,'apps/web/dist');
assert.ok(!existsSync(dist),'refuse existing dist');
const pnpm=join(harness,'node_modules/.bin/pnpm');
const env={...process.env,VITE_API_URL:'',VITE_API_PROXY:'true'};
assert.equal(execFileSync(pnpm,['--version'],{cwd:root,env,encoding:'utf8'}).trim(),'8.15.9');
const call=args=>execFileSync(pnpm,args,{cwd:root,env,stdio:'inherit'});
call(['--filter','.','--filter','web...','install','--offline','--frozen-lockfile','--ignore-scripts','--store-dir',store]);
call(['--filter','@socialplay/shared','build']);
call(['--filter','web','build']);
assert.equal(git('status','--porcelain','--untracked-files=no'),'');
const files=Object.create(null);
function collect(folder='') {
  for(const entry of readdirSync(join(dist,folder),{withFileTypes:true})) {
    const p=folder+entry.name;
    if(entry.isDirectory()) collect(p+'/');
    else {
      assert.ok(entry.isFile(),'only regular output files');
      const bytes=readFileSync(join(dist,p));
      files[p]={size:bytes.length,sha256:sha(bytes)};
    }
  }
}
collect();
writeFileSync(receipt,JSON.stringify({
  sourceCommit:head,sourceTree:tree,pnpmLockSha256:lock,node:process.versions.node,pnpm:'8.15.9',
  frozenOfflineBuild:true,publicApiOrigin:'',files,
}),{flag:'wx'});
