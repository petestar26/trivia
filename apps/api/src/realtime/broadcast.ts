import { Server } from 'socket.io';

let io: Server | null = null;

export function setSocketServer(server: Server): void {
  io = server;
}

export function getSocketServer(): Server | null {
  return io;
}

// Emit a private event to a specific user
export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

// Emit an event to all members of a group room
export function emitToGroup(groupId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`group:${groupId}`).emit(event, data);
}
