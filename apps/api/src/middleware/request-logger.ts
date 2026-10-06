import { FastifyRequest, FastifyReply } from 'fastify';
import { redactUrl } from './log-redaction.js';

export async function requestLogger(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const startTime = process.hrtime.bigint();
  const requestId = request.headers['x-request-id'] as string || crypto.randomUUID();

  request.id = requestId;
  request.headers['x-request-id'] = requestId;

  // Invite tokens live in the URL path (GET /groups/invites/:token) and are
  // bearer-equivalent, so they must never reach a log sink. Redacted once
  // here and reused by the completion line below — see
  // middleware/log-redaction.ts.
  const safeUrl = redactUrl(request.url);

  request.log.info({
    requestId,
    method: request.method,
    url: safeUrl,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  }, 'Incoming request');

  reply.raw.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    const statusCode = reply.statusCode;

    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    request.log[logLevel]({
      requestId,
      method: request.method,
      url: safeUrl,
      statusCode,
      durationMs: Math.round(duration),
      ip: request.ip,
    }, 'Request completed');
  });
}
