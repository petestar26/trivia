import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { prisma as owner, PrismaClient } from '@socialplay/database';
import { config } from '@socialplay/config';
import { authRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { registerWebSocket } from '../ws/index.js';
import { getSocketServer } from '../realtime/broadcast.js';
import { generateTokens, hashPassword } from '../utils/auth.js';

/**
 * All-device logout revokes access tokens as well as refresh sessions, on
 * real PostgreSQL, across two separate API instances (this process and a
 * spawned child), over HTTP and WebSockets, through a column-restricted login.
 * Disposable local database and synthetic accounts only.
 */
const base = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  base.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Disposable local database required');

// The real member socket client, as installed by the web app.
const { io } = createRequire(new URL('../../../web/package.json', import.meta.url))('socket.io-client');
const s = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `lr_auth_${s}`;
const rolePassword = randomUUID();
const password = 'Synthetic-Member-1!';
const origin = new URL(config.FRONTEND_URL).origin;
const exec = (sql: string) => owner.$executeRawUnsafe(sql);
let restricted: PrismaClient;
let appA: FastifyInstance;
let addressA: string;
let addressB: string;
let child: ChildProcess;
const sockets: any[] = [];

function restrictedUrl() {
  const url = new URL(base);
  url.username = role;
  url.password = rolePassword;
  return url.toString();
}

beforeAll(async () => {
  await exec(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`
  );
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO "${role}"`,
    `GRANT SELECT (id, email, username, role, status, "tokenVersion", "passwordHash", "displayName", "createdAt", "isVerified", bio, "avatarUrl", "lastLoginAt") ON public.users TO "${role}"`,
    // Logout advances tokenVersion; sign-in records lastLoginAt.
    `GRANT UPDATE ("lastLoginAt", "updatedAt", "tokenVersion") ON public.users TO "${role}"`,
    `GRANT SELECT (id, "userId", provider, "providerSubject") ON public.user_auth_identities TO "${role}"`,
    `GRANT SELECT (id, "userId", "refreshToken", "expiresAt") ON public.sessions TO "${role}"`,
    `GRANT INSERT, DELETE ON public.sessions TO "${role}"`,
  ])
    await exec(sql);
  restricted = new PrismaClient({ datasourceUrl: restrictedUrl(), log: [] });

  // Instance A: this process (HTTP + WebSocket).
  appA = Fastify({ logger: false });
  await appA.register(cookie);
  await appA.register(jwt, { secret: config.JWT_ACCESS_SECRET, cookie: { cookieName: 'sp_access_token', signed: false } });
  await appA.register(rateLimit, { max: 1000 });
  appA.setErrorHandler(errorHandler);
  await appA.register(authRoutes, { prefix: '/auth', db: restricted, credentialDb: restricted });
  registerWebSocket(appA);
  addressA = await appA.listen({ port: 0, host: '127.0.0.1' });

  // Instance B: a separate process with its own pool and socket server,
  // bundled with the same esbuild settings as the production build.js.
  const outdir = fileURLToPath(new URL('../../node_modules/.cache/staff-native-fixtures/', import.meta.url));
  await build({
    entryPoints: [fileURLToPath(new URL('./logout-instance.fixture.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outdir,
    external: ['@prisma/client'],
    packages: 'external',
    logLevel: 'silent',
  });
  child = spawn(process.execPath, [join(outdir, 'logout-instance.fixture.js')], {
    env: { ...process.env, DATABASE_URL: restrictedUrl(), LOGOUT_FIXTURE_ACK: 'disposable' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  addressB = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('instance B did not start')), 45_000);
    let errors = '';
    child.stderr!.on('data', (chunk) => (errors += chunk));
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /READY (\S+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`instance B exited ${code}: ${errors.slice(0, 500)}`)));
  });
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  child?.kill('SIGTERM');
  await new Promise<void>((resolve) => getSocketServer()?.close(() => resolve()) ?? resolve());
  await appA?.close();
  await restricted?.$disconnect();
  await exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`).catch(() => undefined);
  await exec(`DROP OWNED BY "${role}"`).catch(() => undefined);
  await exec(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
  await owner.$disconnect();
});

const post = async (address: string, path: string, init: { body?: unknown; bearer?: string; cookies?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.cookies) Object.assign(headers, { cookie: init.cookies, origin });
  const response = await fetch(address + path, { method: 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely shaped API responses
  const json: any = await response.json().catch(() => null);
  return { status: response.status, json, setCookie: response.headers.getSetCookie() };
};
const me = async (address: string, bearer: string) =>
  (await fetch(`${address}/auth/me`, { headers: { authorization: `Bearer ${bearer}` } })).status;
const version = async (id: string) => (await owner.user.findUniqueOrThrow({ where: { id } })).tokenVersion;
const sessions = (userId: string) => owner.session.count({ where: { userId } });

async function member(tag: string) {
  const user = await owner.user.create({
    data: { username: `lr_${tag}_${s}`.slice(0, 30), email: `${tag}_${s}@fixture.invalid`, passwordHash: await hashPassword(password) },
  });
  return user;
}
async function login(address: string, email: string) {
  const r = await post(address, '/auth/login', { body: { email, password } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.data as { accessToken: string; refreshToken: string };
}
function connect(address: string, token: string): Promise<any> {
  const socket = io(address, { path: config.WS_PATH, transports: ['websocket'], auth: { token }, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), 8000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
}
const disconnected = (socket: any) =>
  new Promise<string>((resolve, reject) => {
    if (socket.disconnected) return resolve('already');
    const timer = setTimeout(() => reject(new Error('socket stayed connected')), 8000);
    socket.once('disconnect', (reason: string) => { clearTimeout(timer); resolve(reason); });
  });

it('revokes access tokens on every instance, over HTTP and WebSockets, while the other device stays usable until then', async () => {
  const user = await member('multi');
  const deviceOne = await login(addressA, user.email!);
  const deviceTwo = await login(addressB, user.email!);
  expect(await me(addressB, deviceOne.accessToken)).toBe(200);

  const onA = await connect(addressA, deviceOne.accessToken);
  const onBDelivery = await connect(addressB, deviceTwo.accessToken);
  const onBPacket = await connect(addressB, deviceTwo.accessToken);
  // Control: a private delivery on B reaches the socket before logout.
  const received: number[] = [];
  onBDelivery.on('fixture:private', (m: { n: number }) => received.push(m.n));
  await post(addressB, '/__fixture/deliver', { body: { userId: user.id, n: 1 } });
  await new Promise((r) => setTimeout(r, 300));
  expect(received).toEqual([1]);

  const before = await version(user.id);
  const out = await post(addressA, '/auth/logout', { bearer: deviceOne.accessToken });
  expect(out.status).toBe(200);
  expect(await version(user.id)).toBe(before + 1);
  expect(await sessions(user.id)).toBe(0);

  // HTTP: both devices' access tokens fail on both instances; refresh fails too.
  for (const address of [addressA, addressB])
    for (const token of [deviceOne.accessToken, deviceTwo.accessToken]) expect(await me(address, token)).toBe(401);
  expect((await post(addressB, '/auth/refresh', { body: { refreshToken: deviceTwo.refreshToken } })).status).toBe(401);

  // WebSockets: A's socket is disconnected at once by the handling instance.
  await disconnected(onA);
  // B did not handle the logout: its sockets are refused at the next delivery
  // or packet, and never receive the private event.
  await post(addressB, '/__fixture/deliver', { body: { userId: user.id, n: 2 } });
  await disconnected(onBDelivery);
  expect(received).toEqual([1]);
  const ack = onBPacket.timeout(2000).emitWithAck('group:leave', { groupId: randomUUID() }).catch(() => 'no-ack');
  await disconnected(onBPacket);
  expect(await ack).not.toMatchObject({ success: true });
  // New handshakes with the old token are refused on both instances.
  for (const address of [addressA, addressB])
    await expect(connect(address, deviceTwo.accessToken)).rejects.toThrow('UNAUTHORIZED');
});

it('repeated logout is idempotent and advances the version exactly once', async () => {
  const user = await member('repeat');
  const t = await login(addressA, user.email!);
  const before = await version(user.id);
  const first = await post(addressA, '/auth/logout', { bearer: t.accessToken });
  const second = await post(addressB, '/auth/logout', { bearer: t.accessToken });
  const third = await post(addressA, '/auth/logout', { cookies: `sp_access_token=${t.accessToken}; sp_refresh_token=${t.refreshToken}` });
  expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
  expect(await version(user.id)).toBe(before + 1);
  expect(third.setCookie.some((c) => c.startsWith('sp_access_token=;'))).toBe(true);
});

it('logs out with an expired access cookie through the stored refresh session, revoking other devices', async () => {
  const user = await member('expired');
  const cookieDevice = await login(addressA, user.email!);
  const otherDevice = await login(addressB, user.email!);
  const expired = appA.jwt.sign(
    { sub: user.id, email: user.email, username: user.username, roles: ['USER'], tokenVersion: user.tokenVersion, iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) - 60 },
  );
  const before = await version(user.id);
  const out = await post(addressA, '/auth/logout', { cookies: `sp_access_token=${expired}; sp_refresh_token=${cookieDevice.refreshToken}` });
  expect(out.status).toBe(200);
  expect(await version(user.id)).toBe(before + 1);
  expect(await me(addressB, otherDevice.accessToken)).toBe(401);
  expect(await sessions(user.id)).toBe(0);
});

it('cannot revoke anything with only an expired access cookie, and says so by changing nothing', async () => {
  const user = await member('nocred');
  const live = await login(addressA, user.email!);
  const expired = appA.jwt.sign(
    { sub: user.id, roles: ['USER'], tokenVersion: user.tokenVersion, iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) - 60 },
  );
  const before = await version(user.id);
  const out = await post(addressA, '/auth/logout', { cookies: `sp_access_token=${expired}` });
  expect(out.status).toBe(200);
  expect(await version(user.id)).toBe(before);
  expect(await me(addressA, live.accessToken)).toBe(200);
});

it('rolls back completely when either half of the revocation fails', async () => {
  const user = await member('rollback');
  const t = await login(addressA, user.email!);
  const before = await version(user.id);
  for (const [revoke, restore] of [
    [`REVOKE UPDATE ("tokenVersion") ON public.users FROM "${role}"`, `GRANT UPDATE ("tokenVersion") ON public.users TO "${role}"`],
    [`REVOKE DELETE ON public.sessions FROM "${role}"`, `GRANT DELETE ON public.sessions TO "${role}"`],
  ]) {
    await exec(revoke);
    try {
      const out = await post(addressA, '/auth/logout', { cookies: `sp_access_token=${t.accessToken}; sp_refresh_token=${t.refreshToken}` });
      expect(out.status).toBe(500);
      expect(out.setCookie).toHaveLength(0);
      expect(await version(user.id)).toBe(before);
      expect(await sessions(user.id)).toBe(1);
      expect(await me(addressA, t.accessToken)).toBe(200);
    } finally {
      await exec(restore);
    }
  }
  expect((await post(addressA, '/auth/logout', { bearer: t.accessToken })).status).toBe(200);
  expect(await version(user.id)).toBe(before + 1);
});

it('a refresh that is mid-rotation when logout arrives cannot leave a usable or surviving session', async () => {
  const user = await member('midrotation');
  const t = await login(addressA, user.email!);
  const [row] = await owner.$queryRaw<{ id: string }[]>`SELECT id FROM sessions WHERE "refreshToken" = ${t.refreshToken}`;
  // Hold the session row so the refresh stops after locking the account and
  // re-checking its version; logout then has to wait for it.
  const blocker = new PrismaClient({ log: [] });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holding = blocker.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${row.id} FOR UPDATE`;
    await held;
  }, { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 200));
  const refreshing = post(addressA, '/auth/refresh', { body: { refreshToken: t.refreshToken } });
  await new Promise((r) => setTimeout(r, 300));
  const loggingOut = post(addressA, '/auth/logout', { bearer: t.accessToken });
  await new Promise((r) => setTimeout(r, 300));
  release();
  await holding;
  await blocker.$disconnect();
  const [refresh, out] = await Promise.all([refreshing, loggingOut]);
  expect(refresh.status).toBe(200);
  expect(out.status).toBe(200);
  // Logout waited for the rotation and then deleted the session it created.
  expect(await sessions(user.id)).toBe(0);
  expect((await post(addressA, '/auth/refresh', { body: { refreshToken: refresh.json.data.refreshToken } })).status).toBe(401);
  expect(await me(addressB, refresh.json.data.accessToken)).toBe(401);
});

