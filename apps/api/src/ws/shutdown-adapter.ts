/** HTTP listener ownership remains with Fastify. Never call Socket.IO.close here. */
export interface WebSocketDrain {
  stopAdmission(): void;
  drain(deadlineMs: number): Promise<'drained' | 'failed' | 'timed-out'>;
  closeTransports(deadlineMs: number): Promise<void>;
  finalizeTransports(deadlineMs: number): Promise<import('./transport-owner.js').TransportReceipt>;
}
export function createWebSocketShutdownHook(ws: WebSocketDrain, deadlineMs: number) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2147483647) throw new RangeError('deadlineMs');
  let pending: Promise<void> | undefined;
  return function preClose(): Promise<void> {
    if (pending) return pending;
    ws.stopAdmission();
    pending = (async () => {
      const outcome = await ws.drain(deadlineMs);
      if (outcome !== 'drained') throw new Error(`WEBSOCKET_DRAIN_${outcome.toUpperCase()}`);
      // Bound transport cleanup separately; no clean result if cleanup never finishes.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => ws.closeTransports(deadlineMs)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WEBSOCKET_TRANSPORT_TIMEOUT')), deadlineMs); })
        ]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    return pending;
  };
}
