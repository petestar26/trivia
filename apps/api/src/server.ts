import { startPaymentMaintenance } from './agents/payment-maintenance.js';
import { prisma } from '@socialplay/database';
import { createGroupPvpService } from './games/group-pvp/service.js';
import { startGroupPvpRuntime } from './games/group-pvp/runtime.js';
import { createTogetherService } from './games/play-together/service.js';
import { dispatchTogetherEvents } from './games/play-together/events.js';
import { startTogetherRuntime } from './games/play-together/runtime.js';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { fileURLToPath } from 'node:url';
import { config } from '@socialplay/config';
import { registerPlugins } from './plugins/index.js';
import { registerRoutes } from './routes/index.js';
import { healthRoutes } from './routes/health.js';
import { registerWebSocket } from './ws/index.js';
import { createWebSocketShutdownHook } from './ws/shutdown-adapter.js';
import { createSignalCloseCoordinator, type ShutdownSignal } from './signal-close.js';
import { closeOwnedApiResources } from './close-owned-api-resources.js';
import { waitForActivityRecording } from './rewards/activity-service.js';
import { createWorkDrain, type WorkLease } from './ws/work-drain.js';
import { errorHandler, sendMalformedUrlResponse } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { redactedRequestSerializer, redactUrl } from './middleware/log-redaction.js';
import { startEtbRateRefresh } from './agents/etb-rate-service.js';
import { providerTestCallbackRoutes } from './providers/softaggregator/callback-routes.js';
import { startRewardDelivery } from './member-rewards/service.js';
import { assertUploadPersistence } from './storage/readiness.js';
import { registerMonitorSignals } from './monitoring/signals.js';
import { startOperationsMonitor } from './monitoring/runtime.js';

/**
 * Test seams. Production always calls `buildServer()` with no arguments and
 * gets exactly the configured logger; these exist so a test can observe what
 * the REAL server writes to its log, rather than a reconstruction of it.
 */
// Candidate-only limits; a hosted rehearsal must establish a larger platform grace period.
const API_SHUTDOWN_DEADLINE_MS = 20_000;
const WEBSOCKET_DRAIN_DEADLINE_MS = 15_000;

interface SocketShutdownControl {
  stopAdmission(): void;
  prepareShutdown(): Promise<void>;
  finalizeTransports(deadlineMs: number): Promise<unknown>;
}
const TRANSPORT_RECEIPT_DEADLINE_MS = 3_000;
// Handlers can outlive their connection after a client abort. Bounded by the outer deadline.
const HTTP_HANDLER_DRAIN_DEADLINE_MS = 15_000;

type HttpWorkDrain = ReturnType<typeof createWorkDrain>;

/** A lease spans onRequest until the response has closed AND the lifecycle has finished
 * (a reply was produced, or the route handler settled). A client abort only closes the
 * response; preHandler and handler work that is still running keeps its lease. */
function trackHttpHandlerWork(server: FastifyInstance, work: HttpWorkDrain): void {
  type State = { lease: WorkLease | undefined; running: number; closed: boolean; finished: boolean };
  const states = new WeakMap<object, State>();
  const release = (state: State) => {
    if (state.running || !state.closed || !state.finished) return;
    state.lease?.finish();
    state.lease = undefined;
  };
  server.addHook('onRequest', async (request, reply) => {
    const state: State = { lease: work.acquire(), running: 0, closed: false, finished: false };
    states.set(request, state);
    reply.raw.once('close', () => { state.closed = true; release(state); });
  });
  // Callback style on purpose: an async onSend makes every send asynchronous, which
  // breaks handlers that call reply.send() without returning reply.
  server.addHook('onSend', (request, _reply, payload, done) => {
    const state = states.get(request);
    if (state) { state.finished = true; release(state); }
    done(null, payload);
  });
  server.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, request, reply) {
      const state = states.get(request);
      if (state) {
        state.running++;
        if (!state.lease) state.lease = work.acquire();
        if (!state.lease) {
          // Client already gone and shutdown has begun: do not start untracked work.
          state.running--;
          return reply.code(503).send({ success: false, error: {
            code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down',
          } });
        }
      }
      const leave = () => { if (state) { state.running--; state.finished = true; release(state); } };
      let result: unknown;
      try {
        result = handler.call(this, request, reply);
      } catch (error) {
        leave();
        throw error;
      }
      // Preserve the handler's own return value so Fastify semantics are unchanged.
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(leave, leave);
      } else {
        leave();
      }
      return result as ReturnType<typeof handler>;
    };
  });
}

interface BuildServerOptions {
  /** Shutdown-only: track route handler work independently of transport completion. */
  httpWork?: HttpWorkDrain;
  isDraining?: () => boolean;
  receiveSocketShutdownControl?: (control: SocketShutdownControl) => void;
  /** Receive every serialized log line instead of writing to stdout. */
  logStream?: NodeJS.WritableStream;
  /** Override config.LOG_LEVEL (e.g. 'trace' to capture every line). */
  logLevel?: string;
}

