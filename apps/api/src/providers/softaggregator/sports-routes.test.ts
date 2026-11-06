import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  users: new Map<string, any>(),
  snapshot: vi.fn(),
  launch: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({
  prisma: {
    user: { findUnique: async ({ where }: any) => f.users.get(where.id) ?? null },
    $queryRaw: (...args: any[]) => f.query(...args),
  },
}));
vi.mock('./sports-client.js', () => ({
  createSportsbook: () => ({
    wallet: { snapshot: f.snapshot },
    browseReady: () => true,
    launch: f.launch,
  }),
}));
import { sportsRoutes } from './sports-routes.js';
beforeEach(() => {
  f.users.clear();
  f.users.set('member', { status: 'ACTIVE', tokenVersion: 0 });
  f.snapshot.mockResolvedValue({
    balanceMinor: 0,
    rewardBalanceMinor: 0,
    liveEnabled: false,
    canBet: false,
    currency: 'ETB',
    reason: 'not-live',
  });
  f.query.mockResolvedValue([]);
  f.launch.mockResolvedValue({ url: 'https://sports.example.com', mode: 'real-wallet' });
});
afterEach(() => { vi.resetAllMocks(); });
async function app() {
  const s = Fastify();
  await s.register(jwt, { secret: 'isolated-sports-routes-secret-32' });
  await s.register(sportsRoutes, { prefix: '/sportsbook' });
  await s.ready();
  return s;
}
function headers(s: any, id = 'member') {
  return {
    authorization: `Bearer ${s.jwt.sign({ sub: id, username: id, email: `${id}@example.test`, roles: ['USER'], tokenVersion: 0 })}`,
  };
}
it('returns the real zero wallet and owner-scoped activity without provisioning money', async () => {
  const s = await app();
  try {
    const r = await s.inject({ url: '/sportsbook/status', headers: headers(s) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.json().data).toMatchObject({ balanceMinor: 0, canBet: false, mode: 'real-wallet' });
    await s.inject({ url: '/sportsbook/activity', headers: headers(s) });
    expect(f.query.mock.calls[0][1]).toBe('member');
    expect(f.launch).not.toHaveBeenCalled();
  } finally {
    await s.close();
  }
});
it.each(['anonymous', 'SUSPENDED', 'INACTIVE', 'deleted', 'revoked'])(
  'rejects %s access on every sports endpoint',
  async (state) => {
    const s = await app();
    if (state === 'deleted') f.users.clear();
    else if (state !== 'anonymous')
      f.users.set('member', {
        status: state === 'revoked' ? 'ACTIVE' : state,
        tokenVersion: state === 'revoked' ? 1 : 0,
      });
    try {
      for (const path of ['status', 'activity', 'launch']) {
        const r = await s.inject({
          url: `/sportsbook/${path}`,
          method: path === 'launch' ? 'POST' : 'GET',
          ...(state !== 'anonymous' ? { headers: headers(s) } : {}),
          ...(path === 'launch' ? { payload: {} } : {}),
        });
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        expect(r.statusCode).toBeLessThan(500);
      }
      expect(f.snapshot).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  }
);
it('only accepts device choice, not caller-selected balances, countries, players or games', async () => {
  const s = await app();
  try {
    for (const payload of [
      { balance: 1000 },
      { country: 'GB' },
      { userId: 'someone' },
      { gameId: 'casino/slot' },
    ]) {
      const r = await s.inject({
        method: 'POST',
        url: '/sportsbook/launch',
        headers: headers(s),
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
    expect(f.launch).not.toHaveBeenCalled();
    expect(
      (
        await s.inject({
          method: 'POST',
          url: '/sportsbook/launch',
          headers: headers(s),
          payload: { mobile: true },
        })
      ).statusCode
    ).toBe(200);
    expect(f.launch).toHaveBeenCalledWith('member', true);
  } finally {
    await s.close();
  }
});
