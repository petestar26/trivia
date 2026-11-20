// Source-only draft for qa/synthetic-payment-ui/run.mjs. Nothing starts a server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixtureReply, ORDER_ID, ROOM_PATH } from './fixtures.mjs';

const require = createRequire(import.meta.url);
assert.ok(process.env.PLAYWRIGHT_MODULE,'explicit locked Playwright is required');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const origin = process.env.QA_ORIGIN;
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
const parsed = new URL(origin);
assert.equal(parsed.origin, origin);
assert.equal(process.platform, 'linux');
assert.equal(process.env.QA_ISOLATION_ATTESTED, 'loopback-only-static-deny-v1');
const interfaces = (await readFile('/proc/net/dev','utf8')).split('\n').slice(2)
  .filter(line=>line.includes(':')).map(line=>line.split(':')[0].trim());
assert.deepEqual(interfaces, ['lo']);
assert.equal((await readFile('/proc/net/route','utf8')).split('\n').slice(1)
  .some(line=>line.trim() && !line.startsWith('lo\t')), false);
assert.equal(Object.entries(process.env).some(([k,v])=>/^(https?|all)_proxy$/i.test(k)&&Boolean(v)),false);
assert.ok(process.env.QA_OUTPUT_DIR, 'Use a new dedicated output directory');
const output = resolve(process.env.QA_OUTPUT_DIR);
await mkdir(output, { recursive: false });
assert.ok(process.env.QA_BASELINE_ROOT,'Exact baseline checkout is required');
const repo=resolve(process.env.QA_BASELINE_ROOT);
const { build,version }=createRequire(resolve(repo,'package.json'))('esbuild');
assert.equal(version,'0.19.12');
const catalogueDir = resolve(repo,'apps/web/src/lib/i18n/catalogues');
const files = (await readdir(catalogueDir)).filter(f=>f.endsWith('.ts')).sort();
const bundle = await build({
  stdin:{contents:"export { translate } from './apps/web/src/lib/i18n/format.ts';",resolveDir:repo,loader:'ts'},
  bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',
  plugins:[{name:'pinned-static-translation-catalogue',setup(b){
    b.onLoad({filter:/[/\\]i18n[/\\]catalogue\.ts$/},()=>({
      contents:files.map((f,i)=>`import c${i} from ${JSON.stringify('./catalogues/'+f)};`).join('\n')
        +"\nimport { mergeCatalogues } from './validation'; export const catalogue=mergeCatalogues({"
        +files.map((f,i)=>`${JSON.stringify(f)}:c${i}`).join(',')+"});",
      resolveDir:resolve(catalogueDir,'..'),loader:'ts',
    }));
  }}],
});
const { translate } = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const t = (language,key,values)=>translate(language,key,values);
const reports = [];
const browser = await chromium.launch({
  headless:true,...(process.env.PAYMENT_REVIEW_BROWSER_CHANNEL?{channel:process.env.PAYMENT_REVIEW_BROWSER_CHANNEL}:{}),
});
const body = (p, txt)=>p.getByText(txt,{exact:true});
const text = async (p, txt)=>body(p,txt).first().waitFor({state:'visible'});
const button = (p,txt)=>p.getByRole('button',{name:txt,exact:true});
const heading = (p,txt)=>p.getByRole('heading',{name:txt,exact:true});
async function state(l, enabled) {
  await l.waitFor({state:'visible'});
  const end = Date.now()+4000;
  do {
    if (await l.isEnabled()===enabled) return;
    await new Promise(r=>setTimeout(r,40));
  } while (Date.now()<end);
  assert.equal(await l.isEnabled(),enabled,'button enablement');
}
async function select(p, name, value) {
  assert.match(value,/^synthetic-[a-z-]+$/);
  const target = p.locator('.payment-panel select').filter({has:p.locator('option[value="'+value+'"]')});
  await target.waitFor({state:'visible'});
  assert.equal(await target.count(),1,'exactly one fixture-backed payment select');
  const label = await target.evaluate(el => Array.from(el.closest('label').childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim());
  assert.equal(label,name,'visible payment field label');
  await target.selectOption(value);
  assert.equal(await target.inputValue(),value);
}
async function lang(p, from, to) {
  const control = p.locator('select').filter({has:p.locator('option[value="am"]')}).filter({has:p.locator('option[value="en"]')});
  assert.equal(await control.count(),1,'exactly one visible language select');
  await control.waitFor({state:'visible'});
  assert.equal(await control.inputValue(),from);
  await control.selectOption(to);
  await p.waitForFunction(code=>document.documentElement.lang===code && document.documentElement.dir===(code==='ar'?'rtl':'ltr'),to);
  assert.equal(await control.inputValue(),to);
}
async function layout(p) {
  const r = await p.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(r.scroll<=r.client+1,'document has unintended horizontal overflow');
}
async function run(name,role,width,work) {
  const result={name,role,width,unexpected:[],blockedKnown:[],errors:[],screenshots:[],status:'failed'};
  reports.push(result);
  const c=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  try {
    await c.addInitScript(()=>{localStorage.setItem('theme','dark');});
    assert.equal(typeof c.routeWebSocket,'function','requires exact audited Playwright WebSocket interception support');
    await c.routeWebSocket('**/*',ws=>{
      const u=new URL(ws.url());
      const isKnown=u.origin===origin.replace(/^http:/,'ws:') && /^\/(ws|socket\.io)\/?$/.test(u.pathname);
      (isKnown?result.blockedKnown:result.unexpected).push(isKnown?'fixture websocket blocked':'unexpected websocket blocked');
      ws.close();
    });
    await c.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url());
      if(u.origin!==origin){result.unexpected.push('external origin blocked');return route.abort();}
      const k=fixtureReply(role,req.method(),u);
      if(k.type==='static') return route.continue();
      if(k.type==='known-block'){result.blockedKnown.push(k.label);return route.abort();}
      if(k.type==='deny'){result.unexpected.push(k.label);return route.abort();}
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(k.body)});
    });
    const p=await c.newPage();
    p.setDefaultTimeout(6000);
    p.on('pageerror',e=>result.errors.push(e.name));
    const go=async url=>{
      const target=new URL(url,origin);
      assert.equal(target.origin,origin);
      await p.goto(target.href,{waitUntil:'domcontentloaded'});
    };
    const capture=async label=>{
      const name=result.name+'-'+label+'.png';
      await p.screenshot({path:resolve(output,name),fullPage:true});
      result.screenshots.push(name);
    };
    const stage = name => { result.stage = name; };
    await work({p,go,capture,stage});
    assert.deepEqual(result.unexpected,[]);
    assert.deepEqual(result.errors,[]);
    result.status='passed';
  } catch(e) {
    console.log('Synthetic case failed:', name, 'at', result.stage ?? 'case assertions');
    result.error=String(e.message).slice(0,400); // no response bodies, identities or secrets
  } finally { await c.close(); }
}
const reqTitle='Payment requirements';
const reqCopy=[
  'These limits apply to new ETB agent payment requests. Existing orders and accepted quotes keep their recorded terms.',
  'The minimum amount is included. Agent limits, available eligible balance, account verification and payment availability still apply.',
  'Crypto uses its own quoted requirements. Check that payment flow before sending funds.',
  'Casino stakes are separate from payment minimums. Provider, game, balance and responsible-gambling restrictions still apply.',
];
const req=async(p,l)=>{
  await heading(p,t(l,reqTitle)).waitFor();
  for(const k of reqCopy) await text(p,t(l,k));
  await text(p,'100 ETB');await text(p,'500 ETB');
  for(const [key,path] of [['Deposit','/wallet/deposit'],['Withdrawal','/wallet/withdraw'],['Support','/support']]){
    const link=p.locator('.payment-page').getByRole('link',{name:t(l,key),exact:true});
    assert.equal(await link.getAttribute('href'),path);
  }
};
try {
  for(const width of [320,390]) for(const l of ['am','om','ti','so','ar']) {
    await run(`requirements-${l}-${width}`,'member',width,async({p,go,capture})=>{
      await go('/payment-requirements');await req(p,'en');
      for(const key of [reqTitle,...reqCopy]) assert.notEqual(t(l,key),key,'target translation missing');
      await lang(p,'en',l);await req(p,l);await layout(p);await capture('translated');
      await p.reload({waitUntil:'domcontentloaded'});await req(p,l);
      await lang(p,l,'en');await req(p,'en');
    });
  }
  for(const [kind,floor,below,amountLabel,action] of [
    ['deposit','100.00','99.99','Amount to pay · ETB','Create deposit request'],
    ['withdraw','500.00','499.99','Amount to withdraw · ETB','Get withdrawal quote'],
  ]) await run(`threshold-${kind}`,'member',390,async({p,go,capture,stage})=>{
    const alert=kind==='deposit'?'Minimum P2P deposit is 100 ETB':'Minimum P2P withdrawal is 500 ETB';
    stage('country selector');
    await go('/wallet/'+kind);await select(p,'Country','synthetic-etb');
    stage('below minimum');
    const a=p.getByLabel(amountLabel,{exact:true});
    await a.fill(below);
    await p.getByRole('alert').filter({hasText:alert}).waitFor();
    await state(button(p,action),false);
    stage('translated below-minimum alert');
    await lang(p,'en','am');
    const translatedAmount=kind==='deposit'
      ? t('am','Amount to pay{value}',{value:' · ETB'})
      : t('am','Amount to withdraw · ETB');
    assert.equal(await p.getByLabel(translatedAmount,{exact:true}).inputValue(),below);
    await p.getByRole('alert').filter({hasText:t('am',alert)}).waitFor();
    await state(button(p,t('am',action)),false);
    await layout(p);await capture('below-floor-am');
    stage('exact minimum, prerequisites not met');
    await lang(p,'am','en');
    assert.equal(await a.inputValue(),below);
    await a.fill(floor);
    await state(button(p,action),false);
    stage('exact minimum, eligible prerequisites');
    if(kind==='deposit'){
      await select(p,'Agent','synthetic-agent');
      await select(p,'Payment method','synthetic-method-account');
      await state(button(p,action),false);
      await p.locator('.payment-check input[type=checkbox]').check();
    }else await select(p,'Payout account','synthetic-payout');
    await state(button(p,action),true); // intentionally never click
    await capture('exact-floor');
  });
  await run('legacy-order-snapshot','member',390,async({p,go,capture})=>{
    await go(ROOM_PATH);await text(p,'AG-SYNTHETIC-0001');
    await text(p,'91.25 ETB');await text(p,'92.45 ETB');await text(p,'1.23 ETB');
    await lang(p,'en','am');
    await text(p,'91.25 ETB');await text(p,'92.45 ETB');await text(p,'1.23 ETB');
    await layout(p);await capture('read-only-snapshot');
  });
  await run('admin-reference','admin',390,async({p,go,capture})=>{
    await go('/payment-requirements');await req(p,'en');
    await lang(p,'en','am'); // PR90 workspace has no language selector of its own.
    await go('/admin/pricing');
    await heading(p,t('am','Birr wallet & exchange rate')).waitFor();
    await text(p,t('am','Minimum P2P deposit is 100 ETB'));
    await text(p,t('am','Minimum P2P withdrawal is 500 ETB'));
    await text(p,t('am','{value} USDT',{value:'10.00'}));await text(p,t('am','More than {value} USDT',{value:'20.00'}));
    assert.equal(await body(p,'USD 2.00 equivalent in ETB').count(),0);
    await layout(p);await capture('regional-reference');
  });
  await run('member-admin-negative','member',390,async({p,go,capture})=>{
    await go('/admin/pricing');
    await heading(p,'Administrator access required').waitFor();
    assert.equal(await heading(p,'Birr wallet & exchange rate').count(),0);
    await capture('denied');
  });
} finally {
  await browser.close();
  await writeFile(resolve(output,'synthetic-payment-ui.json'),JSON.stringify({synthetic:true,order:ORDER_ID,reports},null,2));
}
assert.equal(reports.length,15);
assert.equal(reports.filter(x=>x.status==='passed').length,15,'one or more cases failed; inspect the preserved JSON');
