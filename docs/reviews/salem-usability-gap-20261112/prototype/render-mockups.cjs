const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  for (const [id, w] of [['rewards',1200],['providers',1200],['sports',1200],['account',420]]) {
    const p = await b.newPage({ viewport: { width: w, height: 600 }, deviceScaleFactor: 2 });
    await p.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
    await p.goto('file://' + path.resolve('mockups.html') + '#' + id);
    await p.locator('#' + id).screenshot({ path: path.join(process.argv[2], `proposal-${id}.jpg`), type: 'jpeg', quality: 78 });
    console.log('rendered', id); await p.close();
  }
  await b.close();
})();
