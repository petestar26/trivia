import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { registerSchema, loginSchema, refreshTokenSchema, RefreshTokenPayload } from '@socialplay/shared';
import { ApiError, authenticate } from '../middleware';
import { ErrorCode } from '@socialplay/shared';
import { generateTokens, hashPassword, verifyPassword } from '../utils/auth';
import { safeRecordActivity } from '../rewards/activity-service';
import {
  canonicalizeReferralCode,
  isValidReferralCode,
  generateUniqueReferralCode,
} from '../referrals/referral-service.js';
import {
  googleIdTokenVerifier,
  generateNonceSecret,
  hashNonceSecret,
  isGoogleAuthoritativeEmail,
  type GoogleVerifyResult,
} from '../auth/google-verifier.js';

export async function authRoutes(server: FastifyInstance): Promise<void> {
  server.post<{ Body: z.infer<typeof registerSchema> }>(
    '/register',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_AUTH_MAX_REQUESTS, timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS },
      },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'email', 'password'],
          properties: {
            username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' },
            email: { type: 'string', format: 'email', maxLength: 255 },
            // Mirrors the shared password policy (packages/shared passwordSchema):
            // min 8, max 128, at least one uppercase, lowercase, digit, special.
            password: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              allOf: [
                { pattern: '[A-Z]' },
                { pattern: '[a-z]' },
                { pattern: '[0-9]' },
                { pattern: '[^A-Za-z0-9]' },
              ],
            },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            referralCode: { type: 'string', maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, email, password, displayName } = request.body;

      // ─── Referral code canonicalization (before any DB work) ───
      const rawReferralCode = (request.body as Record<string, unknown>).referralCode;
      // "" or whitespace-only → treated as omitted.
      let suppliedCode: string | null = null;

      if (typeof rawReferralCode === 'string' && rawReferralCode.trim().length > 0) {
        const canonical = canonicalizeReferralCode(rawReferralCode);
        // Format validation only here — referrer existence/eligibility is
        // resolved INSIDE the registration transaction (§19).
        if (!isValidReferralCode(canonical)) {
          throw ApiError.badRequest('Invalid referral code');
        }
        suppliedCode = canonical;
      }

      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ email }, { username }],
        },
      });

      if (existingUser) {
        if (existingUser.email === email) {
          throw ApiError.conflict('Email already registered');
        }
        throw ApiError.conflict('Username already taken');
      }

      const passwordHash = await hashPassword(password);

      // Atomic registration with collision retry for generated referralCode.
      // The whole registration transaction is retried on referralCode unique
      // collision only; all other failures propagate immediately.
      const MAX_REGISTRATION_RETRIES = 5;

      for (let attempt = 0; attempt < MAX_REGISTRATION_RETRIES; attempt++) {
        try {
          const { user, tokens } = await prisma.$transaction(async (tx) => {
            const ownCode = await generateUniqueReferralCode();

            const user = await tx.user.create({
              data: {
                email,
                username,
                passwordHash,
                displayName: displayName || username,
                referralCode: ownCode,
              },
              select: {
                id: true,
                email: true,
                username: true,
                displayName: true,
                isVerified: true,
                role: true,
                tokenVersion: true,
                createdAt: true,
              },
            });

            // Dual-write: create the EMAIL identity inside the same transaction.
            await tx.userAuthIdentity.create({
              data: {
                userId: user.id,
                provider: 'EMAIL',
                providerSubject: email,
                verifiedAt: null,
              },
            });

            // Referral attribution (if a valid code was supplied).
            // Referrer is resolved by canonical referral code INSIDE this
            // transaction; only ACTIVE referrers are eligible. Any failure
            // path here rolls back the whole registration (User + identity
            // + Referral + Session leave no partial state).
            if (suppliedCode) {
              const referrer = await tx.user.findUnique({
                where: { referralCode: suppliedCode },
                select: { id: true, status: true },
              });

              if (!referrer || referrer.status !== 'ACTIVE') {
                throw ApiError.badRequest('Invalid referral code');
              }

              await tx.referral.create({
                data: {
                  referredUserId: user.id,
                  referrerUserId: referrer.id,
                  referralCode: suppliedCode,
                },
              });
            }

            const tokens = generateTokens(user.id, user.email, user.username, [user.role], user.tokenVersion);

            await tx.session.create({
              data: {
                userId: user.id,
                refreshToken: tokens.refreshToken,
                userAgent: request.headers['user-agent'],
                ip: request.ip,
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              },
            });

            return { user, tokens };
          });

          setAuthCookies(reply, tokens);

          reply.status(201).send({
            success: true,
            data: {
              user,
              ...tokens,
            },
          });
          return; // success — exit retry loop
        } catch (err) {
          const code = (err as { code?: string }).code;
          const target = (err as { meta?: { target?: string | string[] } }).meta?.target;
          const fields = Array.isArray(target) ? target : target ? [String(target)] : [];

          // referralCode collision on our OWN generated code → retry
          if (code === 'P2002' && fields.includes('referralCode')) {
            continue; // retry with fresh generated code
          }

          // Known User/identity constraints → classify and fail immediately
          if (code === 'P2002') {
            if (fields.includes('email')) throw ApiError.conflict('Email already registered');
            if (fields.includes('username')) throw ApiError.conflict('Username already taken');
            if (fields.includes('provider') && fields.includes('providerSubject')) {
              throw ApiError.conflict('Email already registered');
            }
          }
          throw err;
        }
      }

      // All retry attempts exhausted for referralCode collisions.
      throw ApiError.internal('Registration failed due to repeated referral code collisions');
    }
  );

  server.post<{ Body: z.infer<typeof loginSchema> }>(
    '/login',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_AUTH_MAX_REQUESTS, timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS },
      },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            rememberMe: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw ApiError.unauthorized('Invalid credentials');
      }

      // passwordHash is nullable (provider-only accounts). Use a generic
      // guard; never reveal whether this is a Google/Telegram-only account.
      if (!user.passwordHash) {
        throw ApiError.unauthorized('Invalid credentials');
      }

      // Verify the password BEFORE revealing account-state differences,
      // so that a non-existent email and an existing-but-banned email both
      // return the same generic "Invalid credentials" error (no enumeration).
      const isValid = await verifyPassword(password, user.passwordHash);

      if (!isValid) {
        throw ApiError.unauthorized('Invalid credentials');
      }

      if (user.status !== 'ACTIVE') {
        throw ApiError.forbidden('Account is not active');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const tokens = generateTokens(user.id, user.email, user.username, [user.role], user.tokenVersion);

      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: tokens.refreshToken,
          userAgent: request.headers['user-agent'],
          ip: request.ip,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      setAuthCookies(reply, tokens);

      reply.send({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            displayName: user.displayName,
            isVerified: user.isVerified,
            role: user.role,
          },
          ...tokens,
        },
      });

      // Server-verified activity: daily login + streak (post-commit, best-effort).
      safeRecordActivity(user.id, { type: 'LOGIN' });
    }
  );

  server.post<{ Body: z.infer<typeof refreshTokenSchema> }>(
    '/refresh',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_AUTH_MAX_REQUESTS, timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS },
      },
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body;

      const session = await prisma.session.findUnique({
        where: { refreshToken },
        include: { user: true },
      });

      if (!session || session.expiresAt < new Date()) {
        throw ApiError.unauthorized('Refresh token expired or invalid', { code: ErrorCode.TOKEN_EXPIRED });
      }

      if (session.user.status !== 'ACTIVE') {
        throw ApiError.forbidden('Account is not active');
      }

      // Verify the refresh token's tokenVersion matches the user's current
      // value. If the user's tokenVersion was bumped (revocation), the
      // outstanding refresh token is invalid.
      try {
        const decoded = await request.server.jwt.verify<RefreshTokenPayload>(refreshToken, {
          // @fastify/jwt merges route options with the plugin secret and only
          // honors a `key` option (a plain `secret` option is ignored, which
          // would verify with the access-token secret). Pass the refresh
          // secret as `key` so the refresh token's HS256 signature checks out.
          key: config.JWT_REFRESH_SECRET,
        });
        if (decoded.tokenVersion !== session.user.tokenVersion) {
          throw ApiError.unauthorized('Token revoked', { code: ErrorCode.TOKEN_EXPIRED });
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw ApiError.unauthorized('Invalid refresh token', { code: ErrorCode.TOKEN_INVALID });
      }

      // Atomic rotation: delete the old session and create the new one
      // in a single transaction so a crash between the two cannot leave
      // the user with no valid refresh token, and concurrent refreshes
      // resolve cleanly (the delete fails on the loser → P2025 → 404).
      // The replacement tokens come from the single generateTokens() path;
      // generateTokens() mints a unique refresh token (fresh jti) per call,
      // so two rotations in the same second never produce identical tokens —
      // a concurrent duplicate refresh cannot match the winner's rotated row.
      const tokens = generateTokens(
        session.user.id,
        session.user.email,
        session.user.username,
        [session.user.role],
        session.user.tokenVersion
      );

      try {
        await prisma.$transaction(async (tx) => {
          // Conditional delete: only succeeds if the session still matches
          // (a concurrent refresh may have already rotated it).
          await tx.session.delete({ where: { id: session.id } });

          await tx.session.create({
            data: {
              userId: session.user.id,
              refreshToken: tokens.refreshToken,
              userAgent: request.headers['user-agent'],
              ip: request.ip,
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          });
        });
      } catch (err) {
        // P2025 = session already deleted by a concurrent refresh.
        if ((err as { code?: string }).code === 'P2025') {
          throw ApiError.unauthorized('Refresh token already used', { code: ErrorCode.TOKEN_EXPIRED });
        }
        throw err;
      }

      setAuthCookies(reply, tokens);

      reply.send({
        success: true,
        data: tokens,
      });
    }
  );

  server.post(
    '/logout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      // Delete all sessions for this user and clear auth cookies.
      // (Single-session logout would require the refresh-token cookie/body;
      //  see audit note D12. This preserves existing all-device behavior.)
      await prisma.session.deleteMany({
        where: { userId: request.user!.sub },
      });

      clearAuthCookies(reply);

      reply.send({
        success: true,
        data: { message: 'Logged out successfully' },
      });
    }
  );

  server.get(
    '/me',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user!.sub },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          bio: true,
          avatarUrl: true,
          isVerified: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });

      if (!user) {
        throw ApiError.notFound('User not found');
      }

      reply.send({
        success: true,
        data: { user },
      });
    }
  );

  // ─── Google sign-in ────────────────────────────────────────
  // Config gate = GOOGLE_CLIENT_ID presence. When unavailable, both Google
  // endpoints respond 503 and email/password auth is unaffected.

  const GOOGLE_BODY_SCHEMA = {
    // All three fields must be listed so AJV `removeAdditional: 'all'` does not
    // silently strip them. Credential reaches the verifier, username reaches
    // new-account creation, referralCode reaches referral attribution.
    type: 'object' as const,
    required: ['credential'] as const,
    properties: {
      credential: { type: 'string' as const, minLength: 1, maxLength: 8192 },
      username: { type: 'string' as const, minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' },
      referralCode: { type: 'string' as const, maxLength: 50 },
    },
  };

  const GOOGLE_SUCCESS_RESPONSE_SCHEMA = {
    200: {
      type: 'object' as const,
      properties: {
        success: { type: 'boolean' as const },
        data: {
          type: 'object' as const,
          properties: {
            user: {
              type: 'object' as const,
              properties: {
                id: { type: 'string' as const },
                email: { type: ['string' as const, 'null' as const] },
                username: { type: 'string' as const },
                displayName: { type: 'string' as const },
                isVerified: { type: 'boolean' as const },
                role: { type: 'string' as const },
              },
              required: ['id', 'email', 'username', 'displayName', 'isVerified', 'role'] as string[],
            },
            accessToken: { type: 'string' as const },
            refreshToken: { type: 'string' as const },
          },
          required: ['user', 'accessToken', 'refreshToken'] as string[],
        },
      },
      required: ['success', 'data'] as string[],
    },
  };

  server.get(
    '/google/nonce',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_AUTH_MAX_REQUESTS, timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS },
      },
      schema: {
        response: {
          200: {
            type: 'object' as const,
            properties: {
              success: { type: 'boolean' as const },
              data: {
                type: 'object' as const,
                properties: {
                  nonce: { type: 'string' as const },
                },
                required: ['nonce'] as string[],
              },
            },
            required: ['success', 'data'] as string[],
          },
        },
      },
    },
    async (request, reply) => {
      if (!config.GOOGLE_CLIENT_ID) {
        throw ApiError.serviceUnavailable('Google sign-in is not available');
      }

      const raw = generateNonceSecret();
      const digest = hashNonceSecret(raw);

      reply.setCookie('sp_google_nonce', raw, googleNonceCookieOptions());
      // A cached nonce response paired with a different/expired cookie is
      // invalid, so the nonce response must never be cached.
      reply.header('Cache-Control', 'no-store');

      reply.send({ success: true, data: { nonce: digest } });
    }
  );

  server.post<{
    Body: { credential: string; username?: string; referralCode?: string };
  }>(
    '/google',
    {
      config: {
        rateLimit: { max: config.RATE_LIMIT_AUTH_MAX_REQUESTS, timeWindow: config.RATE_LIMIT_AUTH_WINDOW_MS },
      },
      schema: {
        body: GOOGLE_BODY_SCHEMA,
        response: GOOGLE_SUCCESS_RESPONSE_SCHEMA,
      },
    },
    async (request, reply) => {
      if (!config.GOOGLE_CLIENT_ID) {
        throw ApiError.serviceUnavailable('Google sign-in is not available');
      }

      const { credential, username, referralCode } = request.body;

      // Missing nonce cookie is an authenticity failure, never an upstream 5xx.
      const rawNonce = request.cookies?.sp_google_nonce;
      if (!rawNonce || typeof rawNonce !== 'string' || rawNonce.length === 0) {
        throw ApiError.unauthorized('Invalid Google credential');
      }
      const expectedNonceHash = hashNonceSecret(rawNonce);

      let result: GoogleVerifyResult;
      try {
        result = await googleIdTokenVerifier(credential, expectedNonceHash);
      } catch {
        // Wrapper never throws upstream Google errors; a throw here is a
        // PlayQube-internal bug — surface it as a generic 500.
        throw ApiError.internal('Google verification failed');
      }

      if (result.kind === 'unavailable') {
        throw ApiError.serviceUnavailable('Google sign-in temporarily unavailable');
      }
      if (result.kind === 'invalid') {
        throw ApiError.unauthorized('Invalid Google credential');
      }

      const claims = result.claims;

      // 1. Ownership key is (GOOGLE, sub). A found identity takes the
      //    RETURNING LOGIN path immediately — collision checks never run.
      const existing = await prisma.userAuthIdentity.findUnique({
        where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: claims.sub } },
        include: { user: true },
      });

      if (existing) {
        await completeGoogleLogin(existing, request, reply);
        return;
      }

      // 2. New identity: authoritative-email collision check (no auto-link).
      if (isGoogleAuthoritativeEmail(claims) && claims.email) {
        const emailOwner = await prisma.user.findFirst({
          where: { email: { equals: claims.email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (emailOwner) {
          throw new ApiError(
            'An account already exists for this email. Sign in with your existing method; Google linking is not available yet.',
            409,
            ErrorCode.ACCOUNT_LINK_REQUIRED
          );
        }
      }

      // 3. Two-step onboarding: username is required for a NEW identity.
      //    The Fastify schema already enforces ^[a-zA-Z0-9_]{3,30}$, so a
      //    non-blank username here is valid as-is.
      const selectedUsername =
        typeof username === 'string' && username.trim().length > 0 ? username.trim() : undefined;
      if (!selectedUsername) {
        // Nonce cookie is deliberately NOT cleared — it stays usable for the
        // username-retry POST within its 5-minute TTL.
        throw new ApiError('Please choose a username', 422, ErrorCode.USERNAME_REQUIRED);
      }

      // 4. Optional referral (Slice-5 semantics) — validated before the tx.
      let suppliedCode: string | undefined;
      if (typeof referralCode === 'string' && referralCode.trim().length > 0) {
        const canonical = canonicalizeReferralCode(referralCode);
        if (!isValidReferralCode(canonical)) {
          throw ApiError.badRequest('Invalid referral code');
        }
        suppliedCode = canonical;
      }

      // 5. Atomic account creation with bounded whole-tx retry on own-code P2002.
      const MAX_GOOGLE_CREATE_RETRIES = 5;
      for (let attempt = 0; attempt < MAX_GOOGLE_CREATE_RETRIES; attempt += 1) {
        try {
          const outcome = await prisma.$transaction(async (tx) => {
            const ownCode = await generateUniqueReferralCode();
            const created = await tx.user.create({
              data: {
                email: null,
                passwordHash: null,
                username: selectedUsername,
                displayName: selectedUsername,
                referralCode: ownCode,
                lastLoginAt: new Date(),
              },
              select: {
                id: true,
                email: true,
                username: true,
                displayName: true,
                isVerified: true,
                role: true,
                tokenVersion: true,
              },
            });

            await tx.userAuthIdentity.create({
              data: {
                userId: created.id,
                provider: 'GOOGLE',
                providerSubject: claims.sub,
                verifiedAt: new Date(),
                lastUsedAt: new Date(),
              },
            });

            if (suppliedCode) {
              const referrer = await tx.user.findUnique({
                where: { referralCode: suppliedCode },
                select: { id: true, status: true },
              });
              if (!referrer || referrer.status !== 'ACTIVE') {
                throw ApiError.badRequest('Invalid referral code');
              }
              await tx.referral.create({
                data: {
                  referredUserId: created.id,
                  referrerUserId: referrer.id,
                  referralCode: suppliedCode,
                },
              });
            }

            const tokens = generateTokens(created.id, created.email, created.username, [created.role], created.tokenVersion);

            await tx.session.create({
              data: {
                userId: created.id,
                refreshToken: tokens.refreshToken,
                userAgent: request.headers['user-agent'],
                ip: request.ip,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
              },
            });

            return { user: created, tokens };
          });

          clearNonceCookie(reply);
          setAuthCookies(reply, outcome.tokens);
          reply.status(201);
          reply.send({
            success: true,
            data: {
              user: sanitizeGoogleUser(outcome.user),
              ...outcome.tokens,
            },
          });
          return;
        } catch (err) {
          const meta = (err as { code?: string; meta?: { target?: unknown } }).meta;
          const target = Array.isArray(meta?.target) ? meta.target.map(String) : [];
          const code = (err as { code?: string }).code;

          if (code === 'P2002') {
            const isProviderRace =
              target.includes('provider_providerSubject') ||
              (target.includes('provider') && target.includes('providerSubject'));

            if (target.includes('referralCode')) {
              // Own generated code collided — retry whole tx with a fresh code.
              continue;
            }

            if (isProviderRace) {
              // Same-sub twin committed first. Re-read and complete as login.
              const committed = await prisma.userAuthIdentity.findUnique({
                where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: claims.sub } },
                include: { user: true },
              });
              if (!committed) throw err;
              if (committed.user.status !== 'ACTIVE') {
                throw ApiError.forbidden('Account is not active');
              }
              await completeGoogleLogin(committed, request, reply);
              return;
            }

            if (target.includes('username')) {
              // Could this be OUR same-sub twin racing on an identical
              // username? DB authority says winner's username is canonical; if
              // the attempt is our own twin, complete as login instead of 409.
              const twin = await prisma.userAuthIdentity.findFirst({
                where: {
                  provider: 'GOOGLE',
                  providerSubject: claims.sub,
                  user: { username: selectedUsername },
                },
                include: { user: true },
              });
              if (twin) {
                if (twin.user.status !== 'ACTIVE') {
                  throw ApiError.forbidden('Account is not active');
                }
                await completeGoogleLogin(twin, request, reply);
                return;
              }
              throw ApiError.conflict('Username already taken');
            }

            // referralCode handled above; referredUserId / email / unknown
            // constraints are never Google-recoverable — rethrow.
          }
          throw err;
        }
      }

      throw ApiError.internal('Registration failed due to repeated referral code collisions');
    }
  );
}