async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  // pino cannot combine `transport` with a custom `stream`, so an injected
  // stream replaces the transport rather than sitting beside it.
  const transport =
    !options.logStream && config.LOG_PRETTY
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined;

  const server = Fastify({
    // Financial round IDs allow 128 characters; the router must not reject a
    // valid public-proof identifier before its route schema can validate it.
    maxParamLength: 128,
    logger: {
      level: options.logLevel ?? config.LOG_LEVEL,
      transport,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Fastify's built-in `req` serializer logs `req.url` verbatim on its
      // automatic request/response lines, which would publish the invite
      // token from GET /groups/invites/:token to every log sink. Override
      // it with the redacting serializer — see middleware/log-redaction.ts.
      serializers: {
        req: redactedRequestSerializer,
      },
    },
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        // `coerceTypes: true` allows string→integer coercion for query
        // params (e.g. ?page=2 → 2). The previous 'array' value disabled
        // scalar coercion, causing paginated endpoints to 400.
        coerceTypes: true,
      },
    },
    // Fastify calls this hook for exactly two routing-level failures, before
    // any request lifecycle exists: FST_ERR_BAD_URL (a malformed percent-escape
    // in the path) and FST_ERR_ASYNC_CONSTRAINT. Body-size (413), media-type
    // (415) and JSON-syntax errors do NOT come through here — they are raised
    // inside the lifecycle and reach setErrorHandler below.
    //
    // FST_ERR_BAD_URL is special-cased because Fastify's default body echoes
    // the raw URL, which for the invite-resolution route is a bearer token.
    // Anything else is delegated to the shared error handler UNCHANGED, so its
    // native status and shape are preserved rather than flattened to a 400.
    frameworkErrors(error, request, reply) {
      if (error.code === 'FST_ERR_BAD_URL') {
        sendMalformedUrlResponse(request, reply as FastifyReply);
        return;
      }
      return errorHandler(error, request, reply as FastifyReply);
    },
  });

  if (options.isDraining) {
    server.addHook('onRequest', async (_request, reply) => {
      if (options.isDraining?.()) {
        return reply.code(503).send({ success: false, error: {
          code: 'SERVICE_UNAVAILABLE', message: 'Server is shutting down',
        } });
      }
    });
  }
  // Before any route registration so onRoute wraps every handler.
  if (options.httpWork) trackHttpHandlerWork(server, options.httpWork);
  server.setErrorHandler(errorHandler);
  server.addHook('onRequest', requestLogger);
  registerMonitorSignals(server, process.env.SALEM_MONITOR_ENABLED === 'true');

  // Routine `Router not found` 404s carry the full request URL inside
  // Fastify's log message. With malformed or mismatched invite paths, that
  // URL can contain the bearer-equivalent invite token — so install a safe
  // not-found handler that logs a redacted path and returns a generic 404.
  // Status behavior is unchanged, and the route method/status stay
  // diagnostic (only the URL token is masked). Registered before the route
  // plugins so it is the global fallback.
  server.setNotFoundHandler((request, reply) => {
    request.log.warn({ url: redactUrl(request.url) }, 'Route not found');
    return reply.code(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  await registerPlugins(server);
  await server.register(providerTestCallbackRoutes);

  // README.md documents `GET /health` (and `/health?detailed`) as a bare,
  // unprefixed infrastructure endpoint, distinct from the versioned /api/v1
  // business routes listed right below it in the same doc. Registered here,
  // directly on the top-level server and before the API_PREFIX wrapper, so
  // the actual path matches that documented contract instead of resolving
  // to /api/v1/health.
  await server.register(healthRoutes, { prefix: '/health' });

  // Product decision: the root service-info endpoint is a bare top-level
  // route, not a versioned /api/v1 resource — same reasoning as /health
  // above. Registered directly on the top-level server, before the
  // API_PREFIX wrapper, so it resolves to / rather than /api/v1. Payload
  // unchanged from the handler this replaces in routes/index.ts.
  server.get('/', async () => ({
    success: true,
    data: {
      name: 'SocialPlay API',
      version: '0.0.1',
      status: 'running',
    },
  }));

  // Mount all REST routes under the configured API prefix (e.g. /api/v1)
  // so that the frontend's /api/v1/* requests resolve correctly.
  await server.register(
    async (instance) => {
      await registerRoutes(instance);
    },
    { prefix: config.API_PREFIX }
  );

  const ws = registerWebSocket(server);
  // Share one idempotent preparation promise between CLI and generic Fastify close.
  const prepareShutdown = createWebSocketShutdownHook(ws, WEBSOCKET_DRAIN_DEADLINE_MS);
  options.receiveSocketShutdownControl?.({
    stopAdmission: () => ws.stopAdmission(),
    prepareShutdown,
    finalizeTransports: (deadlineMs) => ws.finalizeTransports(deadlineMs),
  });
  server.addHook('preClose', prepareShutdown);

  return server;
}

async function start(): Promise<void> {
  let server: FastifyInstance | undefined;
  let draining = false;
  let socketShutdown: SocketShutdownControl | undefined;
  const httpWork = createWorkDrain();
  const stopBackground: Array<() => void | Promise<unknown>> = [];
  let releaseStartup!: () => void;
  const startupSettled = new Promise<void>(resolve => { releaseStartup = resolve; });
  const close = createSignalCloseCoordinator({
    deadlineMs: API_SHUTDOWN_DEADLINE_MS,
    schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    close: async () => {
      // If a signal arrived during listen/build, avoid overlapping close with
      // unresolved startup. The outer deadline still bounds this wait.
      await startupSettled;
      await closeOwnedApiResources(
        async () => {
          if (!server) return;
          if (!socketShutdown) throw new Error('Socket shutdown control not available');
          // Await outside Fastify's preClose timeout/error handling. Fastify still
          // owns the actual HTTP close, and its hook reuses the settled promise.
          await socketShutdown.prepareShutdown();
          await server.close();
          await socketShutdown.finalizeTransports(TRANSPORT_RECEIPT_DEADLINE_MS);
          // Transport completion is not handler completion (client aborts). Never
          // disconnect the shared DB client while a route handler is still running.
          const handlers = await httpWork.wait(HTTP_HANDLER_DRAIN_DEADLINE_MS);
          if (handlers !== 'drained') throw new Error(`HTTP_HANDLER_DRAIN_${handlers.toUpperCase()}`);
        },
        stopBackground,
        async () => {
          // closeOwnedApiResources has settled all ingress/background producers.
          // Activity stays detached from requests, but must finish before Prisma closes.
          // The enclosing signal coordinator supplies the overall shutdown deadline.
          await waitForActivityRecording();
          await prisma.$disconnect();
        },
      );
    },
  });

  const handleSignal = (signal: ShutdownSignal) => {
    if (draining) return;
    draining = true;
    httpWork.stop();
    socketShutdown?.stopAdmission();
    void close.request(signal).then(outcome => {
      // Bounded timeout/failure is not a clean-host drain.
      if (outcome.status !== 'closed') {
        console.error('API shutdown did not complete:', outcome.status);
        process.exit(1);
      }
      // Exit naturally when non-owned handles close. If any keep this process
      // alive, a short unref'd check fails the shutdown instead of hanging.
      setTimeout(() => {
        console.error('API shutdown left an active process handle');
        process.exit(1);
      }, 1000).unref();
    });
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  try {
    await assertUploadPersistence(config.STORAGE_LOCAL_PATH);
    if (draining) return;
    const app = await buildServer({
      httpWork,
      isDraining: () => draining,
      receiveSocketShutdownControl(control) {
        socketShutdown = control;
        if (draining) control.stopAdmission();
      },
    });
    server = app;
    if (draining) return;

    stopBackground.push(startRewardDelivery(() =>
      app.log.warn('Automatic reward delivery is temporarily unavailable; credits will retry')
    ));
    stopBackground.push(startGroupPvpRuntime({
      enabled: process.env.GROUP_PVP_GAME_POINTS_ENABLED === 'true',
      tick: createGroupPvpService(prisma).tick,
      report: () => app.log.warn('Group game processing is unavailable; new entries are paused'),
    }));
    const togetherService = createTogetherService(prisma);
    stopBackground.push(startTogetherRuntime(
      async () => {
        if (process.env.PLAY_TOGETHER_WORKER_MODE !== 'external') await togetherService.tick();
        await dispatchTogetherEvents(prisma);
      },
      () => app.log.warn('Group rounds are recovering; new entries are paused')
    ));
    stopBackground.push(startPaymentMaintenance(() =>
      app.log.warn('Payment deadline checks need attention; held funds remain protected')
    ));
    stopBackground.push(startEtbRateRefresh(() =>
      app.log.warn('ETB reference refresh is unavailable')
    ));
    if (process.env.SALEM_MONITOR_ENABLED === 'true') {
      stopBackground.push(startOperationsMonitor(prisma, app));
    }
    await app.listen({ port: config.PORT, host: config.HOST });
    if (draining) return;
    app.log.info(`🚀 Server running at http://${config.HOST}:${config.PORT}`);
    app.log.info(
      `📚 API docs available at http://${config.HOST}:${config.PORT}${config.API_PREFIX}/docs`
    );
  } catch (err) {
    if (!draining) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  } finally {
    releaseStartup();
  }
}

// `file://${process.argv[1]}` builds a malformed URL on Windows: argv[1] is a
// native backslash path (C:\...), while import.meta.url is a proper file URL
// (file:///C:/...). The two never match, so start() silently never ran and the
// server never listened — with no error, since a false guard isn't an error.
// fileURLToPath converts import.meta.url back to a native path, so this
// compares native-to-native and works on every platform.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}

export { buildServer, start };
export type { BuildServerOptions };
