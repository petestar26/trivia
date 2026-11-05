import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { providerCredentials } from './credentials.js';

type Environment = Record<string, string | undefined>;
export type ProviderProbeMode = '--check' | '--catalogue' | '--launch';
export const PROVIDER_PROBE_TARGET = Object.freeze({
  RAILWAY_PROJECT_ID: '95bd9da5-59ea-4f49-b2b1-9114e8a1a0a2',
  RAILWAY_ENVIRONMENT_ID: 'e48c2274-6993-446e-8a54-c33e4d6f698e',
  RAILWAY_SERVICE_ID: 'ffe7dd49-e409-4a46-95a8-7614d2e96095',
});
export function assertProviderProbeTarget(env: Environment) {
  if (Object.entries(PROVIDER_PROBE_TARGET).some(([key, value]) => env[key] !== value))
    throw new Error('PROVIDER_PROBE_TARGET_REFUSED');
}
export function providerProbeTesterName(env: Environment) {
  const value = env.SOFTAGGREGATOR_DEMO_TEST_USERNAME;
  if (value === undefined || value === '') return undefined;
  // Same rule as the platform's usernameSchema; never log the supplied name.
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(value)) throw new Error('PROVIDER_PROBE_TESTER_REFUSED');
  return value;
}

/** Syntactic public host only. Discovery does not approve, resolve or visit it. */
function publicHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIP(host.replace(/^\[|\]$/g, '')) || host.length > 253 ||
      /(^|\.)(localhost|local|localdomain|internal|lan|home|corp|intranet|test|invalid|onion)$/.test(host) ||
      (host === 'home.arpa' || host.endsWith('.home.arpa')) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/\.[a-z][a-z0-9-]{1,62}$/.test(host)) return undefined;
    return host;
  } catch { return undefined; }
}

const gameSchema = z.object({
  id_hash: z.string().min(1).max(256), name: z.string().min(1).max(200),
  play_for_fun_supported: z.literal(true),
});
class ProbeFailure extends Error {
  constructor(readonly status: string, readonly httpStatus?: number, readonly providerCode?: number) {
    super(status);
  }
}

/** Operator CLI helper only. Never connects a wallet, embeds a URL or changes gates. */
export async function runProviderDemoProbe(
  mode: ProviderProbeMode, env: Environment = process.env, transport: typeof fetch = fetch
) {
  assertProviderProbeTarget(env);
  if (!['--check', '--catalogue', '--launch'].includes(mode))
    throw new Error('PROVIDER_PROBE_ARGUMENTS_REFUSED');
  const entries = (value: string | undefined) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const { apiLogin, apiPassword } = providerCredentials(env);
  const credentialsConfigured = !!apiLogin && !!apiPassword;
  const configuration = {
    demoEnabled: env.SOFTAGGREGATOR_DEMO_ENABLED === 'true', credentialsConfigured,
    testerCount: new Set(entries(env.SOFTAGGREGATOR_DEMO_USER_IDS)).size,
    launchHostCount: new Set(entries(env.SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS).map(s => s.toLowerCase())
      .filter(host => publicHost(`https://${host}`) === host)).size,
  };
  const configured = configuration.demoEnabled && credentialsConfigured &&
    configuration.testerCount > 0 && configuration.launchHostCount > 0;
  const report = (status: string, ok = false, detail: Record<string, unknown> = {}) =>
    ({ ok, status, configuration, memberConfigured: configured, ...detail });
  if (mode === '--check') return report(configured ? 'CONFIGURATION_READY' : 'CONFIGURATION_INCOMPLETE', configured);
  if (!credentialsConfigured) return report('CREDENTIALS_MISSING');
  const device = env.SOFTAGGREGATOR_DEMO_PROBE_DEVICE ?? 'desktop';
  if (mode === '--launch' && !['desktop', 'mobile'].includes(device)) return report('PROBE_DEVICE_INVALID');

  async function call(method: 'getGameList' | 'getGameDemo', fields: Record<string, unknown> = {}) {
    let response: Response;
    try {
      response = await transport('https://api.softaggregator.com/api/v1', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, method,
          api_login: apiLogin, api_password: apiPassword }),
      });
    } catch (error) {
      throw new ProbeFailure(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
        ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR');
    }
    if (!response.ok) throw new ProbeFailure('PROVIDER_HTTP_ERROR', response.status);
    let body: { error: number; response?: unknown };
    try {
      body = z.object({ error: z.number().int().min(-1_000_000).max(1_000_000), response: z.unknown().optional() })
        .parse(await response.json());
    } catch (error) {
      throw new ProbeFailure(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
        ? 'PROVIDER_TIMEOUT' : 'PROVIDER_INVALID_RESPONSE');
    }
    if (body.error !== 0) throw new ProbeFailure('PROVIDER_REJECTED', response.status, body.error);
    return body.response;
  }
  try {
    const raw = await call('getGameList');
    if (!Array.isArray(raw) || raw.length > 100_000) throw new ProbeFailure('PROVIDER_INVALID_CATALOGUE');
    const demos = new Map<string, z.infer<typeof gameSchema>>();
    for (const item of raw) {
      const parsed = gameSchema.safeParse(item);
      if (parsed.success) demos.set(parsed.data.id_hash, parsed.data);
    }
    const catalogue = { total: raw.length, demoSupported: demos.size };
    if (mode === '--catalogue') return report('CATALOGUE_READY', true, { catalogue });
    const requested = env.SOFTAGGREGATOR_DEMO_PROBE_GAME_ID;
    const game = requested ? demos.get(requested) : demos.values().next().value;
    if (!game) return report(requested ? 'PROBE_GAME_UNAVAILABLE' : 'NO_DEMO_GAMES', false, { catalogue });
    const pseudonym = createHmac('sha256', apiPassword)
      .update('salem-provider-demo-probe:v1').digest('hex');
    const rawUrl = await call('getGameDemo', { gameid: game.id_hash, play_for_fun: true,
      user_username: `dp_${pseudonym.slice(0, 24)}`, user_password: pseudonym.slice(24), lang: 'en', device });
    const launchHost = publicHost(rawUrl);
    if (!launchHost || [apiLogin, apiPassword,
      `dp_${pseudonym.slice(0, 24)}`, pseudonym.slice(24)]
      .some(secret => launchHost.includes(secret.toLowerCase())))
      throw new ProbeFailure('PROVIDER_UNSAFE_DEMO_HOST');
    return report('DEMO_SESSION_READY', true, { catalogue, device, launchHost, hostApproved: false });
  } catch (error) {
    if (!(error instanceof ProbeFailure)) return report('PROVIDER_INVALID_RESPONSE');
    return report(error.status, false, { ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }) });
  }
}