it('under concurrent refresh and logout, no surviving session and no usable token remain', async () => {
  for (let round = 0; round < 15; round++) {
    const user = await member(`race${round}`);
    // Issue the session exactly as /auth/login does (same generator, same
    // row); the anonymous sign-in rate limit is not what this test exercises.
    const t = generateTokens(user.id, user.email, user.username, ['USER'], user.tokenVersion);
    await owner.session.create({ data: { userId: user.id, refreshToken: t.refreshToken, expiresAt: new Date(Date.now() + 3_600_000) } });
    const before = await version(user.id);
    const [refresh, out] = await Promise.all([
      post(round % 2 ? addressA : addressB, '/auth/refresh', { body: { refreshToken: t.refreshToken } }),
      post(round % 2 ? addressB : addressA, '/auth/logout', { bearer: t.accessToken }),
    ]);
    expect(out.status, `round ${round}`).toBe(200);
    expect([200, 401], `round ${round}`).toContain(refresh.status);
    expect(await version(user.id), `round ${round}`).toBe(before + 1);
    expect(await sessions(user.id), `round ${round}`).toBe(0);
    if (refresh.status === 200) {
      expect(await me(addressA, refresh.json.data.accessToken), `round ${round}`).toBe(401);
      expect((await post(addressB, '/auth/refresh', { body: { refreshToken: refresh.json.data.refreshToken } })).status).toBe(401);
    }
    expect(await me(addressB, t.accessToken), `round ${round}`).toBe(401);
  }
});
