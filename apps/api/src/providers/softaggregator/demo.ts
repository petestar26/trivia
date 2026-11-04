import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { providerCredentials } from './credentials.js';

export class ProviderDemoError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

const gameSchema = z.object({
  id_hash: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  provider_name: z.string().max(200).optional(),
  game_type: z.string().max(40).optional(),
  play_for_fun_supported: z.boolean().optional(),
});

export interface DemoGame {
  id: string;
  name: string;
  provider: string;
  category: string;
}
type Environment = Record<string, string | undefined>;

/** Demo only. No wallet, player-creation or real-money API methods exist here. */
export function createProviderDemo(
  env: Environment = process.env,
  transport: typeof fetch = fetch
) {
  const { apiLogin, apiPassword } = providerCredentials(env);
  let cached: { until: number; games: DemoGame[] } | undefined;
  let pending: Promise<DemoGame[]> | undefined;
  const testers = () =>
    (env.SOFTAGGREGATOR_DEMO_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const enabledFor = (userId: string) =>
    env.SOFTAGGREGATOR_DEMO_ENABLED === 'true' && testers().includes(userId);
  function authorize(userId: string) {
    if (!enabledFor(userId)) throw new ProviderDemoError(404, 'Provider demo is not available.');
    if (!apiLogin || !apiPassword)
      throw new ProviderDemoError(503, 'Provider demo credentials have not been configured.');
  }
  async function call(method: 'getGameList' | 'getGameDemo', fields: Record<string, unknown> = {}) {
    try {
      const response = await transport('https://api.softaggregator.com/api/v1', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fields,
          method,
          api_login: apiLogin,
          api_password: apiPassword,
        }),
      });
      if (!response.ok) throw new Error('Provider HTTP error');
      const result = z
        .object({ error: z.number(), response: z.unknown().optional() })
        .parse(await response.json());
      if (result.error !== 0) throw new Error('Provider rejected request');
      return result.response;
    } catch {
      // Provider errors/URLs may contain credentials: never expose or log them.
      throw new ProviderDemoError(
        502,
        'Provider demo could not be loaded. Please retry or contact support.'
      );
    }
  }
  async function games(userId: string): Promise<DemoGame[]> {
    authorize(userId);
    if (cached && cached.until > Date.now()) return cached.games;
    if (!pending)
      pending = (async () => {
        const raw = await call('getGameList');
        if (!Array.isArray(raw) || raw.length > 100_000)
          throw new ProviderDemoError(502, 'Provider returned an invalid game catalogue.');
        const seen = new Set<string>();
        const result: DemoGame[] = [];
        for (const item of raw) {
          const parsed = gameSchema.safeParse(item);
          if (
            !parsed.success ||
            parsed.data.play_for_fun_supported !== true ||
            seen.has(parsed.data.id_hash)
          )
            continue;
          const game = parsed.data;
          seen.add(game.id_hash);
          result.push({
            id: game.id_hash,
            name: game.name,
            provider: game.provider_name ?? 'Provider',
            category: game.game_type ?? 'other',
          });
        }
        cached = { until: Date.now() + 60_000, games: result };
        return result;
      })().finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function launch(userId: string, gameId: string, mobile = false) {
    authorize(userId);
    if (!(await games(userId)).some((game) => game.id === gameId))
      throw new ProviderDemoError(400, 'This game is not available in demo mode.');
    const hosts = (env.SOFTAGGREGATOR_DEMO_LAUNCH_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!hosts.length)
      throw new ProviderDemoError(503, 'Approved provider game hosts have not been configured.');
    const pseudonym = createHmac('sha256', apiPassword)
      .update(`demo:${userId}`)
      .digest('hex');
    const raw = await call('getGameDemo', {
      user_username: `demo_${pseudonym.slice(0, 24)}`,
      user_password: pseudonym.slice(24),
      gameid: gameId,
      play_for_fun: true,
      lang: 'en',
      device: mobile ? 'mobile' : 'desktop',
    });
    try {
      if (typeof raw !== 'string') throw new Error('Invalid URL');
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !hosts.includes(url.hostname.toLowerCase())
      )
        throw new Error('Unapproved URL');
      return { url: url.href, mode: 'demo' as const };
    } catch {
      throw new ProviderDemoError(502, 'Provider returned an unapproved game address.');
    }
  }
  return { enabledFor, games, launch };
}
