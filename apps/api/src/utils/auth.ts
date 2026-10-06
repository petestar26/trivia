import { config } from '@socialplay/config';
import { JwtPayload, RefreshTokenPayload, TokenPair } from '@socialplay/shared';
import { createHmac, randomUUID } from 'node:crypto';

export async function hashPassword(password: string): Promise<string> {
  // bcryptjs is CommonJS; under ESM its exports land on `.default`, so
  // `bcrypt.hash` is undefined on the namespace object itself.
  const { default: bcrypt } = await import('bcryptjs');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const { default: bcrypt } = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}

export function generateTokens(
  userId: string,
  email: string | null | undefined,
  username: string,
  roles: string[],
  tokenVersion: number = 0
): TokenPair {
  const accessPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
    sub: userId,
    ...(email ? { email } : {}),
    username,
    roles,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
  };

  // The refresh payload carries a cryptographically random `jti` so every
  // issued refresh token is unique by construction — even for two issuances
  // to the same user within the same second. iat/exp are second-resolution,
  // so without jti two same-second tokens would be byte-identical and collide
  // on Session.refreshToken's unique constraint.
  const refreshPayload: Omit<RefreshTokenPayload, 'iat' | 'exp'> & { jti: string } = {
    sub: userId,
    tokenVersion,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
    jti: randomUUID(),
  };

  const accessToken = signJwt(accessPayload, config.JWT_ACCESS_SECRET, config.JWT_ACCESS_EXPIRY);
  const refreshToken = signJwt(refreshPayload, config.JWT_REFRESH_SECRET, config.JWT_REFRESH_EXPIRY);

  const accessExpiry = parseExpiry(config.JWT_ACCESS_EXPIRY);

  return {
    accessToken,
    refreshToken,
    expiresIn: accessExpiry,
  };
}

function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresIn: string
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + parseExpiry(expiresIn);

  const fullPayload = {
    ...payload,
    iat: now,
    exp,
  };

  const base64UrlEncode = (obj: unknown): string => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(fullPayload);
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 24 * 60 * 60;
    default:
      return 15 * 60;
  }
}