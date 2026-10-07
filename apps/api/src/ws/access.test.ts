import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { config } from '@socialplay/config';
const m = vi.hoisted(() => ({ users: new Map<string, string>(), members: new Set<string>() }));
vi.mock('@socialplay/database', () => ({ prisma: {
  user: {
    findUnique: async ({ where }: any) => ({ status: m.users.get(where.id) }),
    findMany: async ({ where }: any) => where.id.in.filter((id: string) => m.users.get(id) === 'ACTIVE').map((id: string) => ({ id })),
  },
  groupMember: { findMany: async ({ where }: any) => where.userId.in.filter((id: string) => m.members.has(id)).map((userId: string) => ({ userId })) },
} }));
vi.mock('../realtime/chat-service.js', () => ({
  getGroupMembership: async (_groupId: string, userId: string) => m.members.has(userId) ? { status: 'ACTIVE' } : null,
  createMessage: vi.fn(),
}));
import { registerWebSocket } from './index.js';
import { emitToGroup, emitToUser, getSocketServer } from '../realtime/broadcast.js';
// Exercise the actual member client already installed by this monorepo.
const { io } = createRequire(new URL('../../../web/package.json', import.meta.url))('socket.io-client');
const server = Fastify();
const clients: any[] = [];
let address: string;
const groupId = '11111111-1111-4111-8111-111111111111';
beforeAll(async () => {
  await server.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  registerWebSocket(server);
  address = await server.listen({ port: 0, host: '127.0.0.1' });
});
beforeEach(() => { m.users.clear(); m.members.clear(); });
afterAll(async () => {
  for (const client of clients) client.disconnect();
  await new Promise<void>(resolve => getSocketServer()!.close(() => resolve()));
  await server.close();
});
function once(socket: any, event: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${event} event`)), 4000);
    socket.once(event, (value: unknown) => { clearTimeout(timeout); resolve(value); });
  });
}
function client(userId: string, exp = Math.floor(Date.now()/1000)+60) {
  const claims = { sub: userId, iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, exp };
  const socket = io(address, { path: config.WS_PATH, transports: ['websocket'], auth: { token: server.jwt.sign(claims) }, reconnection: false, autoConnect: false });
  clients.push(socket); return socket;
}
async function connect(userId: string) {
  m.users.set(userId, 'ACTIVE'); m.members.add(userId);
  const socket = client(userId); const ready = once(socket, 'connect'); socket.connect(); await ready;
  expect(await socket.timeout(4000).emitWithAck('group:join', { groupId })).toMatchObject({ success: true });
  return socket;
}
it.each(['SUSPENDED', 'BANNED', 'DELETED'])('rejects %s accounts during the actual handshake', async status => {
  m.users.set(status, status);
  const socket = client(status); const error = once(socket, 'connect_error'); socket.connect();
  expect((await error).message).toBe('UNAUTHORIZED');
  expect(socket.connected).toBe(false);
});
it('rejects expired tokens and disconnects a token when it expires', async () => {
  m.users.set('expiry', 'ACTIVE');
  const expired = client('expiry', Math.floor(Date.now()/1000)-1);
  const error = once(expired, 'connect_error'); expired.connect();
  expect((await error).message).toBe('UNAUTHORIZED');
  const short = client('expiry', Math.floor(Date.now()/1000)+2);
  const ready = once(short, 'connect'); short.connect(); await ready;
  expect(await once(short, 'disconnect')).toBe('io server disconnect');
});
it('delivers typing with a raw group ID, then evicts a removed recipient before private delivery', async () => {
  const sender = await connect('sender'), recipient = await connect('recipient');
  const typing = once(recipient, 'typing:start');
  expect(await sender.timeout(4000).emitWithAck('typing:start', { groupId })).toMatchObject({ success: true });
  expect(await typing).toMatchObject({ groupId, userId: 'sender' });
  const received = vi.fn(); recipient.on('message:created', received);
  m.members.delete('recipient');
  await emitToGroup(groupId, 'message:created', { private: true });
  const barrier = once(recipient, 'test:barrier');
  await emitToUser('recipient', 'test:barrier', {}); await barrier;
  expect(received).not.toHaveBeenCalled();
  expect([...getSocketServer()!.sockets.sockets.values()].find(s => s.data.user.id === 'recipient')!.rooms.has(`group:${groupId}`)).toBe(false);
  m.users.set('sender', 'SUSPENDED');
  const disconnected = once(sender, 'disconnect');
  await emitToUser('sender', 'private:event', {});
  expect(await disconnected).toBe('io server disconnect');
});
