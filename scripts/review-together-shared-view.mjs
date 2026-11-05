// Synthetic multi-client UI acceptance only. Each browser has its own mocked
// identity, but all three read the same canonical round and server clock.
// No real account, signed proof, wallet or production endpoint is contacted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
  togetherRosterHash,
  rankTogether,
  settleTogether,
} from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.TOGETHER_REVIEW_ORIGIN ?? 'http://127.0.0.1:57426';
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only a loopback preview is allowed');
const output = resolve(
  process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-shared-view-review'
);
await mkdir(output, { recursive: true });
const checks = [],
  errors = [],
  writes = [],
  activityPings = [],
  visualChecks = [];
const browser = await chromium.launch({ headless: true });
const settings = {
  version: 2,
  feeBps: 700,
  minEntry: 100,
  maxEntry: 100000,
  enabledGames: TOGETHER_GAMES.map((g) => g.key),
  practiceEnabled: true,
  cashEnabled: false,
  publicRoomsEnabled: false,
};

async function eventually(action, description, timeout = 10000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      await action();
      return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(description + ': ' + (last?.message ?? 'timed out'));
}

try {
  for (const width of [1440, 390]) {
    const groupId = `shared-group-${width}`,
      roundId = `shared-round-${width}`;
    const users = [
      { id: 'shared-owner', username: 'Abebe', displayName: 'Abebe Bekele' },
      { id: 'shared-member', username: 'Tigist', displayName: 'Tigist Alemu' },
      { id: 'shared-spectator', username: 'Dawit', displayName: 'Dawit Tesfaye' },
    ].map((user) => ({
      ...user,
      email: user.id + '@example.invalid',
      role: 'USER',
      status: 'ACTIVE',
      isVerified: true,
    }));
    const group = { id: groupId, name: 'Addis Friends', ownerId: users[0].id, status: 'ACTIVE' };
    const closesAt = Date.now() + 120000,
      paidAt = closesAt + 10000;
    let offset = 0;
    const clock = () => Date.now() + offset;
    const setClock = (time) => {
      offset = time - Date.now();
    };
    const tickets = [
      { id: 'entry-owner', userId: users[0].id, selection: [1, 2, 3, 4, 5] },
      { id: 'entry-member', userId: users[1].id, selection: [6, 7, 8, 9, 10] },
    ];
    const outcome = {
      numbers: [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    };
    const ranking = rankTogether('roulette_keno', tickets, outcome);
    const settlement = settleTogether(1000, 700, ranking, roundId);
    assert.equal(settlement.refunds, false);
    const round = {
      id: roundId,
      groupId,
      creatorId: users[0].id,
      groupName: group.name,
      game: 'roulette_keno',
      currency: 'GAME_POINTS',
      entryAmount: 1000,
      feeBps: 700,
      settingsVersion: 2,
      minPlayers: 2,
      maxPlayers: 20,
      closesAt,
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: 'ab'.repeat(32),
      beaconRound: 1,
      state: 'OPEN',
      termsHash: '',
      rosterHash: null,
      outcome: null,
      ranking: [],
      settlement: null,
      voidReason: null,
      proof: null,
      recoveryDeadline: closesAt + 600000,
      paidAt: null,
      entries: tickets.map((entry, i) => ({
        ...entry,
        username: users[i].username,
        state: 'ACCEPTED',
        amount: 1000,
        payout: null,
        createdAt: closesAt - 60000,
        walletTransactionId: 'hold-' + entry.id,
        payoutTransactionId: null,
        requestId: null,
      })),
    };
    round.termsHash = togetherTermsHash(round);
    const summary = () => ({
      id: roundId,
      groupId,
      groupName: group.name,
      game: round.game,
      currency: round.currency,
      entryAmount: round.entryAmount,
      feeBps: round.feeBps,
      state: round.state,
      closesAt,
      participants: 2,
      createdAt: closesAt - 120000,
      paidAt: round.paidAt,
    });
    const clients = [];
    for (const [index, user] of users.entries()) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const client = { page, context, index, user, offline: false };
      clients.push(client);
      page.on('pageerror', (error) =>
        errors.push({ width, user: user.id, message: error.message })
      );
      await page.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/ws')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const path = url.pathname.replace('/api/v1', ''),
          method = request.method();
        // The site's existing daily-activity hook is independent of group play.
        // Record it separately; it neither confirms an entry nor debits a wallet.
        if (path === '/member-rewards/activity' && method === 'POST') {
          activityPings.push({ width, user: user.id });
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: { earned: false, credited: 0 } }),
          });
        }
        if (method !== 'GET') {
          writes.push({ width, user: user.id, path, method });
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'Watching never writes' }),
          });
        }
        if (client.offline && path.startsWith('/play-together/'))
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, error: 'Synthetic connection loss' }),
          });
        const paid = round.state === 'PAID';
        const own = round.entries.find((entry) => entry.userId === user.id);
        const balances = {
          cashAvailable: 0,
          cashReserved: 0,
          pointsAvailable: index === 2 ? 0 : 9000 + (paid ? (own?.payout ?? 0) : 0),
          pointsReserved: index === 2 || paid ? 0 : 1000,
        };
        let data = {};
        if (path === '/auth/me') data = { user };
        else if (path === '/workspaces/access')
          data = { admin: false, agent: false, agentStatus: null };
        else if (path === `/play-together/groups/${groupId}/activity`)
          data = {
            serverTime: clock(),
            activeRound: paid ? null : summary(),
            latestResult: paid ? summary() : null,
          };
        else if (path === '/play-together/')
          data = {
            serverTime: clock(),
            workerReady: true,
            admissionsEnabled: true,
            settings,
            cashAvailable: false,
            balances,
            group: url.searchParams.get('groupId') === groupId ? group : null,
            groups: [group],
            legacyPending: false,
            rounds: [summary()],
          };
        else if (path === `/play-together/rounds/${roundId}`)
          data = {
            serverTime: clock(),
            workerReady: true,
            admissionsEnabled: true,
            settings,
            cashAvailable: false,
            balances,
            round: {
              ...round,
              entries: round.entries.map((entry) => ({
                ...entry,
                selection:
                  round.state !== 'OPEN' || entry.userId === user.id ? entry.selection : null,
                walletTransactionId: entry.userId === user.id ? entry.walletTransactionId : '',
                payoutTransactionId: entry.userId === user.id ? entry.payoutTransactionId : null,
              })),
            },
          };
        else if (path === `/groups/${groupId}/lifecycle`)
          data = {
            name: group.name,
            expiresAt: closesAt + 86400000,
            serverTime: clock(),
            closed: false,
            archived: false,
            canModerate: index === 0,
          };
        else if (path === `/groups/${groupId}/messages`) data = [];
        else if (path === '/groups/inbox')
          data = [
            {
              ...group,
              isPrivate: true,
              closed: false,
              memberCount: 3,
              lastMessage: null,
              lastType: null,
              lastMessageAt: null,
            },
          ];
        else if (path === `/groups/${groupId}`)
          data = {
            ...group,
            isMember: true,
            isPrivate: true,
            memberCount: 3,
            memberRole: index === 0 ? 'OWNER' : 'MEMBER',
            owner: users[0],
          };
        else if (path.startsWith(`/groups/${groupId}/`)) data = [];
        else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
        else if (path.includes('notifications')) data = { notifications: [], unreadCount: 0 };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      });
    }
    const [owner, member, spectator] = clients;
    const resultView = (client) => client.page.locator('.tg-result[data-reveal-phase]');
    const readTimeline = (client) =>
      resultView(client).evaluate((node) => ({
        phase: node.dataset.revealPhase,
        mode: node.dataset.revealMode,
        progress: Number(node.dataset.revealProgress),
      }));
    async function capture(client, name) {
      const dimensions = await client.page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert(dimensions.scroll <= width + 1, `${name} overflows at ${width}`);
      await client.page.screenshot({
        path: resolve(output, `${name}-${client.index}-${width}.png`),
        fullPage: true,
      });
      if (width < 560)
        await client.page.screenshot({
          path: resolve(output, `${name}-${client.index}-${width}-viewport.png`),
          fullPage: false,
        });
    }
    await owner.page.goto(origin + `/groups/${groupId}/games`);
    await owner.page.getByRole('region', { name: 'Your group rounds' }).waitFor();
    const doorway = await owner.page
      .getByRole('region', { name: 'Your group rounds' })
      .boundingBox();
    const catalogue = await owner.page.locator('.together-catalogue').boundingBox();
    assert(doorway.y < catalogue.y, 'Shared room must precede game catalogue');
    const circles = await owner.page.locator('.together-journey b').evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      })
    );
    assert.equal(circles.length, 3);
    assert(
      circles.every(
        (circle) => Math.abs(circle.width - 28) < 0.5 && Math.abs(circle.height - 28) < 0.5
      )
    );
    const activeTab = await owner.page
      .getByRole('navigation', { name: 'Group sections' })
      .getByRole('link', { name: 'Games', exact: true })
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      });
    assert.equal(activeTab.color, 'rgb(255, 255, 255)');
    const luminance = (color) => {
      const values = color
        .match(/\d+/g)
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const contrast = 1.05 / (luminance(activeTab.background) + 0.05);
    assert(contrast >= 4.5, 'Active Games tab needs readable text contrast');
    visualChecks.push({ width, circles, activeTab, contrast });
    await capture(owner, 'owner-discovery');
    await member.page.goto(origin + `/messages/${groupId}`);
    await member.page.getByRole('link', { name: 'Watch or join round', exact: true }).waitFor();
    await capture(member, 'chat-discovery');
    await Promise.all([
      owner.page.goto(origin + `/play-together/rounds/${roundId}`),
      member.page.getByRole('link', { name: 'Watch or join round', exact: true }).click(),
      spectator.page.goto(origin + `/play-together/rounds/${roundId}`),
    ]);
    for (const client of clients) {
      await client.page.getByRole('heading', { name: 'Roulette Keno.', exact: true }).waitFor();
      assert.equal(await client.page.locator('.tg-result').count(), 0, 'No early outcome display');
      assert.equal(
        await client.page.getByText('Selection sealed', { exact: true }).count(),
        client.index === 2 ? 2 : 1,
        'Viewers cannot read another player’s choice before closure'
      );
    }
    await spectator.page.getByText(/You’re watching\. No entry has been charged/).waitFor();
    assert.equal(
      await spectator.page
        .getByRole('button', { name: 'Confirm 1,000 points entry', exact: true })
        .isDisabled(),
      true
    );
    assert.equal(writes.length, 0);
    checks.push({
      width,
      check: 'Owner/member discovery and free zero-balance spectator access; no entry writes',
    });

    round.state = 'LOCKED';
    round.rosterHash = togetherRosterHash(tickets);
    setClock(closesAt + 1000);
    for (const client of clients)
      await client.page
        .getByRole('heading', { name: 'Getting the shared result ready', exact: true })
        .waitFor();
    await spectator.page.getByRole('heading', { name: 'You’re watching', exact: true }).waitFor();
    assert.equal(writes.length, 0);
    checks.push({
      width,
      check: 'All three clients close entry controls from the same server deadline',
    });

    // The member leaves during settlement, then opens the saved round later.
    await member.page.goto(origin + `/groups/${groupId}/games`);
    round.state = 'PAID';
    round.paidAt = paidAt;
    round.outcome = outcome;
    round.ranking = ranking;
    round.settlement = settlement;
    round.entries = round.entries.map((entry) => ({
      ...entry,
      state: 'SETTLED',
      payout: settlement.payouts.find((p) => p.entryId === entry.id).amount,
      payoutTransactionId: 'paid-' + entry.id,
    }));
    setClock(paidAt + 100);
    await resultView(owner).waitFor();
    await resultView(spectator).waitFor();
    setClock(paidAt + 6500);
    await member.page.goto(origin + `/play-together/rounds/${roundId}`);
    await resultView(member).waitFor();
    await eventually(async () => {
      const states = await Promise.all(clients.map(readTimeline));
      for (const state of states) {
        assert.equal(state.phase, 'revealing');
        assert.equal(state.mode, 'shared');
        assert(state.progress >= 0.2 && state.progress < 1);
      }
      assert(
        Math.max(...states.map((s) => s.progress)) - Math.min(...states.map((s) => s.progress)) <
          0.12
      );
    }, 'Staggered clients catch up to the canonical reveal');
    await capture(spectator, 'shared-reveal');
    checks.push({
      width,
      check: 'Staggered owner/member/spectator views follow one server-timed reveal',
    });

    await owner.page.getByRole('button', { name: 'Show final result', exact: true }).click();
    assert.equal((await readTimeline(owner)).mode, 'final');
    assert.equal((await readTimeline(member)).mode, 'shared');
    assert.equal((await readTimeline(spectator)).mode, 'shared');
    await owner.page.getByRole('button', { name: 'Rejoin shared reveal', exact: true }).click();
    await eventually(
      async () => assert.equal((await readTimeline(owner)).mode, 'shared'),
      'Owner rejoins shared reveal'
    );
    checks.push({
      width,
      check: 'Show final result is local and does not restart or alter other members’ view',
    });

    spectator.offline = true;
    await spectator.page.getByRole('alert').filter({ hasText: 'Reconnecting' }).waitFor();
    assert.equal(
      await spectator.page.getByRole('progressbar', { name: 'Shared reveal progress' }).count(),
      0
    );
    assert.equal(writes.length, 0);
    spectator.offline = false;
    setClock(paidAt + 10000);
    await eventually(async () => {
      const state = await readTimeline(spectator);
      assert.equal(state.mode, 'shared');
      assert.equal(state.phase, 'revealing');
      assert(state.progress >= 0.5);
    }, 'Reconnected spectator catches up rather than restarting');
    checks.push({
      width,
      check: 'Connection loss stops shared progress; reconnect catches up without an entry',
    });

    setClock(paidAt + 20000);
    await eventually(async () => {
      for (const state of await Promise.all(clients.map(readTimeline))) {
        assert.equal(state.phase, 'complete');
        assert.equal(state.progress, 1);
      }
    }, 'All clients reach the permanent final result');
    for (const client of clients) {
      assert.deepEqual(
        await client.page.locator('.tg-result-balls li > span').allTextContents(),
        outcome.numbers.map(String)
      );
      await client.page.locator('#group-results').waitFor();
      await capture(client, 'final');
    }
    const rosters = await Promise.all(
      clients.map(async (client) =>
        (await client.page.locator('.together-participants').innerText())
          .replaceAll(' · You', '')
          .replace(/\s+/g, ' ')
      )
    );
    assert.equal(new Set(rosters).size, 1, 'Everyone must see the same participant payouts');
    assert.equal(await spectator.page.locator('.together-personal-result').count(), 0);
    await spectator.page.reload();
    await resultView(spectator).waitFor();
    assert.equal((await readTimeline(spectator)).phase, 'complete');
    assert.equal((await readTimeline(spectator)).progress, 1);
    await member.page.goto(origin + `/messages/${groupId}`);
    await member.page.getByRole('link', { name: 'View group result', exact: true }).waitFor();
    await member.page.getByRole('link', { name: 'View group result', exact: true }).click();
    assert.equal(new URL(member.page.url()).hash, '#group-results');
    await resultView(member).waitFor();
    assert.equal((await readTimeline(member)).phase, 'complete');
    await eventually(async () => {
      const anchor = await member.page.locator('#group-results').evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight, scroll: scrollY };
      });
      assert(anchor.scroll > 0 && anchor.top < anchor.viewport * 0.75 && anchor.bottom > 0);
    }, 'Saved result link scrolls to the participants and payouts');
    assert.equal(writes.length, 0);
    checks.push({
      width,
      check:
        'Identical final draw and payouts persist after reload and remain discoverable from chat; zero writes',
    });
    await Promise.all(clients.map((client) => client.context.close()));
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        kind: 'Synthetic isolated Chromium contexts with canonical mocked API; not live or physical-device evidence',
        checks,
        errors,
        writes,
        activityPings,
        visualChecks,
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    JSON.stringify({ passed: checks.length, errors: errors.length, writes: writes.length, output })
  );
} catch (error) {
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify(
      { message: error.message, checks, errors, writes, activityPings, visualChecks },
      null,
      2
    ) + '\n'
  );
  throw error;
} finally {
  await browser.close();
}
