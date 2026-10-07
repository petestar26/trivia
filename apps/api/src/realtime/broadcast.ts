import { Server } from 'socket.io';
import { prisma } from '@socialplay/database';

let io: Server | null = null;
export function setSocketServer(server: Server): void {
  io = server;
}
export function getSocketServer(): Server | null {
  return io;
}

// Rooms are delivery subscriptions, not durable authorization. Recheck each
// recipient immediately before delivery so removal/suspension cannot leave a
// stale subscription receiving private data. Fail closed on lookup failure.
async function deliver(
  room: string,
  event: string,
  data: unknown,
  groupId?: string,
  excludeSocketId?: string
) {
  if (!io) return;
  const sockets = await io.in(room).fetchSockets();
  if (!sockets.length) return;
  const ids = [
    ...new Set(
      sockets.map((s) => s.data.user?.id).filter((id): id is string => typeof id === 'string')
    ),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, status: 'ACTIVE' },
    select: { id: true },
  });
  const active = new Set(users.map((u) => u.id));
  const members = groupId
    ? await prisma.groupMember.findMany({
        where: { groupId, userId: { in: ids }, status: 'ACTIVE' },
        select: { userId: true },
      })
    : null;
  const allowed = members ? new Set(members.map((m) => m.userId)) : active;
  for (const socket of sockets) {
    const id = socket.data.user?.id;
    if (
      !active.has(id) ||
      !Number.isFinite(socket.data.expiresAt) ||
      socket.data.expiresAt <= Date.now()
    ) {
      socket.disconnect(true);
    } else if (!allowed.has(id)) {
      await socket.leave(room);
    } else if (socket.id !== excludeSocketId) {
      socket.emit(event, data);
    }
  }
}
export function emitToUser(userId: string, event: string, data: unknown): Promise<void> {
  return deliver(`user:${userId}`, event, data).catch(() => {
    /* no delivery when authorization is unavailable */
  });
}
export function emitToGroup(
  groupId: string,
  event: string,
  data: unknown,
  excludeSocketId?: string
): Promise<void> {
  return deliver(`group:${groupId}`, event, data, groupId, excludeSocketId).catch(() => {
    /* fail closed */
  });
}
