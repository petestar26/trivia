import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderDemo } from './demo.js';

const env = () => ({
  SOFTAGGREGATOR_DEMO_ENABLED: 'true',
  SOFTAGGREGATOR_DEMO_USER_IDS: 'tester',
  SOFTAGGREGATOR_API_LOGIN: 'test-login',
  SOFTAGGREGATOR_API_PASSWORD: 'test-password',
  SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS: 'games.example.com',
});
const game = { id_hash: 'studio/slot', name: 'Demo slot', play_for_fun_supported: true };
const response = (data: unknown) => new Response(JSON.stringify({ error: 0, response: data }));
afterEach(() => {
  vi.useRealTimers();
});

describe('provider demo boundary', () => {
  it.each(['SOFTAGGREGATOR_API_LOGIN', 'SOFTAGGREGATOR_API_PASSWORD'] as const)(
    'removes pasted boundary whitespace from %s before authenticating', async key => {
      const settings = env();
      settings[key] = `\r\n ${settings[key]}\t `;
      const fetcher = vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        return body.api_login === 'test-login' && body.api_password === 'test-password'
          ? response([game]) : new Response(JSON.stringify({ error: 1, message: 'Invalid credentials' }));
      });
      expect(await createProviderDemo(settings, fetcher).games('tester')).toHaveLength(1);
      expect(settings[key]).toMatch(/^\r\n /); // Never mutate the injected environment.
    }
  );
  it.each(['SOFTAGGREGATOR_API_LOGIN', 'SOFTAGGREGATOR_API_PASSWORD'] as const)(
    'refuses whitespace-only %s before any provider call', async key => {
      const settings = { ...env(), [key]: ' \r\n\t ' };
      const fetcher = vi.fn();
      await expect(createProviderDemo(settings, fetcher).games('tester')).rejects.toMatchObject({ statusCode: 503 });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it('keeps the same anonymous player identity when credentials contain pasted whitespace', async () => {
    const launchBodies: unknown[] = [];
    for (const padded of [false, true]) {
      const settings = env();
      if (padded) settings.SOFTAGGREGATOR_API_PASSWORD = `\n${settings.SOFTAGGREGATOR_API_PASSWORD}\r\n`;
      const fetcher = vi.fn().mockResolvedValueOnce(response([game]))
        .mockImplementationOnce(async (_url, options) => {
          const body = JSON.parse(options.body);
          launchBodies.push({ username: body.user_username, password: body.user_password });
          return response('https://games.example.com/demo/session');
        });
      await createProviderDemo(settings, fetcher).launch('tester', game.id_hash);
    }
    expect(launchBodies[0]).toEqual(launchBodies[1]);
  });
  it('blocks disabled or unlisted users without contacting provider', async () => {
    const fetcher = vi.fn();
    const settings = env();
    const client = createProviderDemo(settings, fetcher);
    await expect(client.games('other')).rejects.toMatchObject({ statusCode: 404 });
    settings.SOFTAGGREGATOR_DEMO_ENABLED = 'false';
    await expect(client.launch('tester', game.id_hash)).rejects.toMatchObject({ statusCode: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed when credentials are missing', async () => {
    const settings = env();
    settings.SOFTAGGREGATOR_API_PASSWORD = '';
    const fetcher = vi.fn();
    await expect(createProviderDemo(settings, fetcher).games('tester')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('filters non-demo, malformed and duplicate catalogue entries', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response([
          game,
          game,
          { ...game, id_hash: 'real', play_for_fun_supported: false },
          { id_hash: 'unknown', name: 'No flag' },
          null,
        ])
      );
    expect(await createProviderDemo(env(), fetcher).games('tester')).toEqual([
      { id: game.id_hash, name: game.name, category: 'other', provider: 'Provider' },
    ]);
  });
  it('caches catalogue but checks authorization on every request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([game]));
    const settings = env();
    const client = createProviderDemo(settings, fetcher);
    await client.games('tester');
    await client.games('tester');
    expect(fetcher).toHaveBeenCalledTimes(1);
    settings.SOFTAGGREGATOR_DEMO_USER_IDS = '';
    await expect(client.games('tester')).rejects.toMatchObject({ statusCode: 404 });
  });
  it('refreshes expired catalogue and does not retain failures', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([game]))
      .mockRejectedValueOnce(new Error('private'))
      .mockResolvedValueOnce(response([]));
    const client = createProviderDemo(env(), fetcher);
    await client.games('tester');
    vi.advanceTimersByTime(61_000);
    await expect(client.games('tester')).rejects.toMatchObject({ statusCode: 502 });
    expect(await client.games('tester')).toEqual([]);
  });
  it('only calls getGameDemo and never forwards application identity or live mode', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response('https://games.example.com/demo/session'));
    expect(await createProviderDemo(env(), fetcher).launch('tester', game.id_hash, true)).toEqual({
      mode: 'demo',
      url: 'https://games.example.com/demo/session',
    });
    const bodies = fetcher.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.map((body) => body.method)).toEqual(['getGameList', 'getGameDemo']);
    expect(bodies[1]).toMatchObject({ gameid: game.id_hash, play_for_fun: true, device: 'mobile' });
    expect(bodies[1].user_username).not.toContain('tester');
    expect(bodies[1]).not.toHaveProperty('balance');
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe('https://api.softaggregator.com/api/v1');
      expect(call[1].redirect).toBe('error');
    }
  });
  it('rejects arbitrary and real-only game IDs before launching', async () => {
    const fetcher = vi.fn().mockResolvedValue(response([]));
    await expect(createProviderDemo(env(), fetcher).launch('tester', 'real')).rejects.toMatchObject(
      { statusCode: 400 }
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires approved launch hosts before a launch call', async () => {
    const settings = env();
    settings.SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS = '';
    const fetcher = vi.fn().mockResolvedValue(response([game]));
    await expect(
      createProviderDemo(settings, fetcher).launch('tester', game.id_hash)
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    'http://games.example.com/demo',
    'https://games.example.com.evil.test/demo',
    'https://user:pass@games.example.com/demo',
    'javascript:alert(1)',
    'https://games.example.com:8443/demo',
    '//games.example.com/demo',
  ])('rejects unsafe game address %s', async (address) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response(address));
    await expect(
      createProviderDemo(env(), fetcher).launch('tester', game.id_hash)
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    new Response('no', { status: 503 }),
    new Response('not json'),
    new Response(JSON.stringify({ error: 1, message: 'test-password' })),
  ])('redacts upstream failures', async (failure) => {
    await expect(
      createProviderDemo(env(), vi.fn().mockResolvedValue(failure)).games('tester')
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'Provider demo could not be loaded. Please retry or contact support.',
    });
  });
});
