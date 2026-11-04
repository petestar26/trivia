import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { request as httpRequest, type ClientRequest } from 'node:http';

const mock = vi.hoisted(() => ({
  db: { group: { findUnique: vi.fn() }, groupMember: { findUnique: vi.fn() }, $transaction: vi.fn() },
  tx: { $queryRaw: vi.fn(), $executeRaw: vi.fn(), message: { create: vi.fn(), update: vi.fn() }, voiceMessage: { create: vi.fn(), findUnique: vi.fn() } },
  storage: { upload: vi.fn(), delete: vi.fn() }, authenticate: vi.fn(), activity: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({ prisma: mock.db }));
vi.mock('@socialplay/storage', () => ({ storage: mock.storage, generateStorageKey: () => 'test-owned-key' }));
vi.mock('../middleware/index.js', () => ({
  authenticate: mock.authenticate,
  ApiError: Object.fromEntries(['badRequest', 'notFound', 'forbidden', 'conflict'].map((key, i) => [key, (message: string) => Object.assign(new Error(message), { statusCode: [400, 404, 403, 409][i] })])),
}));
vi.mock('../groups/lifecycle.js', () => ({ lockSocialGroup: vi.fn() }));
vi.mock('../routes/group-locks.js', () => ({
  lockGroupForAdmission: async () => ({ status: 'ACTIVE', expiresAt: new Date('2099-01-01') }),
  lockActorMembership: async () => ({ status: 'ACTIVE', role: 'MEMBER' }),
  lockGroupMessageForDeletion: async () => ({ id: 'message', userId: 'actor', isDeleted: false }),
}));
vi.mock('../rewards/activity-service.js', () => ({ safeRecordActivity: mock.activity }));
vi.mock('../realtime/broadcast.js', () => ({ emitToGroup: mock.broadcast }));
vi.mock('../gift-collection/service.js', () => ({ giftCardsForMessages: vi.fn() }));
vi.mock('../realtime/reaction-service.js', () => ({ setMessageReaction: vi.fn() }));

import { chatRoutes } from '../routes/chat.js';
import { mediaMaintenance } from './maintenance.js';

const GROUP = '00000000-0000-4000-8000-000000000001';
const MESSAGE = '00000000-0000-4000-8000-000000000002';
const VOICE = `/api/v1/groups/${GROUP}/voice-messages`;
const DELETE = `/api/v1/groups/${GROUP}/messages/${MESSAGE}`;
const body = Buffer.from('--test\r\nContent-Disposition: form-data; name="duration"\r\n\r\n1\r\n--test\r\nContent-Disposition: form-data; name="file"; filename="test.ogg"\r\nContent-Type: audio/ogg\r\n\r\naudio\r\n--test--\r\n');
function held() {
  let release!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  return { release, reached, wait: async () => { entered(); await pending; } };
}
let server: ReturnType<typeof Fastify>;
let clients: ClientRequest[];
beforeEach(async () => {
  vi.resetAllMocks(); clients = [];
  mock.authenticate.mockImplementation(async (request: any) => { request.user = { sub: 'actor' }; });
  mock.db.group.findUnique.mockResolvedValue({ id: GROUP });
  mock.db.groupMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
  mock.db.$transaction.mockImplementation(async (callback: any) => callback(mock.tx));
  mock.tx.$queryRaw.mockResolvedValue([{ status: 'ACTIVE', now: new Date() }]);
  mock.tx.voiceMessage.findUnique.mockResolvedValue({ storageKey: 'test-owned-key' });
  mock.tx.message.create.mockResolvedValue({ id: MESSAGE, type: 'VOICE' });
  mock.tx.voiceMessage.create.mockResolvedValue({ id: 'voice', storageKey: 'test-owned-key' });
  server = Fastify(); await server.register(multipart);
  await server.register(chatRoutes, { prefix: '/api/v1/groups' });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const gate = mediaMaintenance(server);
  // TEST ONLY identity. Production reads the actual environment at creation.
  Object.defineProperty(gate, 'identity', { value: Object.freeze(Object.fromEntries(['PROJECT', 'ENVIRONMENT', 'SERVICE', 'DEPLOYMENT'].map((field, i) => [`RAILWAY_${field}_ID`, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]))) });
  gate.configure(async () => {}, false);
});
afterEach(async () => { for (const client of clients) client.destroy(); await server.close(); });
function direct(method: 'POST' | 'DELETE', path: string): ClientRequest {
  const address = server.server.address() as import('node:net').AddressInfo;
  const client = httpRequest({ host: '127.0.0.1', port: address.port, path, method,
    headers: method === 'POST' ? { 'content-type': 'multipart/form-data; boundary=test', 'content-length': body.length } : {} });
  client.on('error', () => {}); clients.push(client); client.end(method === 'POST' ? body : undefined); return client;
}
async function refused() {
  const before = mock.authenticate.mock.calls.length;
  for (const [method, url] of [['POST', VOICE], ['DELETE', DELETE]] as const) {
    expect((await server.inject({ method, url })).statusCode).toBe(503);
  }
  expect(mock.authenticate.mock.calls.length).toBe(before);
}

describe('actual chat routes and voice service offline regressions', () => {
  it('holds POST through awaited transaction callback and compensating cleanup after client disconnect', async () => {
    const transaction = held(); const cleanup = held();
    mock.tx.message.create.mockImplementation(async () => { await transaction.wait(); throw new Error('DB write failed'); });
    mock.storage.delete.mockImplementation(cleanup.wait);
    const client = direct('POST', VOICE); await transaction.reached;
    client.destroy();
    const gate = mediaMaintenance(server);
    const receipt = gate.closeAndDrain(1000); let done = false; void receipt.then(() => { done = true; });
    await refused(); expect(gate.snapshot().active).toBe(1); expect(done).toBe(false);
    transaction.release(); await cleanup.reached;
    expect(gate.snapshot().active).toBe(1); expect(done).toBe(false);
    cleanup.release();
    expect(await receipt).toMatchObject({ drained: true, admitted: 1, settled: 1 });
  });

  it('holds DELETE through committed storage cleanup and broadcast DB callback after disconnect', async () => {
    const broadcast = held(); const cleanup = held();
    mock.broadcast.mockImplementation(broadcast.wait); mock.storage.delete.mockImplementation(cleanup.wait);
    const client = direct('DELETE', DELETE); await broadcast.reached; client.destroy();
    const gate = mediaMaintenance(server); const receipt = gate.closeAndDrain(1000);
    await refused(); expect(gate.snapshot().active).toBe(1);
    broadcast.release(); await cleanup.reached;
    expect(mock.tx.message.update).toHaveBeenCalledOnce(); expect(gate.snapshot().active).toBe(1);
    cleanup.release(); expect(await receipt).toMatchObject({ drained: true, active: 0 });
  });

  it.each(['upload', 'compensation', 'delete'])('reports uncertain %s storage failure without a successful drain', async failure => {
    let partialBytes: Buffer | undefined;
    if (failure === 'upload') mock.storage.upload.mockImplementation(async () => { partialBytes = Buffer.from('partial'); throw new Error('ENOSPC'); });
    else mock.storage.delete.mockRejectedValue(new Error('storage unavailable'));
    if (failure === 'compensation') mock.tx.message.create.mockRejectedValue(new Error('DB failed'));
    const response = await server.inject(failure === 'delete' ? { method: 'DELETE', url: DELETE } : { method: 'POST', url: VOICE, headers: { 'content-type': 'multipart/form-data; boundary=test' }, payload: body });
    expect(response.statusCode).toBe(failure === 'delete' ? 200 : 500);
    if (failure === 'upload') { expect(partialBytes?.toString()).toBe('partial'); expect(mock.storage.delete).not.toHaveBeenCalled(); }
    expect(await mediaMaintenance(server).closeAndDrain(100)).toMatchObject({ drained: false, outcome: 'unresolved-cleanup', unresolvedCleanup: 1, active: 0 });
    await refused();
  });

  it('retains operation after response finish until postcommit activity DB work settles', async () => {
    const activity = held(); mock.activity.mockImplementation(activity.wait);
    const response = server.inject({ method: 'POST', url: VOICE, headers: { 'content-type': 'multipart/form-data; boundary=test' }, payload: body });
    await activity.reached; expect((await response).statusCode).toBe(201);
    const gate = mediaMaintenance(server); expect(gate.snapshot().active).toBe(1);
    expect(await gate.closeAndDrain(10)).toMatchObject({ outcome: 'timeout', drained: false });
    activity.release(); expect(await gate.closeAndDrain(100)).toMatchObject({ drained: true });
  });

  it('awaits early-response authentication work then blocks any handler entry', async () => {
    const auth = held();
    mock.authenticate.mockImplementation(async (_request: any, reply: any) => { reply.code(401).send({ error: 'auth' }); await auth.wait(); });
    const response = server.inject({ method: 'DELETE', url: DELETE });
    await auth.reached; expect((await response).statusCode).toBe(401);
    const gate = mediaMaintenance(server); expect(gate.snapshot().active).toBe(1);
    expect(await gate.closeAndDrain(10)).toMatchObject({ drained: false, outcome: 'timeout' });
    auth.release(); expect(await gate.closeAndDrain(100)).toMatchObject({ drained: true, settled: 1 });
    expect(mock.db.group.findUnique).not.toHaveBeenCalled();
  });

  it('does not release authentication on client abort while its DB callback is pending', async () => {
    const auth = held(); mock.authenticate.mockImplementation(auth.wait);
    const client = direct('DELETE', DELETE); await auth.reached; client.destroy();
    const gate = mediaMaintenance(server); expect(await gate.closeAndDrain(10)).toMatchObject({ outcome: 'timeout', active: 1 });
    auth.release(); expect(await gate.closeAndDrain(100)).toMatchObject({ drained: true });
    expect(mock.db.group.findUnique).not.toHaveBeenCalled();
  });

  it('fails closed for untracked earlier hook work instead of inferring settlement from a response', async () => {
    // Existing production media routes have no preValidation hook. An added
    // early-response hook must explicitly account for its asynchronous work.
    await server.close();
    const hook=held(); server=Fastify();
    server.addHook('preValidation',async (_request: import('fastify').FastifyRequest,reply: import('fastify').FastifyReply)=>{reply.code(403).send({error:'early'});await hook.wait();});
    await server.register(chatRoutes,{prefix:'/api/v1/groups'});
    const gate=mediaMaintenance(server);gate.configure(async()=>{},false);
    const response=server.inject({method:'DELETE',url:DELETE});await hook.reached;
    expect((await response).statusCode).toBe(403);
    expect(await gate.closeAndDrain(10)).toMatchObject({drained:false,active:1});
    hook.release();
    expect(await gate.closeAndDrain(10)).toMatchObject({drained:false,active:1});
    expect(mock.db.group.findUnique).not.toHaveBeenCalled();
  });
});
