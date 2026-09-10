import { OAuth2Client } from 'google-auth-library';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@socialplay/config';

// ─── Transient shapes ───────────────────────────────────────

export interface VerifiedGoogleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  hd?: string;
}

export type GoogleVerifyResult =
  | { kind: 'invalid' }
  | { kind: 'unavailable' }
  | { kind: 'verified'; claims: VerifiedGoogleIdentity };

// ─── DI seam: verifyIdToken function signature ──────────────

export type VerifyIdTokenFn = (opts: {
  idToken: string;
  audience: string;
}) => Promise<Record<string, unknown>>;

export type GoogleIdVerifier = (
  credential: string,
  expectedNonceHash: string,
) => Promise<GoogleVerifyResult>;

// ─── Transient error classification ─────────────────────────

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { code?: unknown; response?: { status?: number } };
  if (typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  if (e.response && typeof e.response.status === 'number' && e.response.status >= 500) return true;
  return false;
}

// ─── Nonce helpers ──────────────────────────────────────────

export function generateNonceSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashNonceSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

// ─── Constant-time comparison ───────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ─── Factory: createGoogleVerifier ──────────────────────────

export function createGoogleVerifier(
  verifyIdToken: VerifyIdTokenFn,
  audience: string | undefined,
): GoogleIdVerifier {
  return async (credential, expectedNonceHash) => {
    let payload: Record<string, unknown>;
    try {
      payload = await verifyIdToken({
        idToken: credential,
        audience: audience ?? '',
      });
    } catch (err) {
      if (isTransient(err)) return { kind: 'unavailable' };
      return { kind: 'invalid' };
    }

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) return { kind: 'invalid' };

    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!nonce) return { kind: 'invalid' };

    if (!safeEqual(nonce, expectedNonceHash)) return { kind: 'invalid' };

    return {
      kind: 'verified',
      claims: {
        sub,
        ...(typeof payload.email === 'string' && payload.email
          ? { email: payload.email }
          : {}),
        emailVerified: payload.email_verified === true,
        ...(typeof payload.hd === 'string' && payload.hd
          ? { hd: payload.hd }
          : {}),
      },
    };
  };
}

// ─── Production weld ────────────────────────────────────────

const oauthClient = new OAuth2Client();

export const googleIdTokenVerifier: GoogleIdVerifier = createGoogleVerifier(
  (opts) =>
    oauthClient
      .verifyIdToken({ idToken: opts.idToken, audience: opts.audience })
      .then((ticket) => (ticket.getPayload() ?? {}) as Record<string, unknown>),
  config.GOOGLE_CLIENT_ID,
);

// ─── Email authority helpers ────────────────────────────────

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

export function isGoogleAuthoritativeEmail(claims: {
  email?: string;
  emailVerified: boolean;
  hd?: string;
}): boolean {
  if (!claims.email) return false;
  if (emailDomain(claims.email) === 'gmail.com') return true;
  return (
    claims.emailVerified &&
    typeof claims.hd === 'string' &&
    claims.hd.length > 0
  );
}
