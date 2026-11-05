import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { providerCredentials } from './credentials.js';
import { ProviderDemoError } from './demo.js';
import { callbackSalt } from './test-wallet.js';
import { testLaunchHost } from './test-client.js';
import { sportsGameId, type SportsEnv } from './sports-config.js';
import { createSportsWallet } from './sports-wallet.js';

export function createSportsbook(
  db: PrismaClient,
  env: SportsEnv = process.env,
  transport: typeof fetch = fetch,
  wallet = createSportsWallet(db, env)
) {
  const { apiLogin, apiPassword } = providerCredentials(env);
  const configured = () =>
    env.SOFTAGGREGATOR_SPORTS_ENABLED === 'true' &&
    env.SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED === 'true' &&
    !!apiLogin &&
    !!apiPassword &&
    callbackSalt(env).length >= 16;
  const hosts = () =>
    (env.SOFTAGGREGATOR_SPORTS_LAUNCH_HOSTS ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  async function call(
    method: 'getGameList' | 'createPlayer' | 'getGame',
    fields: Record<string, unknown> = {}
  ) {
    try {
      const response = await transport('https://api.softaggregator.com/api/v1', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, method, api_login: apiLogin, api_password: apiPassword }),
      });
      if (!response.ok) throw Error('HTTP_FAILURE');
      const result = z
        .object({ error: z.number(), response: z.unknown().optional() })
        .parse(await response.json());
      if (result.error !== 0) throw Error('PROVIDER_REFUSED');
      return result.response as unknown;
    } catch {
      throw new ProviderDemoError(502, 'Sports could not be opened. Please try again shortly.');
    }
  }
  let verifiedUntil = 0;
  async function verifyCatalogue() {
    if (verifiedUntil > Date.now()) return;
    const rows = await call('getGameList');
    if (
      !Array.isArray(rows) ||
      !rows.some((g) => g.id_hash === sportsGameId(env) && g.game_type === 'sportsbook')
    )
      throw new ProviderDemoError(503, 'The sportsbook is temporarily unavailable.');
    verifiedUntil = Date.now() + 60_000;
  }
  async function launch(userId: string, mobile = false, inspectHost = false) {
    if (!configured() || (!inspectHost && !hosts().length))
      throw new ProviderDemoError(503, 'Sports is getting ready. Please check back shortly.');
    await verifyCatalogue();
    const player = await wallet.ensurePlayer(userId);
    const credentials = {
      user_username: player.username,
      user_password: createHmac('sha256', apiPassword)
        .update(`salem-sports-player:v1:${player.username}`)
        .digest('hex'),
      currency: 'ETB',
    };
    await call('createPlayer', credentials);
    const raw = await call('getGame', {
      ...credentials,
      gameid: sportsGameId(env),
      lang: 'en',
      device: mobile ? 'mobile' : 'desktop',
      country: env.SOFTAGGREGATOR_SPORTS_COUNTRY || 'ET',
      homeurl: 'https://salem.bet/sports',
    });
    const host = testLaunchHost(raw);
    if (
      !host ||
      [apiLogin, apiPassword, callbackSalt(env)].some((secret) => String(raw).includes(secret)) ||
      (!inspectHost && !hosts().includes(host))
    )
      throw new ProviderDemoError(
        502,
        'Sports could not be opened safely. Please try again shortly.'
      );
    if (inspectHost) return { host, url: '', mode: 'real-wallet' as const };
    return { host, url: raw as string, mode: 'real-wallet' as const };
  }
  return { configured, browseReady: () => configured() && hosts().length > 0, launch, wallet };
}
