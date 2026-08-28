import { FastifyRequest, FastifyReply } from 'fastify';

export async function requestLogger(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const startTime = process.hrtime.bigint();
  const requestId = request.headers['x-request-id'] as string || crypto.randomUUID();

  request.id = requestId;
  request.headers['x-request-id'] = requestId;

  request.log.info({
    requestId,
    method: request.method,
    url: request.url,
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
      url: request.url,
      statusCode,
      durationMs: Math.round(duration),
      ip: request.ip,
    }, 'Request completed');
  });
}