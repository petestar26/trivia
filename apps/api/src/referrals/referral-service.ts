import { randomInt } from 'node:crypto';
import { prisma } from '@socialplay/database';

// ─── Constants ────────────────────────────────────────────────
// Locked canonical alphabet. Excluded: 0, O, 1, I, L
// to reduce transcription ambiguity.
export const REFERRAL_CODE_LENGTH = 8;
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// Bounded retry for own-code generation collisions.
// The DB unique constraint is authoritative; this is a safety net.
const MAX_CODE_GEN_RETRIES = 20;

// ─── Canonicalization ─────────────────────────────────────────
export function canonicalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

// ─── Validation ───────────────────────────────────────────────
const VALID_CODE_RE = new RegExp(`^[${escapeRegex(REFERRAL_CODE_ALPHABET)}]{${REFERRAL_CODE_LENGTH}}$`);

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function isValidReferralCode(code: string): boolean {
  return VALID_CODE_RE.test(code);
}

// ─── Code Generation ──────────────────────────────────────────
// Cryptographically random 8-char code from the locked alphabet.
export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    const idx = randomInt(REFERRAL_CODE_ALPHABET.length);
    code += REFERRAL_CODE_ALPHABET[idx];
  }
  return code;
}

/**
 * Generate a unique referral code by retrying on collision.
 * Returns the generated code or throws after MAX_CODE_GEN_RETRIES attempts.
 * Must be called inside a transaction context so collisions surface
 * as P2002 — but this function does a pre-check to reduce attempts.
 */
export async function generateUniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_GEN_RETRIES; attempt++) {
    const candidate = generateReferralCode();
    const existing = await prisma.user.findUnique({
      where: { referralCode: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error('Failed to generate unique referral code after maximum attempts');
}

// ─── Referrer Resolution ──────────────────────────────────────
export type ReferrerResolution =
  | { ok: true; referrerId: string }
  | { ok: false; error: string };

export async function resolveReferrer(canonicalCode: string): Promise<ReferrerResolution> {
  const referrer = await prisma.user.findUnique({
    where: { referralCode: canonicalCode },
    select: { id: true, status: true },
  });

  if (!referrer) {
    return { ok: false, error: 'Invalid referral code' };
  }

  if (referrer.status !== 'ACTIVE') {
    return { ok: false, error: 'Invalid referral code' };
  }

  return { ok: true, referrerId: referrer.id };
}
