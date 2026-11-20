import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server as SocketIOServer } from 'socket.io';

type EngineConnection = { close(): unknown; once(event: 'close', listener: () => void): unknown };
type Entry = { upgraded: boolean; active: number };
export interface TransportReceipt {
  listenerClosed: boolean;
  engines: number;
  httpRequests: number;
  sockets: number;
  upgradedSockets: number;
}
export interface SocketTransportOwner {
  readonly stopping: boolean;
  attach(io: SocketIOServer): void;
  stopAdmission(): void;
  prepare(deadlineMs: number): Promise<void>;
  finalize(deadlineMs: number): Promise<TransportReceipt>;
  snapshot(): TransportReceipt;
}
function validDeadline(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647) throw new RangeError('deadlineMs');
}
/** Install before Socket.IO construction, then attach after its HTTP wrapping.
 * Counts transport completion, NOT application completion after aborted requests.
 * Fastify is the sole owner of closing HTTP and its shared polling carriers.
 */
export function createSocketTransportOwner(http: HttpServer, path: string): SocketTransportOwner {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error('Exact normalized Socket.IO path required');
  const sockets = new Map<Duplex, Entry>();
  const engines = new Set<EngineConnection>();
  const checks = new Set<() => void>();
  let stopping = false, listenerClosed = false;
  let io: SocketIOServer | undefined;
  let prepared: Promise<void> | undefined, finalized: Promise<TransportReceipt> | undefined;
  let removeAttachedListeners = () => {};
  const snapshot = (): TransportReceipt => ({
    listenerClosed, engines: engines.size,
    httpRequests: [...sockets.values()].reduce((total, entry) => total + entry.active, 0),
    sockets: sockets.size, upgradedSockets: [...sockets.values()].filter(entry => entry.upgraded).length,
  });
  function wake(): void {
    if (stopping && !engines.size) {
      for (const [socket, entry] of sockets) if (entry.upgraded && entry.active === 0) socket.end();
    }
    for (const check of [...checks]) check();
  }
  function observe(socket: Duplex): Entry {
    let entry = sockets.get(socket);
    if (!entry) {
      entry = { upgraded: false, active: 0 };
      sockets.set(socket, entry);
      socket.once('close', () => { sockets.delete(socket); wake(); });
    }
    return entry;
  }
  function connection(socket: Duplex): void { observe(socket); }
  http.on('connection', connection);
  http.once('close', () => { listenerClosed = true; wake(); });
  function waitFor(predicate: () => boolean, ms: number, reason: string): Promise<void> {
    validDeadline(ms);
    return new Promise((resolve, reject) => {
      const check = () => { if (predicate()) { clearTimeout(timer); checks.delete(check); resolve(); } };
      const timer = setTimeout(() => { checks.delete(check); reject(new Error(reason)); }, ms);
      checks.add(check); check();
    });
  }
  return {
    get stopping() { return stopping; }, snapshot,
    attach(server): void {
      if (io) throw new Error('Transport owner already attached');
      io = server;
      // Match the installed Engine.IO attach routing predicate exactly.
      const matches = (request: IncomingMessage) => request.url?.slice(0, path.length) === path;
      const request = (req: IncomingMessage, res: ServerResponse) => {
        // ALL HTTP paths count on shared carriers, not just the Socket.IO path.
        const entry = observe(req.socket); entry.active++;
        let finished = false;
        const finish = () => { if (finished) return; finished = true; entry.active--; wake(); };
        res.once('finish', finish); res.once('close', finish);
      };
      const upgrade = (req: IncomingMessage, socket: Duplex) => {
        if (!matches(req)) return;
        observe(socket).upgraded = true;
        if (stopping) socket.destroy();
      };
      // Must run after Socket.IO/Engine.IO attach's existing request wrapping.
      http.prependListener('request', request);
      http.prependListener('upgrade', upgrade);
      server.engine.on('connection', socket => {
        engines.add(socket);
        socket.once('close', () => { engines.delete(socket); wake(); });
        if (stopping) socket.close();
      });
      removeAttachedListeners = () => {
        http.removeListener('request', request);
        http.removeListener('upgrade', upgrade);
        http.removeListener('connection', connection);
      };
    },
    stopAdmission(): void { stopping = true; },
    prepare(ms): Promise<void> {
      validDeadline(ms);
      if (!io) throw new Error('Transport owner must be attached');
      if (prepared) return prepared;
      stopping = true;
      const attached = io;
      prepared = (async () => {
        for (const socket of engines) socket.close();
        wake();
        await waitFor(() => !engines.size && ![...sockets.values()].some(entry => entry.active || entry.upgraded), ms, 'TRANSPORT_PREPARE_TIMEOUT');
        // Engine.IO cleanup alone is not transport completion. Observations above are required.
        attached.engine.close();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => attached.of('/').adapter.close()),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ADAPTER_CLOSE_TIMEOUT')), ms); }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      })();
      return prepared;
    },
    finalize(ms): Promise<TransportReceipt> {
      validDeadline(ms);
      if (!prepared) throw new Error('Transport prepare was not started');
      if (!listenerClosed) throw new Error('HTTP_OWNER_NOT_CLOSED');
      if (finalized) return finalized;
      finalized = (async () => {
        await prepared; // Failed prepare cannot become a successful final receipt.
        wake();
        await waitFor(() => !engines.size && !sockets.size, ms, 'TRANSPORT_FINALIZE_TIMEOUT');
        removeAttachedListeners();
        return snapshot();
      })();
      return finalized;
    },
  };
}
