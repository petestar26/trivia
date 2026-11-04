import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_PROBE_TARGET, providerProbeTesterName, runProviderDemoProbe, type ProviderProbeMode } from './probe.js';

const settings = () => ({ ...PROVIDER_PROBE_TARGET,
  SOFTAGGREGATOR_API_LOGIN: 'operator-login', SOFTAGGREGATOR_API_PASSWORD: 'private-provider-password',
  SOFTAGGREGATOR_DEMO_ENABLED: 'true', SOFTAGGREGATOR_DEMO_USER_IDS: 'tester,tester',
  SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS: 'games.provider.com',
});
const game = { id_hash: 'studio/demo', name: 'A demo', play_for_fun_supported: true };
const response = (data: unknown) => new Response(JSON.stringify({ error: 0, response: data }));
afterEach(() => { vi.restoreAllMocks(); });

describe('operator-only provider demo setup probe', () => {
  it.each(Object.keys(PROVIDER_PROBE_TARGET))('refuses wrong target %s before outbound access', async key => {
    const transport = vi.fn();
    await expect(runProviderDemoProbe('--catalogue', { ...settings(), [key]: 'wrong' }, transport))
      .rejects.toThrow('PROVIDER_PROBE_TARGET_REFUSED');
    expect(transport).not.toHaveBeenCalled();
  });
  it('checks absent configuration without provider calls, values or session data', async () => {
    const transport = vi.fn();
    const result = await runProviderDemoProbe('--check', { ...PROVIDER_PROBE_TARGET }, transport);
    expect(result).toMatchObject({ ok: false, status: 'CONFIGURATION_INCOMPLETE',
      configuration: { demoEnabled: false, credentialsConfigured: false, testerCount: 0, launchHostCount: 0 } });
    expect(transport).not.toHaveBeenCalled();
    const complete = await runProviderDemoProbe('--check', settings(), transport);
    expect(complete).toMatchObject({ ok: true, memberConfigured: true, configuration: { testerCount: 1 } });
    expect(JSON.stringify(complete)).not.toMatch(/operator-login|private-provider-password|games\.provider\.com|tester"/);
    expect(transport).not.toHaveBeenCalled();
  });
  it('refuses an unknown mode before contacting the provider', async () => {
    const transport = vi.fn();
    await expect(runProviderDemoProbe('--real' as ProviderProbeMode, settings(), transport))
      .rejects.toThrow('PROVIDER_PROBE_ARGUMENTS_REFUSED');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['SOFTAGGREGATOR_API_LOGIN', 'SOFTAGGREGATOR_API_PASSWORD'])(
    'does not contact provider without %s', async key => {
      const transport = vi.fn();
      for (const mode of ['--catalogue', '--launch'] as const) {
        expect(await runProviderDemoProbe(mode, { ...settings(), [key]: '  ' }, transport))
          .toMatchObject({ ok: false, status: 'CREDENTIALS_MISSING' });
      }
      expect(transport).not.toHaveBeenCalled();
    });
  it('counts valid unique demo entries without publishing raw provider fields or opening member access', async () => {
    const env = { ...settings(), SOFTAGGREGATOR_DEMO_ENABLED: 'false', SOFTAGGREGATOR_DEMO_USER_IDS: '',
      SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS: '' };
    const transport = vi.fn().mockResolvedValue(response([game, game,
      { ...game, id_hash: 'live', play_for_fun_supported: false }, null,
      { ...game, id_hash: 'secret-name', name: env.SOFTAGGREGATOR_API_PASSWORD }]));
    const result = await runProviderDemoProbe('--catalogue', env, transport);
    expect(result).toMatchObject({ ok: true, status: 'CATALOGUE_READY', memberConfigured: false,
      catalogue: { total: 5, demoSupported: 2 } });
    expect(JSON.stringify(result)).not.toContain(env.SOFTAGGREGATOR_API_PASSWORD);
    expect(env.SOFTAGGREGATOR_DEMO_ENABLED).toBe('false');
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each(['desktop', 'mobile'])('creates only a pseudonymous %s demo session and reports an unapproved host only', async device => {
    const env = { ...settings(), SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS: '', SOFTAGGREGATOR_DEMO_PROBE_DEVICE: device };
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const transport = vi.fn().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response('https://games.provider.com/private/session?token=sensitive-session#private'));
    const result = await runProviderDemoProbe('--launch', env, transport);
    expect(result).toMatchObject({ ok: true, status: 'DEMO_SESSION_READY', device,
      launchHost: 'games.provider.com', hostApproved: false, memberConfigured: false });
    const calls = transport.mock.calls;
    expect(calls.map(call => JSON.parse(call[1].body).method)).toEqual(['getGameList', 'getGameDemo']);
    for (const [url, options] of calls) {
      expect(url).toBe('https://api.softaggregator.com/api/v1');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(timeout).toHaveBeenCalledWith(10_000);
    const launch = JSON.parse(calls[1][1].body);
    expect(launch).toMatchObject({ method: 'getGameDemo', gameid: game.id_hash, play_for_fun: true, device, lang: 'en' });
    expect(launch.user_username).toMatch(/^dp_[a-f0-9]{24}$/);
    expect(launch.user_password).toMatch(/^[a-f0-9]{40}$/);
    expect(launch).not.toHaveProperty('balance');
    expect(launch).not.toHaveProperty('homeurl');
    expect(JSON.stringify(result)).not.toMatch(/sensitive-session|private\/session|operator-login|private-provider-password/);
    expect(env.SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS).toBe('');
  });
  it.each(['http://games.provider.com/demo', 'https://user:pass@games.provider.com/demo',
    'https://games.provider.com:8443/demo', 'https://127.0.0.1/demo', 'https://10.0.0.1/demo',
    'https://[::1]/demo', 'https://2130706433/demo', 'https://0x7f000001/demo',
    'https://localhost/demo', 'https://games.local/demo', 'https://games.home.arpa/demo', 'https://home.arpa/demo',
    'https://games.internal/demo', 'https://unqualified/demo', '//games.provider.com/demo',
    'javascript:alert(1)', 'https://games.provider.com./demo', 'https://private-provider-password.provider.com/demo'])
    ('does not disclose or approve unsafe launch value %s', async url => {
      const transport = vi.fn().mockResolvedValueOnce(response([game])).mockResolvedValueOnce(response(url));
      const result = await runProviderDemoProbe('--launch', settings(), transport);
      expect(result).toMatchObject({ ok: false, status: 'PROVIDER_UNSAFE_DEMO_HOST' });
      expect(JSON.stringify(result)).not.toContain(url);
    });
  it('refuses a requested non-demo game without making a launch call', async () => {
    const transport = vi.fn().mockResolvedValue(response([game]));
    expect(await runProviderDemoProbe('--launch', { ...settings(), SOFTAGGREGATOR_DEMO_PROBE_GAME_ID: 'live-only' }, transport))
      .toMatchObject({ ok: false, status: 'PROBE_GAME_UNAVAILABLE' });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('redacts even a short credential reflected in the launch hostname', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response([game]))
      .mockResolvedValueOnce(response('https://abc.provider.com/session'));
    const result = await runProviderDemoProbe('--launch', { ...settings(), SOFTAGGREGATOR_API_LOGIN: 'abc' }, transport);
    expect(result).toMatchObject({ ok: false, status: 'PROVIDER_UNSAFE_DEMO_HOST' });
    expect(JSON.stringify(result)).not.toContain('abc');
  });
  it('never reports a derived provider player password reflected by the launch host', async () => {
    const passwordTransport = vi.fn().mockResolvedValueOnce(response([game])).mockImplementationOnce(async (_url, options) => {
      const { user_password } = JSON.parse(options.body);
      return response(`https://${user_password}.provider.com/session`);
    });
    const result = await runProviderDemoProbe('--launch', settings(), passwordTransport);
    expect(result).toMatchObject({ ok: false, status: 'PROVIDER_UNSAFE_DEMO_HOST' });
  });
  it('refuses invalid device configuration before outbound requests', async () => {
    const transport = vi.fn();
    expect(await runProviderDemoProbe('--launch', { ...settings(), SOFTAGGREGATOR_DEMO_PROBE_DEVICE: 'other' }, transport))
      .toMatchObject({ ok: false, status: 'PROBE_DEVICE_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    [new Response('private-provider-password', { status: 403 }), 'PROVIDER_HTTP_ERROR', { httpStatus: 403 }],
    [new Response('private-provider-password'), 'PROVIDER_INVALID_RESPONSE', {}],
    [new Response(JSON.stringify({ error: 17, message: 'private-provider-password' })), 'PROVIDER_REJECTED', { providerCode: 17 }],
    [response({ message: 'private-provider-password' }), 'PROVIDER_INVALID_CATALOGUE', {}],
    [response([]), 'NO_DEMO_GAMES', {}],
  ])('redacts provider rejection %s', async (upstream, status, detail) => {
    const result = await runProviderDemoProbe('--launch', settings(), vi.fn().mockResolvedValue(upstream));
    expect(result).toMatchObject({ ok: false, status, ...detail });
    expect(JSON.stringify(result)).not.toContain('private-provider-password');
  });
  it.each([
    [new DOMException('private-provider-password', 'TimeoutError'), 'PROVIDER_TIMEOUT'],
    [new Error('private-provider-password'), 'PROVIDER_NETWORK_ERROR'],
  ])('redacts transport errors', async (error, status) => {
    const result = await runProviderDemoProbe('--catalogue', settings(), vi.fn().mockRejectedValue(error));
    expect(result).toMatchObject({ ok: false, status });
    expect(JSON.stringify(result)).not.toContain('private-provider-password');
  });
  it('validates an optional tester name without returning it in probe output', () => {
    expect(providerProbeTesterName({})).toBeUndefined();
    expect(providerProbeTesterName({ SOFTAGGREGATOR_DEMO_TEST_USERNAME: 'operator_1' })).toBe('operator_1');
    for (const value of ['ab', 'a'.repeat(31), 'bad space', '";DROP TABLE users;'])
      expect(() => providerProbeTesterName({ SOFTAGGREGATOR_DEMO_TEST_USERNAME: value })).toThrow('PROVIDER_PROBE_TESTER_REFUSED');
  });
});
