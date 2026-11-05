import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { providerCredentials } from './credentials.js';
import { ProviderDemoError } from './demo.js';
import { callbackSalt, createTestWallet, testAccess, testAccessMode } from './test-wallet.js';

type Env = Record<string, string | undefined>;
export interface TestGame {
  id: string;
  name: string;
  provider: string;
  category: string;
  image?: string;
  imageFallback?: string;
}
export type TestUnavailableReason = 'paused' | 'restricted' | 'setup-required' | null;
export class TestProviderFailure extends ProviderDemoError {
  constructor(
    readonly method: string,
    readonly reason: string,
    readonly httpStatus?: number,
    readonly providerCode?: number
  ) {
    super(502, 'The provider could not complete this test request.');
  }
}
const gameSchema = z.object({
  id_hash: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  provider_name: z.string().max(200).optional(),
  game_type: z.string().max(40).optional(),
  image: z.unknown().optional(),
  image_portrait: z.unknown().optional(),
  image_square: z.unknown().optional(),
});
export function testLaunchHost(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const u = new URL(raw),
      h = u.hostname.toLowerCase();
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      isIP(h.replace(/^\[|\]$/g, '')) ||
      /(^|\.)(localhost|local|internal|test|invalid|onion|lan|corp|home|localdomain)$/.test(h) ||
      h === 'home.arpa' ||
      h.endsWith('.home.arpa') ||
      h === 'salem.bet' ||
      h.endsWith('.salem.bet') ||
      h.endsWith('.railway.app') ||
      h.length > 253 ||
      !h.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) ||
      !/\.[a-z]{2,63}$/.test(h)
    )
      return null;
    return h;
  } catch {
    return null;
  }
}

export function createProviderTest(
  db: PrismaClient,
  env: Env = process.env,
  transport: typeof fetch = fetch
) {
  const { apiLogin, apiPassword } = providerCredentials(env);
  const wallet = createTestWallet(db, env);
  const configured = () =>
    !!apiLogin &&
    !!apiPassword &&
    callbackSalt(env).length >= 16 &&
    env.SOFTAGGREGATOR_TEST_CALLBACK_ENABLED === 'true';
  const unavailableReasonFor = (id: string): TestUnavailableReason => {
    if (env.SOFTAGGREGATOR_TEST_ENABLED !== 'true') return 'paused';
    if (testAccessMode(env) === 'invalid') return 'setup-required';
    if (!testAccess(env, id)) return 'restricted';
    return configured() ? null : 'setup-required';
  };
  const enabledFor = (id: string) => unavailableReasonFor(id) === null;
  const hosts = () =>
    (env.SOFTAGGREGATOR_TEST_LAUNCH_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const authorize = (id: string) => {
    if (!enabledFor(id))
      throw new ProviderDemoError(404, 'Provider testing is not available for this account.');
  };
  async function call(
    method: 'getGameList' | 'createPlayer' | 'getGame',
    fields: Record<string, unknown> = {}
  ) {
    try {
      const response = await transport('https://api.softaggregator.com/api/v1', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, method, api_login: apiLogin, api_password: apiPassword }),
      });
      if (!response.ok) throw new TestProviderFailure(method, 'HTTP_ERROR', response.status);
      const data = z
        .object({
          error: z.number().int().min(-1000000).max(1000000),
          response: z.unknown().optional(),
          message: z.string().optional(),
        })
        .parse(await response.json());
      if (data.error !== 0)
        throw new TestProviderFailure(
          method,
          data.message?.toLowerCase().includes('not available in your country')
            ? 'COUNTRY_RESTRICTED'
            : data.message?.toLowerCase().includes('country is required')
              ? 'COUNTRY_REQUIRED'
              : 'PROVIDER_REJECTED',
          response.status,
          data.error
        );
      return data.response;
    } catch (error) {
      if (error instanceof TestProviderFailure) throw error;
      throw new TestProviderFailure(method, 'NETWORK_OR_RESPONSE_ERROR');
    }
  }
  let cache: { until: number; games: TestGame[] } | undefined,
    pending: Promise<TestGame[]> | undefined;
  async function games(id: string) {
    authorize(id);
    if (cache && cache.until > Date.now()) return cache.games;
    if (!pending)
      pending = (async () => {
        const rows = await call('getGameList');
        if (!Array.isArray(rows) || rows.length > 100_000)
          throw new ProviderDemoError(502, 'The provider catalogue is unavailable.');
        const found = new Map<string, TestGame>();
        for (const row of rows) {
          const p = gameSchema.safeParse(row);
          if (p.success && !found.has(p.data.id_hash)) {
            // Portrait assets preserve the game title in the lobby's tall cards.
            // Keep one independent provider asset to recover from a failed thumbnail.
            const artwork = [
              ...new Set(
                [p.data.image_portrait, p.data.image, p.data.image_square].filter(
                  (value): value is string => !!testLaunchHost(value)
                )
              ),
            ];
            found.set(p.data.id_hash, {
              id: p.data.id_hash,
              name: p.data.name,
              provider: p.data.provider_name ?? 'Provider',
              category: p.data.game_type ?? 'other',
              ...(artwork[0] ? { image: artwork[0] } : {}),
              ...(artwork[1] ? { imageFallback: artwork[1] } : {}),
            });
          }
        }
        const result = [...found.values()];
        cache = { until: Date.now() + 60_000, games: result };
        return result;
      })().finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function launch(
    id: string,
    gameId: string,
    country: string,
    mobile = false,
    inspectHost = false
  ) {
    authorize(id);
    if (!/^[A-Z]{2}$/.test(country))
      throw new ProviderDemoError(400, 'Choose the country you are testing from.');
    if (!(await games(id)).some((g) => g.id === gameId))
      throw new ProviderDemoError(400, 'This game is not in the provider catalogue.');
    if (!inspectHost && !hosts().length)
      throw new ProviderDemoError(503, 'The test game address is awaiting configuration.');
    const player = await wallet.ensurePlayer(id);
    const credentials = {
      user_username: player.username,
      user_password: createHmac('sha256', apiPassword)
        .update(`salem-test-player:v1:${player.username}`)
        .digest('hex'),
      currency: 'ETB',
    };
    await call('createPlayer', credentials);
    const raw = await call('getGame', {
      ...credentials,
      gameid: gameId,
      lang: 'en',
      device: mobile ? 'mobile' : 'desktop',
      country,
      homeurl: 'https://salem.bet/casino',
    });
    const host = testLaunchHost(raw);
    if (
      !host ||
      [
        apiLogin,
        apiPassword,
        callbackSalt(env),
        credentials.user_username,
        credentials.user_password,
      ].some((secret) => host.includes(secret.toLowerCase())) ||
      (!inspectHost && !hosts().includes(host))
    )
      throw new ProviderDemoError(502, 'The provider returned an unapproved test game address.');
    // The operator probe returns the hostname only, never the bearer session URL.
    if (inspectHost) return { host, mode: 'virtual-test' as const, url: '' };
    return { url: new URL(raw as string).href, mode: 'virtual-test' as const, host };
  }
  return {
    enabledFor,
    unavailableReasonFor,
    games,
    launch,
    wallet,
    launchReady: () => hosts().length > 0,
  };
}
