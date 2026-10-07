import { expect, it, vi } from 'vitest';
const lookup = vi.hoisted(() => vi.fn());
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: lookup } } }));
import { authenticate, optionalAuth, requirePermission, requireRole } from './auth.js';
it.each([{ role: 'USER', status: 'ACTIVE' }, { role: 'ADMIN', status: 'BANNED' }, null])(
  'rejects stale admin claims when current authority is %j',
  async (actor) => {
    lookup.mockResolvedValue(actor);
    await expect(
      requirePermission('withdrawal:admin')(
        { user: { sub: 'u', roles: ['ADMIN'] } } as any,
        {} as any
      )
    ).rejects.toThrow('Permission required');
  }
);
it('permits an active administrator based on the current database role', async () => {
  lookup.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
  await expect(
    requirePermission('agent:review')({ user: { sub: 'u', roles: ['USER'] } } as any, {} as any)
  ).resolves.toBeUndefined();
});

it('rejects a stale super-admin role at the ledger boundary', async () => {
  lookup.mockResolvedValue({ role: 'USER', status: 'ACTIVE' });
  await expect(
    requireRole('SUPER_ADMIN')({ user: { sub: 'u', roles: ['SUPER_ADMIN'] } } as any, {} as any)
  ).rejects.toThrow('Insufficient permissions');
});

it.each(['SUSPENDED', 'BANNED', 'DELETED'])(
  'rejects an otherwise valid token for %s member reads',
  async (status) => {
    lookup.mockResolvedValue({ status });
    const request = { jwtVerify: vi.fn(async () => ({ sub: 'u' })) } as any;
    await expect(authenticate(request, {} as any)).rejects.toMatchObject({ statusCode: 403 });
  }
);
it('preserves a database error instead of reporting invalid credentials', async () => {
  lookup.mockRejectedValue(new Error('database unavailable'));
  await expect(
    authenticate({ jwtVerify: vi.fn(async () => ({ sub: 'u' })) } as any, {} as any)
  ).rejects.toThrow('database unavailable');
});
it('does not grant optional authenticated access to a suspended account', async () => {
  lookup.mockResolvedValue({ status: 'SUSPENDED' });
  const request = {
    headers: { authorization: 'Bearer fixture' },
    user: { sub: 'u' },
    jwtVerify: vi.fn(async () => ({ sub: 'u' })),
  } as any;
  await optionalAuth(request, {} as any);
  expect(request.user).toBeUndefined();
});