function setAuthCookies(reply: FastifyReply, tokens: { accessToken: string; refreshToken: string }): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  };

  reply.setCookie('sp_access_token', tokens.accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60, // 15 minutes
  });

  reply.setCookie('sp_refresh_token', tokens.refreshToken, {
    ...cookieOptions,
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
}

function clearAuthCookies(reply: FastifyReply): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  };

  reply.clearCookie('sp_access_token', cookieOptions);
  reply.clearCookie('sp_refresh_token', cookieOptions);
}

// ─── Google-specific helpers ─────────────────────────────────

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days; matches setAuthCookies maxAge

function googleNonceCookieOptions() {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
    domain: config.COOKIE_DOMAIN,
    // Path-scoped to the Google endpoints so the raw nonce is never sent with
    // unrelated API requests. Covers both /auth/google and /auth/google/nonce.
    path: `${config.API_PREFIX}/auth/google`,
    signed: false,
    maxAge: 5 * 60, // 5 minutes
  };
}

function clearNonceCookie(reply: FastifyReply): void {
  reply.clearCookie('sp_google_nonce', googleNonceCookieOptions());
}

/** Minimal accepted user shape — permissive on role/status enums and nullability. */
interface GoogleUserShape {
  id: string;
  email: string | null;
  username: string;
  displayName: string | null;
  isVerified: boolean;
  role: unknown;
  status?: unknown;
  tokenVersion?: number;
}

