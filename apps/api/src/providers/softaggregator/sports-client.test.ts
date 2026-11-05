import { expect, it, vi } from 'vitest';
import { createSportsbook } from './sports-client.js';
import { SPORTS_GAME_ID } from './sports-config.js';
const settings = {
  SOFTAGGREGATOR_SPORTS_ENABLED: 'true',
  SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED: 'true',
  SOFTAGGREGATOR_SPORTS_LAUNCH_HOSTS: 'sports.example.com',
  SOFTAGGREGATOR_API_LOGIN: 'operator-login',
  SOFTAGGREGATOR_API_PASSWORD: 'operator-private-password',
  SOFTAGGREGATOR_SALT_KEY: 'callback-salt-for-fixtures',
};
function fixture(patch = {}, launchUrl = 'https://sports.example.com/session?ticket=opaque') {
  const wallet = { ensurePlayer: vi.fn(async () => ({ username: 'sr_' + 'a'.repeat(32) })) };
  const transport = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    return new Response(
      JSON.stringify({
        error: 0,
        response:
          body.method === 'getGameList'
            ? [{ id_hash: SPORTS_GAME_ID, game_type: 'sportsbook', name: 'Nocturn Sport' }]
            : body.method === 'getGame'
              ? launchUrl
              : {},
      })
    );
  });
  return {
    wallet,
    transport,
    sports: createSportsbook({} as any, { ...settings, ...patch }, transport as any, wallet as any),
  };
}
it('uses the existing API with a separate real-wallet identity, ETB and enforced Ethiopia market', async () => {
  const f = fixture();
  const result = await f.sports.launch('member', true);
  expect(result.mode).toBe('real-wallet');
  const calls = f.transport.mock.calls.map(([, o]) => JSON.parse(o.body as string));
  expect(calls.map((c) => c.method)).toEqual(['getGameList', 'createPlayer', 'getGame']);
  expect(calls[2]).toMatchObject({
    api_login: 'operator-login',
    gameid: SPORTS_GAME_ID,
    currency: 'ETB',
    country: 'ET',
    device: 'mobile',
    homeurl: 'https://salem.bet/sports',
  });
  expect(calls[2].user_username).toMatch(/^sr_/);
  expect(calls[2].play_for_fun).toBeUndefined();
  expect(calls.some((c) => 'amount' in c || 'balance' in c)).toBe(false);
});
it.each([
  { SOFTAGGREGATOR_SPORTS_ENABLED: 'false' },
  { SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED: 'false' },
  { SOFTAGGREGATOR_API_PASSWORD: '' },
  { SOFTAGGREGATOR_SALT_KEY: '' },
  { SOFTAGGREGATOR_SPORTS_LAUNCH_HOSTS: '' },
])('fails closed before creating a player when setup is incomplete %j', async (patch) => {
  const f = fixture(patch);
  expect(f.sports.browseReady()).toBe(false);
  await expect(f.sports.launch('member')).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.wallet.ensurePlayer).not.toHaveBeenCalled();
});
it.each([
  'http://sports.example.com',
  'https://attacker.example.com',
  'https://127.0.0.1/game',
  'https://u:p@sports.example.com',
  'https://sports.example.com/?key=operator-private-password',
])('refuses unsafe or unapproved sportsbook addresses %s', async (url) => {
  await expect(fixture({}, url).sports.launch('member')).rejects.toThrow('safely');
});
it('returns only the hostname for an owner verification probe', async () => {
  expect(
    await fixture({ SOFTAGGREGATOR_SPORTS_LAUNCH_HOSTS: '' }).sports.launch('member', false, true)
  ).toEqual({ mode: 'real-wallet', host: 'sports.example.com', url: '' });
});
it('refuses a catalogue without the exact sportsbook product', async () => {
  const f = fixture();
  f.transport.mockResolvedValue(
    new Response(
      JSON.stringify({ error: 0, response: [{ id_hash: SPORTS_GAME_ID, game_type: 'slots' }] })
    )
  );
  await expect(f.sports.launch('member')).rejects.toThrow('temporarily unavailable');
  expect(f.wallet.ensurePlayer).not.toHaveBeenCalled();
});
it('does not expose upstream error details or credentials to the member', async () => {
  const f = fixture();
  f.transport.mockResolvedValue(
    new Response(JSON.stringify({ error: 2, message: 'operator-private-password' }))
  );
  await expect(f.sports.launch('member')).rejects.toThrow('Please try again shortly');
});
