import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const workerSource=await readFile(new URL('./public/assets/worker-probe-A.js',import.meta.url),'utf8');
const pageSource=await readFile(new URL('./public/assets/page-probe.js',import.meta.url),'utf8');
test('worker probe only acknowledges SKIP_WAITING and reports activation start',async()=>{
 const listeners={};const received=[];const broadcast=[];
 vm.runInNewContext(workerSource,{self:{addEventListener:(n,fn)=>listeners[n]=fn,clients:{matchAll:async()=>[{postMessage:v=>broadcast.push(v)}]}}});
 listeners.message({data:{type:'OTHER'},source:{postMessage:v=>received.push(v)}});assert.equal(received.length,0);
 listeners.message({data:{type:'SKIP_WAITING'},source:{postMessage:v=>received.push(v)}});assert.equal(received[0].event,'skip-received');assert.equal(received[0].build,'probe-A');
 listeners.activate({});await new Promise(r=>setImmediate(r));assert.equal(broadcast[0].event,'activate-start');
 assert.equal(broadcast.some(v=>v.event==='activate-end'),false);
});
test('page timeline captures clicks and real worker states without financial data or writes',async()=>{
 const dom=new JSDOM('<title>Probe</title><button>Reload app</button><input value="private draft">',{url:'https://test.example/games/crash-point',runScripts:'outside-only'});
 const w=dom.window;const sw=new w.EventTarget();sw.state='installed';sw.scriptURL='https://test.example/sw.js';
 const container=new w.EventTarget();container.controller=null;const reg=new w.EventTarget();reg.waiting=sw;reg.active=null;reg.installing=null;
 container.getRegistration=async()=>reg;Object.defineProperty(w.navigator,'serviceWorker',{value:container});
 w.eval(pageSource);await new Promise(r=>setImmediate(r));
 w.document.querySelector('button').click();sw.state='activated';sw.dispatchEvent(new w.Event('statechange'));container.controller=sw;container.dispatchEvent(new w.Event('controllerchange'));
 const rows=JSON.parse(w.sessionStorage.getItem('playqube.pwa.probe.timeline'));
 assert.ok(rows.some(v=>v.event==='click'&&v.action==='Reload app'));assert.ok(rows.some(v=>v.event==='worker-state'&&v.worker.state==='activated'));assert.ok(rows.some(v=>v.event==='controllerchange'));assert.ok(!JSON.stringify(rows).includes('private draft'));
 await new Promise(r=>setImmediate(r));dom.window.close();
});
