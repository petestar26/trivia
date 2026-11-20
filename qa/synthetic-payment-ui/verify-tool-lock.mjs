// Networked trusted acquisition phase only; reject any unreviewed package shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => JSON.parse(readFileSync(file,'utf8'));
const pkg=read('package.json'), lock=read('package-lock.json');
assert.equal(pkg.private,true);
assert.deepEqual(pkg.dependencies,{playwright:'1.58.2',pnpm:'8.15.9'});
assert.deepEqual(pkg.scripts ?? {},{});
assert.equal(lock.lockfileVersion,3);
assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);
const pins={'playwright':'1.58.2','playwright-core':'1.58.2','fsevents':'2.3.2','pnpm':'8.15.9'};
assert.deepEqual(Object.keys(lock.packages).sort(),['',...Object.keys(pins).map(x=>'node_modules/'+x)].sort());
for(const [name,version] of Object.entries(pins)) {
  const entry=lock.packages['node_modules/'+name];
  const base='https://registry.npmjs.org/'+name;
  assert.equal(entry.version,version);
  assert.equal(entry.resolved,base+'/-/'+name+'-'+version+'.tgz');
  assert.match(entry.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.ok(!entry.link);
  const response=await fetch(base+'/'+version,{redirect:'error',signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);
  const meta=await response.json();
  assert.equal(meta.name,name);
  assert.equal(meta.version,version);
  assert.equal(meta.dist.tarball,entry.resolved);
  assert.equal(meta.dist.integrity,entry.integrity);
  assert.deepEqual(entry.dependencies ?? {},meta.dependencies ?? {});
  assert.deepEqual(entry.optionalDependencies ?? {},meta.optionalDependencies ?? {});
  assert.deepEqual(entry.bin ?? {},meta.bin ?? {});
  assert.deepEqual(entry.os ?? [],meta.os ?? []);
  assert.deepEqual(entry.engines ?? {},meta.engines ?? {});
}
