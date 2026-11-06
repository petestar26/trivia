import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOptionalSocket } from '@/providers/socket-provider';

export function useRoundUpdates(userId: string, roundId: string, sequence = 0) {
  const connection = useOptionalSocket();
  const cache = useQueryClient();
  const last = useRef(sequence);
  last.current = Math.max(last.current, sequence);
  useEffect(() => {
    const socket = connection?.socket;
    if (!socket) return;
    const refresh = () => {
      void cache.invalidateQueries({ queryKey: ['together-round', userId, roundId] });
    };
    const subscribe = () => {
      socket.emit('together:watch', { roundId }, refresh);
      refresh();
    };
    const changed = (event: { roundId: string; sequence: number }) => {
      if (
        event.roundId !== roundId ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= last.current
      )
        return;
      // A gap and a normal update use the same complete, authorized snapshot.
      last.current = event.sequence;
      refresh();
    };
    socket.on('connect', subscribe);
    socket.on('together:changed', changed);
    if (socket.connected) subscribe();
    return () => {
      socket.off('connect', subscribe);
      socket.off('together:changed', changed);
      socket.emit('together:leave', { roundId });
    };
  }, [connection?.socket, cache, userId, roundId]);
}
