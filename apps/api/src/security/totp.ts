import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 (TOTP) / RFC 4226 (HOTP) primitives.
 *
 * DEPENDENCY NOTE (W-0): the repository has no TOTP library and adding one
 * could not be verified in the implementation environment. The
 * cryptographic primitive here is Node's own `createHmac` — this module
 * implements only the RFC's counter framing, dynamic truncation, and
 * base32 transport encoding around it. No cryptographic algorithm is
 * hand-rolled.
 *
 * Nothing in this module logs or throws with secret material.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** SHA-1 is the RFC 6238 default and what authenticator apps assume. */
const TOTP_ALGORITHM = 'sha1';
const SECRET_BYTES = 20; // 160 bits, the RFC 4226 recommended length

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding) — authenticator apps expect this encoding. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decodes RFC 4648 base32. Throws on any character outside the alphabet. */
export function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a fresh 160-bit TOTP secret, base32-encoded for transport. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The RFC 6238 time-step counter for a given instant. */
export function timeStepFor(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP with RFC 6238 time-step counter framing. */
function generateCode(secret: Buffer, counter: number): string {
  // 8-byte big-endian counter. Written as two 32-bit halves because
  // Node's writeUInt32BE pair avoids BigInt without losing range for any
  // realistic timestamp.
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(TOTP_ALGORITHM, secret).update(counterBuffer).digest();

  // RFC 4226 §5.4 dynamic truncation.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** Generates the code for a base32 secret at a given time step. */
export function generateTotpCode(base32Secret: string, counter: number): string {
  return generateCode(base32Decode(base32Secret), counter);
}

export interface TotpVerifyResult {
  valid: boolean;
  /** The time step the code matched — the caller persists this to block replay. */
  timeStep: number | null;
}

/**
 * Verifies a submitted code against a secret.
 *
 * `window` tolerates clock skew by checking adjacent steps. `minTimeStep`
 * enforces replay protection: a code from a step already consumed is
 * rejected even if it is still within the skew window.
 *
 * Comparison is constant-time. The candidate loop does NOT short-circuit
 * on first match, so verification cost does not vary with which step
 * matched.
 */
export function verifyTotpCode(
  base32Secret: string,
  submittedCode: string,
  options: { window?: number; at?: Date; minTimeStep?: number | null } = {}
): TotpVerifyResult {
  const window = options.window ?? 1;
  const currentStep = timeStepFor(options.at ?? new Date());
  const minTimeStep = options.minTimeStep ?? null;

  // Reject anything that is not exactly the expected digit count before
  // touching the secret at all.
  if (!/^\d+$/.test(submittedCode) || submittedCode.length !== TOTP_DIGITS) {
    return { valid: false, timeStep: null };
  }

  const secret = base32Decode(base32Secret);
  const submitted = Buffer.from(submittedCode, 'utf8');

  let matchedStep: number | null = null;
  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + offset;
    if (step < 0) continue;
    // Replay protection: never accept a step at or below one already used.
    if (minTimeStep !== null && step <= minTimeStep) continue;

    const candidate = Buffer.from(generateCode(secret, step), 'utf8');
    if (candidate.length === submitted.length && timingSafeEqual(candidate, submitted)) {
      matchedStep = step;
      // Intentionally no `break` — keeps the number of HMAC computations
      // independent of which step matched.
    }
  }

  return { valid: matchedStep !== null, timeStep: matchedStep };
}

/**
 * Builds the otpauth:// URI an authenticator app scans.
 *
 * Contains the shared secret by necessity — it is returned exactly once,
 * during enrollment start, over the authenticated channel, and must never
 * be logged or audited.
 */
export function buildOtpAuthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
