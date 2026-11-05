import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerTestRoutes } from './test-routes.js';

vi.mock('@socialplay/config', () => ({ config: { NODE_ENV: 'test' } }));

const mocks = vi.hoisted(() => ({
  users: new Map<string, { status: string; tokenVersion: number }>(),
  query: vi.fn(),
  transaction: vi.fn(),
  transport: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({
  prisma: {
    user: { findUnique: async ({ where }: any) => mocks.users.get(where.id) ?? null },
    $transaction: (...args: any[]) => mocks.transaction(...args),
  },
}));

beforeEach(() => {
  mocks.users.clear();
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.transaction.mockReset().mockImplementation((fn: any) => fn({ $queryRaw: mocks.query }));
  mocks.transport.mockReset().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: 0,
          response: [{ id_hash: 'fixture-slot', name: 'Fixture Slot' }],
        })
      )
  );
  vi.stubGlobal('fetch', mocks.transport);
  for (const [key, value] of Object.entries({
    SOFTAGGREGATOR_TEST_ENABLED: 'true',
    SOFTAGGREGATOR_TEST_CALLBACK_ENABLED: 'true',
    SOFTAGGREGATOR_TEST_ACCESS_MODE: 'all-active',
    SOFTAGGREGATOR_TEST_USER_IDS: '',
    SOFTAGGREGATOR_API_LOGIN: 'fixture',
    SOFTAGGREGATOR_API_PASSWORD: 'fixture',
    SOFTAGGREGATOR_SALT_KEY: 'fixture-salt-not-a-secret',
    SOFTAGGREGATOR_TEST_LAUNCH_HOSTS: 'games.example.com',
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function server() {
  const s = Fastify();
  await s.register(jwt, { secret: 'local-fixture-only-casino-auth-key' });
  await s.register(providerTestRoutes, { prefix: '/provider-test' });
  await s.ready();
  return s;
}
function auth(s: Awaited<ReturnType<typeof server>>, id: string) {
  return {
    authorization: `Bearer ${s.jwt.sign({ sub: id, username: id, email: `${id}@example.com`, roles: ['USER'], tokenVersion: 0 })}`,
  };
}

it('admits existing and newly registered active members through real authentication without editing a list', async () => {
  mocks.users.set('existing', { status: 'ACTIVE', tokenVersion: 0 });
  const s = await server();
  try {
    mocks.users.set('registered-after-startup', { status: 'ACTIVE', tokenVersion: 0 });
    for (const id of ['existing', 'registered-after-startup']) {
      const headers = auth(s, id);
      const status = await s.inject({ url: '/provider-test/status', headers });
      expect(status.statusCode).toBe(200);
      expect(status.json().data).toMatchObject({
        enabled: true,
        unavailableReason: null,
        launchReady: true,
      });
      expect(status.headers['cache-control']).toContain('no-store');
      expect((await s.inject({ url: '/provider-test/games', headers })).json().data).toHaveLength(
        1
      );
      expect((await s.inject({ url: '/provider-test/wallet', headers })).json().data).toMatchObject(
        { balanceCents: 100000, created: false }
      );
      expect(mocks.query.mock.calls.at(-1)?.[1]).toBe(id);
    }
  } finally {
    await s.close();
  }
});

it.each(['anonymous', 'SUSPENDED', 'INACTIVE', 'PENDING_VERIFICATION', 'deleted', 'revoked'])(
  'blocks %s access to every casino endpoint',
  async (state) => {
    if (!['anonymous', 'deleted'].includes(state))
      mocks.users.set('member', {
        status: state === 'revoked' ? 'ACTIVE' : state,
        tokenVersion: state === 'revoked' ? 1 : 0,
      });
    const s = await server();
    try {
      const headers = state === 'anonymous' ? {} : auth(s, 'member');
      for (const path of ['status', 'games', 'wallet', 'launch']) {
        const result = await s.inject({
          method: path === 'launch' ? 'POST' : 'GET',
          url: `/provider-test/${path}`,
          headers,
          ...(path === 'launch' ? { payload: { gameId: 'fixture-slot' } } : {}),
        });
        expect(result.statusCode).toBe(['anonymous', 'revoked'].includes(state) ? 401 : 403);
      }
      expect(mocks.transport).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  }
);

it('withdraws access immediately after suspension even when the signed token remains valid', async () => {
  mocks.users.set('member', { status: 'ACTIVE', tokenVersion: 0 });
  const s = await server();
  try {
    const headers = auth(s, 'member');
    expect((await s.inject({ url: '/provider-test/status', headers })).json().data.enabled).toBe(
      true
    );
    mocks.users.set('member', { status: 'SUSPENDED', tokenVersion: 0 });
    expect((await s.inject({ url: '/provider-test/status', headers })).statusCode).toBe(403);
  } finally {
    await s.close();
  }
});
