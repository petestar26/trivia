import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema } from 'zod';
import { ApiError } from './error-handler';
import { ErrorCode } from '@socialplay/shared';

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.body);

    if (!result.success) {
      throw ApiError.badRequest('Invalid request body', {
        validation: result.error.flatten().fieldErrors,
      });
    }

    request.body = result.data;
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.query);

    if (!result.success) {
      throw ApiError.badRequest('Invalid query parameters', {
        validation: result.error.flatten().fieldErrors,
      });
    }

    request.query = result.data;
  };
}

export function validateParams<T>(schema: ZodSchema<T>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(request.params);

    if (!result.success) {
      throw ApiError.badRequest('Invalid route parameters', {
        validation: result.error.flatten().fieldErrors,
      });
    }

    request.params = result.data;
  };
}

export function validateAll(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (schemas.body) {
      const result = schemas.body.safeParse(request.body);
      if (!result.success) {
        throw ApiError.badRequest('Invalid request body', {
          validation: result.error.flatten().fieldErrors,
        });
      }
      request.body = result.data;
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(request.query);
      if (!result.success) {
        throw ApiError.badRequest('Invalid query parameters', {
          validation: result.error.flatten().fieldErrors,
        });
      }
      request.query = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(request.params);
      if (!result.success) {
        throw ApiError.badRequest('Invalid route parameters', {
          validation: result.error.flatten().fieldErrors,
        });
      }
      request.params = result.data;
    }
  };
}