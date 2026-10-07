const currentUser = vi.hoisted(() => vi.fn(async () => ({ status: 'ACTIVE' })));
vi.mock('@socialplay/database', () => ({ prisma: { user: { findUnique: currentUser } } }));
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { config } from '@socialplay/config';
import { authenticate } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { registerPlugins } from './index.js';

const server = Fastify();
beforeAll(async () => {
  await registerPlugins(server);
  server.setErrorHandler(errorHandler);
  server.get('/protected', { preHandler: authenticate }, async () => {
    return { ok: true };
  });
  await server.ready();
});
afterAll(() => server.close());
function token(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: 'boundary-test', exp: Math.floor(Date.now() / 1000) + 60, ...claims })
  ).toString('base64url');
  const signature = createHmac('sha256', config.JWT_ACCESS_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}
describe('access JWT trust boundary', () => {
  it.each(['header', 'cookie'])(
    'accepts intended issuer/audience through %s',
    async (transport) => {
      const value = token({ iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE });
      const headers =
        transport === 'cookie'
          ? { cookie: `sp_access_token=${value}` }
          : { authorization: `Bearer ${value}` };
      expect((await server.inject({ url: '/protected', headers })).statusCode).toBe(200);
    }
  );
  it.each([
    { iss: 'other-issuer', aud: config.JWT_AUDIENCE },
    { iss: config.JWT_ISSUER, aud: 'other-audience' },
    { aud: config.JWT_AUDIENCE },
    { iss: config.JWT_ISSUER },
  ])('rejects a correctly signed token with invalid claims %j', async (claims) => {
    expect(
      (
        await server.inject({
          url: '/protected',
          headers: { authorization: `Bearer ${token(claims)}` },
        })
      ).statusCode
    ).toBe(401);
    expect(() => server.jwt.verify(token(claims))).toThrow();
  });
  it('applies valid issuer and audience when signing with the plugin', () => {
    const value = server.jwt.sign({ sub: 'plugin-signer' });
    expect(server.jwt.verify(value)).toMatchObject({
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
    });
  });
});
