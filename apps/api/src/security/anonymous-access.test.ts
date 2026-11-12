import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Synthetic, disposable configuration. A protected route must reject an
// anonymous request in `authenticate`, before any database access, so these
// tests run without a database. An existing test DATABASE_URL is respected.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://synthetic:synthetic@127.0.0.1:9/synthetic_unreachable';
  process.env.JWT_ACCESS_SECRET ??= 'synthetic-anonymous-test-access-secret-000000';
  process.env.JWT_REFRESH_SECRET ??= 'synthetic-anonymous-test-refresh-secret-00000';
  process.env.LOG_LEVEL = 'fatal';
});

import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';

const UUID = '00000000-0000-4000-8000-000000000000';
const API = '/api/v1';

/**
 * Routes that are public by design. Each carries no account data, or is a
 * sign-in/registration step, or authenticates by a mechanism other than a
 * member session. Everything else must reject anonymous requests.
 */
const PUBLIC_ROUTES = new Set([
  'GET /',
  'GET /*',
  'GET /health',
  'GET /health/',
  'GET /sg/callback', // provider callback: gateway address + HMAC, checked below
  'POST /sg/callback',
  'PUT /sg/callback',
  'PATCH /sg/callback',
  'DELETE /sg/callback',
  `POST ${API}/auth/login`,
  `POST ${API}/auth/register`,
  `POST ${API}/auth/google`,
  `GET ${API}/auth/google/nonce`,
  `POST ${API}/auth/refresh`,
  `POST ${API}/auth/logout`,
  `POST ${API}/auth/password-reset`,
  `POST ${API}/agents/activate-account`, // one-time temporary-password activation
  `GET ${API}/wallet/exchange-rate`, // published ETB rate, no account data
  `GET ${API}/games/scheduled/spin-win/proofs/:roundId`, // public fairness proof
  `GET ${API}/games/scheduled/spin-win/proofs/:roundId/publication`,
]);

/** Well-formed bodies for routes whose own error handler hides schema detail. */
const EXPLICIT_BODIES: Record<string, Record<string, unknown>> = {
  [`POST ${API}/provider-demo/launch`]: { gameId: 'synthetic-game' },
  [`POST ${API}/provider-test/launch`]: { gameId: 'synthetic-game', mobile: false },
  [`POST ${API}/sportsbook/launch`]: { mobile: false },
};

type Route = { method: string; path: string };

/** Every registered route, reconstructed from Fastify's own route tree. */
function registeredRoutes(server: FastifyInstance): Route[] {
  const stack: string[] = [];
  const routes: Route[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split('\n')) {
    const at = Math.max(line.indexOf('├── '), line.indexOf('└── '));
    if (at < 0) continue;
    const depth = at / 4;
    const match = /^(.*?) \(([^)]*)\)$/.exec(line.slice(at + 4));
    stack[depth] = (depth ? stack[depth - 1] : '') + (match ? match[1] : line.slice(at + 4));
    stack.length = depth + 1;
    if (!match) continue;
    const path = stack[depth].replace(/^\/?/, '/').replace(/(:\w+)(?:\|:\w+)+/g, '$1');
    for (const method of match[2].split(', '))
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) routes.push({ method, path });
  }
  return routes;
}

const concrete = (path: string) =>
  path
    .replace(/:type\b/, 'LIKE')
    .replace(/:\w+/g, UUID)
    .replace(/\*$/, 'x');

type Detail = {
  instancePath?: string;
  keyword: string;
  params: {
    type?: string;
    allowedValues?: unknown[];
    allowedValue?: unknown;
    format?: string;
    limit?: number;
    pattern?: string;
    missingProperty?: string;
    additionalProperty?: string;
  };
  message?: string;
};

