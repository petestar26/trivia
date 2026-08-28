import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@socialplay/config';
import { ErrorCode } from '@socialplay/shared';

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

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = request.headers['x-request-id'] as string || crypto.randomUUID();

  request.log.error({ err: error, requestId }, 'Request error');

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

  if (error.name === 'UnauthorizedError' || error.message.includes('jwt')) {
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

  const statusCode = error.statusCode || 500;
  const message = config.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error'
    : error.message;

  reply.status(statusCode).send({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message,
    },
    meta: { requestId },
  });
}