import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ users: vi.fn(), members: vi.fn() }));
vi.mock('@socialplay/database', () => ({
  prisma: { user: { findMany: m.users }, groupMember: { findMany: m.members } },
}));
import { emitToGroup, emitToUser, setSocketServer } from './broadcast.js';
const socket = (id: string) => ({
  id,
  data: { user: { id }, expiresAt: Date.now() + 60000 },
  emit: vi.fn(),
  leave: vi.fn(),
  disconnect: vi.fn(),
});
let sockets: ReturnType<typeof socket>[];
beforeEach(() => {
  vi.resetAllMocks();
  sockets = ['active', 'removed', 'suspended', 'expired'].map(socket);
  sockets[3].data.expiresAt = 0;
  setSocketServer({ in: () => ({ fetchSockets: async () => sockets }) } as any);
  m.users.mockResolvedValue([{ id: 'active' }, { id: 'removed' }, { id: 'expired' }]);
  m.members.mockResolvedValue([
    { userId: 'active' },
    { userId: 'suspended' },
    { userId: 'expired' },
  ]);
});
it('delivers only to current active members, evicts removed members and disconnects revoked sessions', async () => {
  await emitToGroup('group', 'message:created', { body: 'private' });
  expect(sockets[0].emit).toHaveBeenCalledTimes(1);
  expect(sockets[1].leave).toHaveBeenCalledWith('group:group');
  expect(sockets[2].disconnect).toHaveBeenCalledWith(true);
  expect(sockets[3].disconnect).toHaveBeenCalledWith(true);
  for (const s of sockets.slice(1)) expect(s.emit).not.toHaveBeenCalled();
});
it('fails closed when the membership query fails', async () => {
  m.members.mockRejectedValue(new Error('Unavailable'));
  await emitToGroup('group', 'message:created', {});
  for (const s of sockets) expect(s.emit).not.toHaveBeenCalled();
});
it('excludes the sender from typing delivery and checks suspension for private events', async () => {
  await emitToGroup('group', 'typing:start', {}, 'active');
  expect(sockets[0].emit).not.toHaveBeenCalled();
  await emitToUser('suspended', 'notification', {});
  expect(sockets[2].emit).not.toHaveBeenCalled();
});
