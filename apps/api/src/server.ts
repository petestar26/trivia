import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { fileURLToPath } from 'node:url';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { registerPlugins } from './plugins';
import { registerRoutes } from './routes';
import { healthRoutes } from './routes/health';
import { registerWebSocket } from './ws';
import { errorHandler, sendMalformedUrlResponse } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { redactedRequestSerializer, redactUrl } from './middleware/log-redaction.js';

/**
 * Test seams. Production always calls `buildServer()` with no arguments and
 * gets exactly the configured logger; these exist so a test can observe what
 * the REAL server writes to its log, rather than a reconstruction of it.
 */
interface BuildServerOptions {
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

  server.setErrorHandler(errorHandler);
  server.addHook('onRequest', requestLogger);

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

  registerWebSocket(server);

  return server;
}

async function start(): Promise<void> {
  try {
    const server = await buildServer();
    await server.listen({ port: config.PORT, host: config.HOST });
    server.log.info(`🚀 Server running at http://${config.HOST}:${config.PORT}`);
    server.log.info(`📚 API docs available at http://${config.HOST}:${config.PORT}${config.API_PREFIX}/docs`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
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