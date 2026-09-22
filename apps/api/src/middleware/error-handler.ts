import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@socialplay/config';
import { ErrorCode } from '@socialplay/shared';
import { quotesInviteTokenRoute, redactUrl } from './log-redaction.js';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error implements AppError {
  statusCode: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = ErrorCode.INTERNAL_ERROR,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 400, ErrorCode.BAD_REQUEST, details);
  }

  static unauthorized(message: string = 'Unauthorized', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 401, ErrorCode.UNAUTHORIZED, details);
  }

  static forbidden(message: string = 'Forbidden', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 403, ErrorCode.FORBIDDEN, details);
  }

  static notFound(message: string = 'Resource not found', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 404, ErrorCode.NOT_FOUND, details);
  }

  static conflict(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 409, ErrorCode.CONFLICT, details);
  }

  static rateLimited(message: string = 'Too many requests', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 429, ErrorCode.RATE_LIMITED, details);
  }

  static unprocessableEntity(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 422, ErrorCode.UNPROCESSABLE_ENTITY, details);
  }

  static internal(message: string = 'Internal server error', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 500, ErrorCode.INTERNAL_ERROR, details);
  }

  static serviceUnavailable(message: string = 'Service unavailable', details?: Record<string, unknown>): ApiError {
    return new ApiError(message, 503, ErrorCode.SERVICE_UNAVAILABLE, details);
  }
}

/**
 * The ONE response for a request URL that Fastify's router rejects as
 * malformed (FST_ERR_BAD_URL — an escape like %ZZ, or a trailing %).
 *
 * Fastify's own body for it is `'<the raw url>' is not a valid url component`,
 * and the raw URL of `GET /groups/invites/:token` carries a bearer-equivalent
 * secret: echoing it hands the token back in the response, and logging the
 * error hands it to every log sink. So the response is generic, the log line
 * carries only the REDACTED url, and the error object (whose message holds the
 * raw one) is never logged.
 *
 * Used by the frameworkErrors hook in server.ts and, as defence in depth, by
 * errorHandler below should such an error ever reach it.
 */
export function sendMalformedUrlResponse(request: FastifyRequest, reply: FastifyReply): void {
  request.log.warn({ url: redactUrl(request.url) }, 'Malformed request URL');
  reply.status(400).send({
    success: false,
    error: {
      code: ErrorCode.BAD_REQUEST,
      message: 'Bad request',
    },
    meta: { requestId: (request.headers['x-request-id'] as string) || crypto.randomUUID() },
  });
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  // Before ANYTHING logs `error`: its message echoes the raw request URL.
  if (error.code === 'FST_ERR_BAD_URL') {
    sendMalformedUrlResponse(request, reply);
    return;
  }

  const requestId = request.headers['x-request-id'] as string || crypto.randomUUID();

  request.log.error({ err: errorSafeToLog(error), requestId }, 'Request error');

  if (error.validation) {
    return reply.status(400).send({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: error.validation,
      },
      meta: { requestId },
    });
  }

  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      meta: { requestId },
    });
  }

  if (error.statusCode === 429) {
    return reply.status(429).send({
      success: false,
      error: {
        code: ErrorCode.RATE_LIMITED,
        message: 'Too many requests',
      },
      meta: { requestId },
    });
  }

  if (
    error.name === 'UnauthorizedError' ||
    error.name === 'JsonWebTokenError' ||
    error.name === 'TokenExpiredError'
  ) {
    return reply.status(401).send({
      success: false,
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired token',
      },
      meta: { requestId },
    });
  }

  if (error.code === 'P2003') {
    return reply.status(400).send({
      success: false,
      error: {
        code: ErrorCode.BAD_REQUEST,
        message: 'Invalid reference',
      },
      meta: { requestId },
    });
  }

  if (error.code === 'P2002') {
    return reply.status(409).send({
      success: false,
      error: {
        code: ErrorCode.ALREADY_EXISTS,
        message: 'Resource already exists',
      },
      meta: { requestId },
    });
  }

  if (error.code === 'P2025') {
    // Record not found — common in concurrent delete/refresh/leave races.
    return reply.status(404).send({
      success: false,
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Resource not found or already removed',
      },
      meta: { requestId },
    });
  }

  const statusCode = error.statusCode || 500;

  // Belt and braces for the RESPONSE: any other error whose message quotes an
  // invite-token path is answered generically, keeping its own status. (The
  // known source of such a message, FST_ERR_BAD_URL, never gets here.)
  const echoesInviteRoute =
    typeof error.message === 'string' &&
    (/\/groups\/invites\//i.test(error.message) || quotesInviteTokenRoute(error.message));
  const message = echoesInviteRoute
    ? 'Bad request'
    : (config.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : error.message);

  reply.status(statusCode).send({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message,
    },
    meta: { requestId },
  });
}

/**
 * The error as it may be LOGGED. pino serializes an error's message AND its
 * stack (which opens with the message), so an error that quotes an invite
 * route would publish the bearer-equivalent token to every log sink. Such an
 * error is logged as a stand-in that keeps what diagnosis needs — name, code,
 * status — and nothing that quotes the route. Every other error is logged as it
 * is. Judged by the same recognizer as the URL fields, so a spelling that
 * cannot slip past one cannot slip past the other.
 */
function errorSafeToLog(error: FastifyError): FastifyError {
  if (!quotesInviteTokenRoute(error.message) && !quotesInviteTokenRoute(error.stack)) return error;
  return Object.assign(new Error('[REDACTED]'), {
    name: error.name,
    code: error.code,
    statusCode: error.statusCode,
  }) as FastifyError;
}
