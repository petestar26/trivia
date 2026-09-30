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
