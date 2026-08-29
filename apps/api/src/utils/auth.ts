import { config } from '@socialplay/config';
import { JwtPayload, RefreshTokenPayload, TokenPair } from '@socialplay/shared';
import { FastifyInstance } from 'fastify';
import { createHmac } from 'crypto';

export async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}

export function generateTokens(
  userId: string,
  email: string,
  username: string,
  roles: string[]
): TokenPair {
  const fastify = { jwt: { sign: signJwt } } as unknown as FastifyInstance;

  const accessPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
    sub: userId,
    email,
    username,
    roles,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
  };

  const refreshPayload: Omit<RefreshTokenPayload, 'iat' | 'exp'> = {
    sub: userId,
    tokenVersion: 0,
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
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