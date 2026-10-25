import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function rendered() {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://dashboard-preview.invalid/' });
  for (let i=0; i<100 && !dom.window.document.querySelector('.pq-welcome'); i++) await delay();
  assert.ok(dom.window.document.querySelector('.pq-welcome'), 'compiled welcome rendered');
  return dom;
}
async function click(dom,label) {
  const button = [...dom.window.document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);
  assert.ok(button, `button ${label}`); button.click(); await delay();
}
test('welcome animation can pause and resume before entering the collection',async()=>{
  const dom=await rendered(); try {
    await click(dom,'Pause animation');
    assert.equal(dom.window.document.querySelector('.pq-welcome').classList.contains('is-paused'),true);
    await click(dom,'Resume animation');
    assert.equal(dom.window.document.querySelector('.pq-welcome').classList.contains('is-paused'),false);
    await click(dom,'Enter the lounge');
    assert.equal(dom.window.document.querySelectorAll('.pq-public-game').length,9);
  } finally {dom.window.close();}
});
test('game sign-in and registration preserve destination without collecting credentials',async()=>{
  const dom=await rendered(); try {
    await click(dom,'Enter the lounge');
    const dice=[...dom.window.document.querySelectorAll('.pq-public-game')].find(node=>node.textContent.includes('Dice'));
    assert.ok(dice); dice.click(); await delay();
    assert.match(dom.window.document.body.textContent,/Sign in to join/);
    assert.match(dom.window.document.body.textContent,/Selected destination: \/games\/dice/);
    await click(dom,'View registration step');
    assert.match(dom.window.document.body.textContent,/Create your account/);
    assert.match(dom.window.document.body.textContent,/Selected destination: \/games\/dice/);
    assert.equal(dom.window.document.querySelectorAll('input,form').length,0);
    assert.equal(dom.window.location.href,'https://dashboard-preview.invalid/');
  } finally {dom.window.close();}
});
test('group entry uses the same disconnected account gate',async()=>{
  const dom=await rendered(); try {
    await click(dom,'Enter the lounge'); await click(dom,'Find a group');
    assert.match(dom.window.document.body.textContent,/Selected destination: \/groups/);
    assert.equal(dom.window.document.querySelectorAll('input,form,a[href]').length,0);
  } finally {dom.window.close();}
});
test('preview controls have no destination on alternate activation',async()=>{
  const dom=await rendered(); try {
    const {document,MouseEvent}=dom.window;
    const enter=[...document.querySelectorAll('button')].find(node=>node.textContent.includes('Enter the lounge'));
    assert.ok(enter);
    for(const [type,button] of [['auxclick',1],['contextmenu',2]]) {
      enter.dispatchEvent(new MouseEvent(type,{button,bubbles:true,cancelable:true}));
      assert.ok(document.querySelector('.pq-welcome'));
      assert.equal(document.querySelectorAll('a[href]').length,0);
      assert.equal(dom.window.location.href,'https://dashboard-preview.invalid/');
    }
  } finally {dom.window.close();}
});
test('artifact refuses outbound requests and labels its disconnected scope',async()=>{
  const dom=await rendered(); try {
    assert.match(dom.window.document.body.textContent,/NO ACCOUNTS OR BACKEND/);
    assert.match(html,/connect-src 'none'/);
    await assert.rejects(dom.window.fetch('https://example.invalid/'),/network disabled/);
    assert.throws(()=>new dom.window.WebSocket('wss://example.invalid/'),/network disabled/);
  } finally {dom.window.close();}
});
