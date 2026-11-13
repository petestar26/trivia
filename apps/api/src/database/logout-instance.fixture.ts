/**
 * Test-only second API instance for logout-revocation.native.ts. Never part of
 * the application: it is spawned as a separate process so its socket server,
 * database pool and in-process state are genuinely separate from the test
 * process (instance A). It serves the real auth routes and the real WebSocket
 * server on DATABASE_URL (a column-restricted login in the test), plus one
 * fixture route that triggers a real private delivery through emitToUser.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { authRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { registerWebSocket } from '../ws/index.js';
import { emitToUser } from '../realtime/broadcast.js';

if (process.env.LOGOUT_FIXTURE_ACK !== 'disposable') throw new Error('Disposable fixture only');

const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(jwt, {
  secret: config.JWT_ACCESS_SECRET,
  cookie: { cookieName: 'sp_access_token', signed: false },
});
await app.register(rateLimit, { max: 1000 });
app.setErrorHandler(errorHandler);
await app.register(authRoutes, { prefix: '/auth', db: prisma, credentialDb: prisma });
app.post<{ Body: { userId: string; n: number } }>('/__fixture/deliver', async (request) => {
  await emitToUser(request.body.userId, 'fixture:private', { n: request.body.n });
  return { delivered: true };
});
registerWebSocket(app);
const address = await app.listen({ port: 0, host: '127.0.0.1' });
process.stdout.write(`READY ${address}\n`);
const stop = async () => {
  await app.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
