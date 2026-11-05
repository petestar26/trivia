import { expect, it, vi } from 'vitest';
import { createProviderTest, testLaunchHost } from './test-client.js';
const env = {
  SOFTAGGREGATOR_TEST_ENABLED: 'true',
  SOFTAGGREGATOR_TEST_CALLBACK_ENABLED: 'true',
  SOFTAGGREGATOR_TEST_USER_IDS: 'tester',
  SOFTAGGREGATOR_API_LOGIN: ' api-user\n',
  SOFTAGGREGATOR_API_PASSWORD: ' api-secret\n',
  SOFTAGGREGATOR_SALT_KEY: 'fixture-salt-123456',
  SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: 'games.example.com',
};
it('excludes all sportsbooks from the practice catalogue and rejects direct launch attempts', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ error: 0, response: [
    { id_hash: 'x88c09ae664d9af4', name: 'Nocturn Sport', game_type: 'sportsbook' },
    { id_hash: 'another/sports', name: 'Another sport', game_type: 'sportsbook' },
  ] })));
  const pilot = createProviderTest({} as any, env, transport as any);
  expect(await pilot.games('tester')).toEqual([]);
  await expect(pilot.launch('tester','x88c09ae664d9af4','ET')).rejects.toThrow('not in the provider catalogue');
});
function fixture(overrides = {}) {
  const transaction = vi.fn(async (f: any) =>
    f({
      $queryRaw: vi.fn(async (s: TemplateStringsArray) =>
        s.join('').includes('FROM users')
          ? [{ status: 'ACTIVE' }]
          : [{ user_id: 'tester', username: 'st_' + 'a'.repeat(32), balance_cents: 100000n }]
      ),
      $executeRaw: vi.fn(async () => 1),
    })
  );
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        error: 0,
        response:
          body.method === 'getGameList'
            ? [
                {
                  id_hash: 'studio/slot',
                  name: 'Real API title',
                  play_for_fun_supported: false,
                  game_type: 'slots',
                  image: 'https://cdn.example.com/slot.webp',
                },
              ]
            : body.method === 'getGame'
              ? 'https://games.example.com/session?token=private'
              : {},
      })
    );
  });
  return {
    pilot: createProviderTest(
      { $transaction: transaction } as any,
      { ...env, ...overrides },
      transport as any
    ),
    transport,
    transaction,
  };
}
it('lists non-demo games and uses createPlayer/getGame with an isolated ETB identity', async () => {
  const f = fixture();
  expect(await f.pilot.games('tester')).toEqual([
    {
      id: 'studio/slot',
      name: 'Real API title',
      provider: 'Provider',
      category: 'slots',
      image: 'https://cdn.example.com/slot.webp',
    },
  ]);
  const result = await f.pilot.launch('tester', 'studio/slot', 'LA', true);
  expect(result.mode).toBe('virtual-test');
  const bodies = f.transport.mock.calls.map(([, i]) => JSON.parse(i.body as string));
  expect(bodies.map((x) => x.method)).toEqual(['getGameList', 'createPlayer', 'getGame']);
  expect(bodies[2]).toMatchObject({
    api_login: 'api-user',
    api_password: 'api-secret',
    currency: 'ETB',
    country: 'LA',
    device: 'mobile',
    homeurl: 'https://salem.bet/casino',
  });
  expect(bodies[2].play_for_fun).toBeUndefined();
  expect(bodies[1].user_username).toMatch(/^st_/);
  expect(bodies[1].user_password).toBe(bodies[2].user_password);
});
it('denies customers and disables unconfigured tests before creating a player', async () => {
  for (const overrides of [
    { SOFTAGGREGATOR_TEST_ENABLED: 'false' },
    { SOFTAGGREGATOR_SALT_KEY: '' },
    { SOFTAGGREGATOR_TEST_CALLBACK_ENABLED: 'false' },
  ]) {
    const f = fixture(overrides);
    await expect(f.pilot.launch('tester', 'studio/slot', 'ET')).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(f.pilot.games('customer')).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});
it('opens the catalogue to new accounts when automatic access is enabled', async () => {
  const f = fixture({
    SOFTAGGREGATOR_TEST_ACCESS_MODE: 'all-active',
    SOFTAGGREGATOR_TEST_USER_IDS: '',
  });
  expect(f.pilot.unavailableReasonFor('future-member')).toBeNull();
  expect(f.pilot.enabledFor('future-member')).toBe(true);
  expect(await f.pilot.games('future-member')).toHaveLength(1);
  expect(f.transaction).not.toHaveBeenCalled();
});
it.each([
  [{ SOFTAGGREGATOR_TEST_ENABLED: 'false' }, 'paused'],
  [{}, 'restricted'],
  [{ SOFTAGGREGATOR_TEST_ACCESS_MODE: 'typo' }, 'setup-required'],
  [
    { SOFTAGGREGATOR_TEST_ACCESS_MODE: 'all-active', SOFTAGGREGATOR_SALT_KEY: '' },
    'setup-required',
  ],
  [
    {
      SOFTAGGREGATOR_TEST_ACCESS_MODE: 'all-active',
      SOFTAGGREGATOR_TEST_CALLBACK_ENABLED: 'false',
    },
    'setup-required',
  ],
])('distinguishes account restrictions from platform availability: %j', (overrides, reason) => {
  const f = fixture(overrides);
  expect(f.pilot.unavailableReasonFor('new-member')).toBe(reason);
  expect(f.pilot.enabledFor('new-member')).toBe(false);
});
it('requires a configured host, listed game and actual-country input', async () => {
  const f = fixture({ SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: '' });
  await expect(f.pilot.launch('tester', 'studio/slot', 'LA')).rejects.toThrow('configuration');
  expect(f.transaction).not.toHaveBeenCalled();
  await expect(f.pilot.launch('tester', 'studio/slot', '')).rejects.toThrow('country');
  await expect(f.pilot.launch('tester', 'arbitrary/game', 'LA')).rejects.toThrow('catalogue');
});
it('operator host discovery returns no bearer URL and does not place a bet', async () => {
  const f = fixture({ SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: '' });
  const result = await f.pilot.launch('tester', 'studio/slot', 'LA', false, true);
  expect(result).toEqual({ url: '', host: 'games.example.com', mode: 'virtual-test' });
  expect(f.transport.mock.calls.map(([, i]) => JSON.parse(i.body as string).method)).toEqual([
    'getGameList',
    'createPlayer',
    'getGame',
  ]);
});
it.each([
  'http://games.example.com',
  'https://salem.bet/x',
  'https://127.0.0.1/x',
  'https://[::1]/x',
  'https://app.internal/x',
  'https://evil:pass@games.example.com/x',
  'https://app.up.railway.app/x',
])('refuses unsafe game address %s', (url) => expect(testLaunchHost(url)).toBeNull());
it('redacts provider errors and refuses redirect following', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(new Response('private credential error', { status: 401 }));
  await expect(f.pilot.games('tester')).rejects.toThrow('could not complete');
  expect(f.transport.mock.calls[0]?.[1].redirect).toBe('error');
});
it.each([
  'http://cdn.example.com/art.png',
  'javascript:alert(1)',
  'https://127.0.0.1/a',
  'https://user:pass@cdn.example.com/a',
  null,
])('keeps a game available without unsafe artwork %s', async (image) => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 0, response: [{ id_hash: 'slot', name: 'Slot', image }] }))
  );
  expect(await f.pilot.games('tester')).toEqual([
    { id: 'slot', name: 'Slot', provider: 'Provider', category: 'other' },
  ]);
});
it('prefers portrait artwork and keeps a separate provider image for recovery', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: 0,
        response: [
          {
            id_hash: 'slot',
            name: 'Slot',
            image: 'https://cdn.example.com/wide.jpg',
            image_portrait: 'https://cdn.example.com/portrait.jpg',
            image_square: 'https://cdn.example.com/square.jpg',
          },
        ],
      })
    )
  );
  expect(await f.pilot.games('tester')).toEqual([
    {
      id: 'slot',
      name: 'Slot',
      provider: 'Provider',
      category: 'other',
      image: 'https://cdn.example.com/portrait.jpg',
      imageFallback: 'https://cdn.example.com/wide.jpg',
    },
  ]);
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.transaction).not.toHaveBeenCalled();
});
it('validates every artwork variant and deduplicates fallback URLs', async () => {
  const f = fixture();
  f.transport.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: 0,
        response: [
          {
            id_hash: 'square-only',
            name: 'Square',
            image: null,
            image_portrait: 'https://127.0.0.1/private',
            image_square: 'https://cdn.example.com/square.jpg',
          },
          {
            id_hash: 'duplicate',
            name: 'Duplicate',
            image: 'https://cdn.example.com/same.jpg',
            image_portrait: 'https://cdn.example.com/same.jpg',
            image_square: 'javascript:alert(1)',
          },
        ],
      })
    )
  );
  expect(await f.pilot.games('tester')).toEqual([
    {
      id: 'square-only',
      name: 'Square',
      provider: 'Provider',
      category: 'other',
      image: 'https://cdn.example.com/square.jpg',
    },
    {
      id: 'duplicate',
      name: 'Duplicate',
      provider: 'Provider',
      category: 'other',
      image: 'https://cdn.example.com/same.jpg',
    },
  ]);
});