/** A synthetic value that satisfies one schema complaint, or undefined if none is known. */
function repairValue(detail: Detail): unknown {
  const { keyword, params } = detail;
  switch (keyword) {
    case 'required':
      return 'synthetic';
    case 'type':
      return (
        {
          integer: 1,
          number: 1,
          boolean: true,
          array: [],
          object: {},
          string: 'synthetic',
          null: null,
        } as Record<string, unknown>
      )[String(params.type).split(',')[0]];
    case 'enum':
      return params.allowedValues?.[0];
    case 'const':
      return params.allowedValue;
    case 'format':
      return params.format === 'uuid'
        ? UUID
        : params.format === 'email'
          ? 'synthetic@example.invalid'
          : params.format === 'date-time'
            ? '2026-01-01T00:00:00.000Z'
            : 'synthetic';
    case 'minLength':
      return 'x'.repeat(params.limit ?? 1);
    case 'maxLength':
      return 'x';
    case 'minimum':
    case 'maximum':
      return params.limit;
    case 'minItems':
      return Array.from({ length: params.limit ?? 1 }, () => 1);
    case 'pattern': {
      const fixed = /^\^\[([^\]]+)\]\{(\d+)(?:,\d*)?\}\$$/.exec(params.pattern ?? '');
      if (fixed) return (fixed[1].match(/[A-Za-z0-9]/)?.[0] ?? 'a').repeat(Number(fixed[2]));
      const open = /^\^\[([^\]]+)\][+*]\$$/.exec(params.pattern ?? '');
      return open ? (open[1].match(/[A-Za-z0-9]/)?.[0] ?? 'a').repeat(4) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Send an anonymous request whose body/query satisfies the route schema, so the
 * result reflects authentication rather than validation (validation runs before
 * preHandler authenticate). Returns the final response and any unrepaired detail.
 */
async function anonymousRequest(server: FastifyInstance, route: Route, index: number) {
  const reads = route.method === 'GET' || route.method === 'DELETE';
  const bag: Record<string, unknown> = {
    ...(EXPLICIT_BODIES[`${route.method} ${route.path}`] ?? {}),
  };
  for (let round = 0; round < 40; round += 1) {
    const query = reads ? new URLSearchParams(bag as Record<string, string>).toString() : '';
    const response = await server.inject({
      method: route.method as 'GET',
      url: concrete(route.path) + (query ? `?${query}` : ''),
      // A distinct synthetic client per attempt keeps the rate limiters (keyed
      // by address) from answering instead of authentication.
      remoteAddress: `10.${79 + round}.${index >> 8}.${index & 255}`,
      // Some wagers require an idempotency header; schema detail cannot say
      // whether a missing property belongs to the headers or the body.
      headers: { 'idempotency-key': `synthetic-anonymous-probe-${index}` },
      ...(reads ? {} : { payload: bag }),
    });
    if (response.statusCode !== 400) return { response };
    const detail: Detail | undefined = response.json()?.error?.details?.[0];
    if (!detail) return { response, unrepaired: String(response.json()?.error?.message) };
    const parts = String(detail.instancePath ?? '')
      .split('/')
      .filter(Boolean);
    let holder = bag;
    for (const part of detail.keyword === 'required' ? parts : parts.slice(0, -1))
      holder = (holder[part] ??= {}) as Record<string, unknown>;
    if (detail.keyword === 'additionalProperties') {
      delete holder[detail.params.additionalProperty ?? ''];
      continue;
    }
    const key =
      detail.keyword === 'required' ? detail.params.missingProperty : parts[parts.length - 1];
    const value = repairValue(detail);
    if (!key || value === undefined)
      return { response, unrepaired: `${detail.instancePath} ${detail.keyword}` };
    holder[key] = value;
  }
  throw new Error(`Could not satisfy the schema for ${route.method} ${route.path}`);
}

describe('anonymous access to the API', () => {
  let server: FastifyInstance;
  let routes: Route[];

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
    routes = registeredRoutes(server);
  });
  afterAll(async () => {
    await server.close();
  });

  it('discovers the full route table, including every public route listed here', () => {
    expect(routes.length).toBeGreaterThan(300);
    const known = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const route of PUBLIC_ROUTES) expect(known, route).toContain(route);
  });

  it('rejects every non-public route with 401 before any handler or database access', async () => {
    const outcomes: Record<string, string[]> = {};
    let index = 0;
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      index += 1;
      const { response, unrepaired } = await anonymousRequest(server, route, index);
      const body = response.json();
      expect(body?.data, `${key} returned data`).toBeUndefined();
      (outcomes[response.statusCode] ??= []).push(unrepaired ? `${key} (${unrepaired})` : key);
    }
    expect(outcomes, 'only 401 is acceptable for an anonymous protected request').toEqual({
      401: expect.any(Array),
    });
    expect(outcomes[401].length).toBeGreaterThan(300);
  }, 120_000);

  it.each([
    ['GET', `${API}/auth/me`, undefined],
    ['GET', `${API}/wallet/payment-options`, undefined],
    ['GET', `${API}/provider-test/status`, undefined],
    ['GET', `${API}/provider-test/games`, undefined],
    ['GET', `${API}/provider-test/wallet`, undefined],
    ['POST', `${API}/provider-test/launch`, { gameId: 'synthetic-game', mobile: false }],
    ['GET', `${API}/sportsbook/status`, undefined],
    ['GET', `${API}/sportsbook/activity`, undefined],
    ['POST', `${API}/sportsbook/launch`, { mobile: false }],
    ['POST', `${API}/groups/${UUID}/join`, {}],
    ['POST', `${API}/groups/${UUID}/messages`, { content: 'synthetic' }],
    ['POST', `${API}/member-rewards/daily`, {}],
    ['GET', `${API}/member-rewards`, undefined],
    ['POST', `${API}/member-rewards/activity`, {}],
    ['GET', `${API}/member-rewards/admin`, undefined],
    ['GET', `${API}/play-together/admin/settings`, undefined],
  ] as const)('anonymous %s %s is refused', async (method, url, payload) => {
    const response = await server.inject({
      method,
      url,
      remoteAddress: '10.80.0.1',
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false });
    expect(response.json().data).toBeUndefined();
  });

  it('answers an unsigned provider wallet callback with the protocol rejection', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/sg/callback?action=balance',
      remoteAddress: '10.80.0.2',
    });
    expect(response.json()).toEqual({ error: 2, balance: 0 });
  });
});
