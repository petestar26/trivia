import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

test('preview anchors have no destinations across click, keyboard and alternate activation', async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://dashboard-preview.invalid/' });
  try {
    for (let i = 0; i < 100 && !dom.window.document.querySelector('a'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const { document, MouseEvent, KeyboardEvent } = dom.window;
    const anchors = [...document.querySelectorAll('a')];
    assert.ok(anchors.length > 10, 'actual compiled React preview rendered');
    assert.equal(document.querySelectorAll('a[href]').length, 0);
    for (const anchor of anchors) {
      assert.equal(anchor.getAttribute('aria-disabled'), 'true');
      assert.equal(anchor.href, '');
    }
    const results = anchors.find(anchor => anchor.textContent.includes('Your results'));
    assert.ok(results);
    for (const [type, options] of [
      ['click', {}], ['click', { ctrlKey: true }], ['click', { metaKey: true }],
      ['auxclick', { button: 1 }], ['contextmenu', { button: 2 }],
    ]) {
      results.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...options }));
      assert.equal(results.hasAttribute('href'), false);
    }
    results.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(document.body.textContent, /Top 10 returns/);
    assert.equal(dom.window.location.href, 'https://dashboard-preview.invalid/');
    assert.equal(document.querySelectorAll('a[href]').length, 0);
  } finally { dom.window.close(); }
});
