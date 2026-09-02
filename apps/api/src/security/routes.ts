import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, ApiError } from '../middleware';
import {
  startTotpEnrollment,
  activateTotpFactor,
  disableTotpFactor,
  listOwnFactors,
} from './totp-service';
import { performStepUp, setOwnStepUpPolicy, requiresStepUp } from './step-up-service';

/**
 * W-0 security routes.
 *
 * Every handler derives identity from `request.user!.sub` — no route
 * accepts a userId, ownership, status, or verification state from the
 * client. All are authenticated and rate-limited.
 */

const TOTP_CODE = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Verification code must be 6 digits');

const activateSchema = z.object({
  challenge: z.string().min(1).max(256),
  code: TOTP_CODE,
});

const disableSchema = z.object({
  code: TOTP_CODE,
});

const stepUpSchema = z.object({
  purpose: z.string().trim().min(1).max(64),
  factorType: z.literal('TOTP'),
  code: TOTP_CODE,
});

const policySchema = z.object({
  requiresStepUpForSensitiveOps: z.boolean(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Field-level messages only — never echoes submitted secret material.
    throw ApiError.badRequest(result.error.errors[0]?.message ?? 'Invalid request');
  }
  return result.data;
}

function requestContext(request: { ip?: string; headers: Record<string, unknown> }) {
  return {
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string'
      ? (request.headers['user-agent'] as string)
      : undefined,
  };
}

export async function securityRoutes(server: FastifyInstance): Promise<void> {
  const authHandler = [authenticate];

  // GET /security/factors — the caller's own factors. Never another user's.
  server.get('/factors', { preHandler: authHandler }, async (request, reply) => {
    const userId = request.user!.sub;
    const [factors, stepUpRequired] = await Promise.all([
      listOwnFactors(userId),
      requiresStepUp(userId),
    ]);
    return reply.send({
      success: true,
      data: { factors, policy: { requiresStepUpForSensitiveOps: stepUpRequired } },
    });
  });

  // POST /security/totp/start — begins enrollment.
  // Returns the provisioning secret EXACTLY ONCE, over the authenticated
  // channel. Tightly rate-limited: each call mints a new secret.
  server.post(
    '/totp/start',
    { preHandler: authHandler, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const result = await startTotpEnrollment(request.user!.sub, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );

  // POST /security/totp/activate — proves possession, activates the factor.
  server.post(
    '/totp/activate',
    { preHandler: authHandler, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(activateSchema, request.body);
      const factor = await activateTotpFactor(
        request.user!.sub,
        body.challenge,
        body.code,
        requestContext(request)
      );
      return reply.send({ success: true, data: factor });
    }
  );

  // POST /security/totp/disable — requires a current valid code.
  server.post(
    '/totp/disable',
    { preHandler: authHandler, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(disableSchema, request.body);
      const factor = await disableTotpFactor(
        request.user!.sub,
        body.code,
        requestContext(request)
      );
      return reply.send({ success: true, data: factor });
    }
  );

  // POST /security/step-up/verify — mints a bounded, purpose-scoped,
  // single-use step-up authorisation. W-0 integrates this with no
  // sensitive operation; it exists for future callers of requireStepUp().
  server.post(
    '/step-up/verify',
    { preHandler: authHandler, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(stepUpSchema, request.body);
      const tokenIat = request.user!.iat;
      if (typeof tokenIat !== 'number') {
        throw ApiError.unauthorized('Invalid token');
      }
      const result = await performStepUp(
        { userId: request.user!.sub, tokenIat },
        body.purpose,
        body.factorType,
        body.code,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  // PATCH /security/policy — the caller's own step-up policy.
  server.patch(
    '/policy',
    { preHandler: authHandler, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parse(policySchema, request.body);
      const policy = await setOwnStepUpPolicy(
        request.user!.sub,
        body.requiresStepUpForSensitiveOps,
        requestContext(request)
      );
      return reply.send({ success: true, data: policy });
    }
  );
}
