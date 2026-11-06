import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.REVIEW_ORIGIN ?? 'http://127.0.0.1:57439';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Use a local preview only');
const browser = await chromium.launch({ headless: true });
const report = { synthetic: true, checks: [], errors: [], blockedWrites: [], external: [], reads: [] };
let lastPage;
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.routeWebSocket('**/*', socket => socket.close());
    lastPage = page;
    page.on('pageerror', error => report.errors.push(error.message));
    let rows = Array.from({ length: 103 }, (_, i) => ({ id: 'message-' + i, content: 'Synthetic message ' + i,
      createdAt: new Date(2026, 0, 1, 0, i).toISOString(), sender: { id: 'friend', username: 'Friend' }, reactions: [] }));
    let historyFails = true;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { report.external.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith('/ws')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', '');
      report.reads.push(path);
      const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: status === 200, data }) });
      if (path === '/auth/refresh') return send(null, 401);
      if (path === '/member-rewards/activity') return send({ earned: false, credited: 0 });
      if (!['GET', 'HEAD'].includes(request.method())) { report.blockedWrites.push(path); return send(null, 403); }
      if (path === '/auth/me') return send({ user: { id: 'preview-member', username: 'abebe', displayName: 'Abebe', role: 'USER', status: 'ACTIVE', isVerified: true } });
      if (path === '/workspaces/access') return send({ admin: false, agent: false, agentStatus: null });
      if (path === '/groups/preview/messages') {
        const before = url.searchParams.get('before');
        const end = before ? rows.findIndex(row => row.id === before) : rows.length;
        assert.ok(end >= 0, 'cursor derived from refreshed page');
        return send(rows.slice(Math.max(0, end - 50), end));
      }
      if (path.endsWith('/lifecycle')) return send({ name: 'Preview group', expiresAt: Date.now() + 86400000, serverTime: Date.now(), closed: false, archived: false });
      if (path === '/groups' || path === '/groups/inbox') return send([]);
      if (path.startsWith('/play-together/groups/')) return send({ activeRound: null, latestResult: null });
      if (path === '/games/history') return historyFails ? send(null, 503) : send([]);
      if (path.includes('unread')) return send({ count: 0, unreadCount: 0 });
      if (path.includes('notifications')) return send({ notifications: [], unreadCount: 0 });
      return send({});
    });
    await page.goto(origin + '/messages/preview', { waitUntil: 'networkidle' });
    await page.getByText('Synthetic message 102', { exact: true }).waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await page.getByText('Synthetic message 3', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await page.getByText('Synthetic message 0', { exact: true }).waitFor();
    const anchor = page.locator('[data-message-id="message-30"]');
    await anchor.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(100);
    const before = await anchor.boundingBox();
    rows[1].content = 'An older corrected message with a longer body. '.repeat(30);
    rows = rows.filter(row => row.id !== 'message-10');
    rows.push({ ...rows.at(-1), id: 'message-new', content: 'Synthetic new message while reading history' });
    await page.getByText('Synthetic new message while reading history', { exact: true }).waitFor({ timeout: 16000, state: 'attached' });
    assert.equal(await page.getByText('Synthetic message 10', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Synthetic message 1', { exact: true }).count(), 0);
    const after = await anchor.boundingBox();
    assert.ok(Math.abs(before.y - after.y) < 2, 'reader anchor moved at width ' + width + ': ' + before.y + ' -> ' + after.y);
    assert.equal(await page.locator('[data-message-id]').count(), 103);
    report.checks.push({ width, chat: 'edits/deletions/new messages reconciled', anchorBefore: before.y, anchorAfter: after.y });
    await page.goto(origin + '/games/history', { waitUntil: 'networkidle' });
    await page.getByRole('alert').filter({ hasText: 'Game history could not be loaded' }).waitFor({ timeout: 20000 });
    assert.equal(await page.getByText('No games yet. Head to the Games hub to play!', { exact: true }).count(), 0);
    historyFails = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('No games yet. Head to the Games hub to play!', { exact: true }).waitFor();
    report.checks.push({ width, history: 'failed initial request, retry and genuine empty result' });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blockedWrites, []);
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = String(error);
  report.page = { url: lastPage?.url(), text: await lastPage?.locator('body').innerText() };
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(process.env.REVIEW_OUTPUT ?? '/tmp/salem-review-repairs-browser.json', JSON.stringify(report, null, 2));
  await browser.close();
}
