import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

// Only the gateway may attest an anonymous client's address. Never trust
// arbitrary Forwarded/X-Forwarded-For headers on the public API endpoint.
export function anonymousRateLimitKey(request: FastifyRequest, secret?: string): string {
  const ip = request.headers['x-playqube-client-ip'];
  const timestamp = request.headers['x-playqube-client-time'];
  const signature = request.headers['x-playqube-client-signature'];
  if (secret && typeof ip === 'string' && isIP(ip) && typeof timestamp === 'string' && /^\d{13}$/.test(timestamp)
      && Math.abs(Date.now() - Number(timestamp)) <= 30_000
      && typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature)) {
    const expected = createHmac('sha256', secret)
      .update(JSON.stringify([timestamp, request.method, request.raw.url, ip])).digest();
    if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return `ip:${ip}`;
  }
  return `ip:${request.ip}`;
}

export function createRateLimitKey(secret?: string) {
  return async (request: FastifyRequest): Promise<string> => {
    // Authenticate here, before the rate-limit onRequest hook. Merely decoding
    // a token or relying on a later preHandler would allow forged/shared keys.
    try {
      const user = await request.jwtVerify<{ sub: string }>();
      if (typeof user.sub === 'string' && user.sub.length > 0 && user.sub.length <= 128) return `user:${user.sub}`;
    } catch { /* Invalid/expired credentials retain the anonymous limit. */ }
    return anonymousRateLimitKey(request, secret);
  };
}

// Run at preHandler, after JSON parsing and the cookie plugin. Use a stable,
// signature-verified, live-session account bucket: rotations cannot reset it, and
// unrelated accounts behind one gateway never consume each other's quota.
// This identifies a limiter bucket only; /refresh still checks the stored
// session, account status, revocation version and atomic rotation itself.
type RefreshSessionIdentity = {userId:string;expiresAt:Date;user:{status:string;tokenVersion:number}};
export function createRefreshRateLimitKey(
  refreshSecret: string,
  findSession: (token:string)=>Promise<RefreshSessionIdentity|null>,
  gatewaySecret?: string,
) {
  return async (request: FastifyRequest): Promise<string> => {
    const bodyToken = (request.body as {refreshToken?: unknown} | undefined)?.refreshToken;
    const token = bodyToken === undefined ? request.cookies.sp_refresh_token : bodyToken;
    if (typeof token === 'string' && token.length <= 8192) {
      let claims: {sub?:unknown;tokenVersion?:unknown} | undefined;
      try {
        claims = await request.server.jwt.verify<NonNullable<typeof claims>>(token, {key:refreshSecret});
      } catch { /* Forged/expired tokens share the anonymous abuse allowance. */ }
      if (typeof claims?.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 128 && Number.isSafeInteger(claims.tokenVersion)) {
        // An old, correctly signed token must not consume a live account's
        // quota after rotation/revocation. Database failures propagate; they
        // are not treated as a missing session or an authentication success.
        const session = await findSession(token);
        if (session?.userId === claims.sub && session.expiresAt.getTime() > Date.now()
            && session.user.status === 'ACTIVE' && session.user.tokenVersion === claims.tokenVersion) {
          return `refresh:${createHash('sha256').update(claims.sub).digest('hex')}`;
        }
      }
    }
    return anonymousRateLimitKey(request, gatewaySecret);
  };
}
