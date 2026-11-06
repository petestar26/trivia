import type { PrismaClient } from '@socialplay/database';
import { getSocketServer } from '../../realtime/broadcast.js';

export async function canWatchTogether(db: PrismaClient, userId: string, roundId: string) {
  const [row] = await db.$queryRawUnsafe<{ allowed: boolean }[]>(
    "SELECT EXISTS(SELECT 1 FROM play_together_rounds r JOIN users u ON u.id=$1 AND u.status='ACTIVE' WHERE r.id=$2 AND " +
      '(r.group_id IS NULL OR EXISTS(SELECT 1 FROM group_members m WHERE m."groupId"=r.group_id AND m."userId"=$1 ' +
      "AND m.status IN ('ACTIVE','MUTED')) OR EXISTS(SELECT 1 FROM play_together_entries e WHERE e.round_id=r.id AND e.user_id=$1))) AS allowed",
    userId,
    roundId
  );
  return row.allowed;
}

/** Durable invalidations, coalesced after interruptions. Every delivery checks
 * current authorization. A snapshot, not the event, supplies the public data. */
export async function dispatchTogetherEvents(db: PrismaClient) {
  const io = getSocketServer();
  if (!io) return;
  const due = await db.$queryRawUnsafe<{ round_id: string; sequence: bigint; revision: number }[]>(
    'SELECT round_id,max(sequence) AS sequence,max(revision)::int AS revision FROM play_together_events ' +
      'WHERE delivered_at IS NULL AND available_at<=clock_timestamp() GROUP BY round_id ORDER BY min(available_at) LIMIT 50'
  );
  for (const event of due) {
    const room = 'together:' + event.round_id;
    const sockets = await io.in(room).fetchSockets();
    for (const socket of sockets) {
      const id = socket.data.user?.id;
      const user =
        typeof id === 'string'
          ? await db.user.findUnique({
              where: { id },
              select: { status: true, tokenVersion: true },
            })
          : null;
      if (
        !user ||
        user.status !== 'ACTIVE' ||
        (user.tokenVersion ?? 0) !== socket.data.tokenVersion ||
        !Number.isFinite(socket.data.expiresAt) ||
        socket.data.expiresAt <= Date.now()
      ) {
        socket.disconnect(true);
      } else if (!(await canWatchTogether(db, id, event.round_id))) {
        await socket.leave(room);
      } else {
        socket.emit('together:changed', {
          roundId: event.round_id,
          revision: event.revision,
          sequence: Number(event.sequence),
        });
      }
    }
    await db.$executeRawUnsafe(
      'UPDATE play_together_events SET delivered_at=clock_timestamp() WHERE round_id=$1 AND sequence<=$2 AND delivered_at IS NULL AND available_at<=clock_timestamp()',
      event.round_id,
      event.sequence
    );
  }
}