interface GoogleLoginIdentity {
  id: string;
  user: GoogleUserShape;
}

/** Sanitized canonical auth user — never exposes tokenVersion/providerSubject. */
function sanitizeGoogleUser(user: GoogleUserShape) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    isVerified: user.isVerified,
    role: String(user.role),
  };
}

/**
 * RETURNING LOGIN (and same-sub race recovery) completion. Requires an ACTIVE
 * canonical user. Atomically updates lastLoginAt/lastUsedAt, creates a new
 * PlayQube session, sets auth cookies, and clears the nonce cookie.
 * Never creates/modifies a Referral.
 */
async function completeGoogleLogin(
  identity: GoogleLoginIdentity,
  request: { headers: { 'user-agent'?: string }; ip: string },
  reply: FastifyReply
): Promise<void> {
  const user = identity.user;
  if ((user.status as string | undefined) !== 'ACTIVE') {
    throw ApiError.forbidden('Account is not active');
  }

  const tokens = generateTokens(user.id, user.email, user.username, [String(user.role)], user.tokenVersion ?? 0);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await tx.userAuthIdentity.update({
      where: { id: identity.id },
      data: { lastUsedAt: new Date() },
    });
    await tx.session.create({
      data: {
        userId: user.id,
        refreshToken: tokens.refreshToken,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
  });

  clearNonceCookie(reply);
  setAuthCookies(reply, tokens);

  reply.status(200);
  reply.send({
    success: true,
    data: {
      user: sanitizeGoogleUser(user),
      ...tokens,
    },
  });

  // Post-commit best-effort: preserve ordinary server-verified LOGIN activity
  // semantics. Never breaks authentication.
  try {
    await safeRecordActivity(user.id, { type: 'LOGIN' });
  } catch {
    // activity/rewards are never required for authentication
  }
}