// Usage: node evidence/member-shell-polish/concurrent.cjs apps/web <dist> <port>
// Variant of shell-qa "sportsbook-concurrent-consumers" that does not wait for the
// popup event before the second tab exists (Playwright emits popups only after
// their first navigation, which the original check's own gate holds). Synthetic data.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const [, , webDir, dir, portArg] = process.argv;
const port = Number(portArg); const origin = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const USER = { id: 'synthetic-member-a', username: 'synthetic_amina', displayName: 'Amina Synthetic',
  email: 'amina@example.invalid', isVerified: true, createdAt: '2026-01-01T00:00:00.000Z' };
(async () => {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', dir,
    '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await delay(200); }
  const browser = await chromium.launch();
  const out = [];
  try {
    for (let run = 1; run <= 3; run++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      const launches = [];
      const ok = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const key = `${route.request().method()} ${url.pathname}`;
        if (key === 'GET /api/v1/auth/me' || key === 'POST /api/v1/auth/refresh') return ok(route, { user: USER });
        if (key === 'POST /api/v1/sportsbook/launch') { launches.push(Date.now()); return ok(route, { url: 'https://provider.invalid/synthetic-sports', mode: 'real-wallet' }); }
        if (key === 'GET /api/v1/sportsbook/status') return ok(route, { balanceMinor: 12345, rewardBalanceMinor: 0, currency: 'ETB', mode: 'real-wallet', browseReady: true, liveEnabled: false, canBet: false, reason: 'not-live' });
        if (key === 'GET /api/v1/notifications') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [], meta: { unreadCount: 0 } }) });
        if (key === 'GET /api/v1/sportsbook/activity') return ok(route, []);
        if (key === 'GET /api/v1/workspaces/access') return ok(route, { admin: false, agent: false });
        if (key === 'POST /api/v1/member-rewards/activity') return ok(route, {});
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' });
      });
      await context.routeWebSocket('**/*', (s) => s.close());
      const page = await context.newPage();
      await page.goto(origin + '/sports');
      await page.getByRole('link', { name: 'Browse sports' }).waitFor();
      let waiting = 0, release; const gate = new Promise((r) => (release = r));
      await context.route(origin + '/sports/open?intent=*', async (route) => { waiting += 1; if (waiting === 2) release(); await gate; await route.fallback(); });
      const link = page.getByRole('link', { name: 'Browse sports' });
      await link.click();
      await delay(300);
      const href = await link.getAttribute('href');
      assert.match(href, /^\/sports\/open\?intent=[0-9a-f-]{36}$/);
      const second = await context.newPage();
      await second.goto(origin + href).catch(() => {});
      await delay(3000);
      const tabs = context.pages().filter((p) => p !== page);
      const manual = await Promise.all(tabs.map((t) => t.getByRole('button', { name: 'Browse sports' }).isVisible().catch(() => false)));
      const r = { run, waiting, tabs: tabs.length, launches: launches.length, manualFallback: manual.filter(Boolean).length };
      out.push(r); console.log(JSON.stringify(r));
      assert.equal(waiting, 2, 'both tabs requested the intent URL');
      assert.equal(launches.length, 1, 'at most one tab consumes the fresh intent');
      assert.equal(r.manualFallback, 1, 'the losing tab requires a fresh click');
      await context.close();
    }
    console.log('PASS concurrent-consumers variant x3');
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
  finally { await browser.close(); server.kill(); }
})();
