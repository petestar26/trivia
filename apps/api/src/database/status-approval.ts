import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Signed approvals for the staff member-status boundary (dormant).
 *
 * The API signs a status change only after authenticating the administrator;
 * the database verifies the HMAC with an owner-only copy of the key before it
 * trusts the actor ID (docs/deployment/staff-member-status-boundary.sql). The
 * key never leaves this closure and is never logged.
 *
 * The payload is newline-joined plain text, not JSON: PostgreSQL's jsonb text
 * formatting differs from JSON.stringify, and both sides must sign the same
 * bytes. Every field is an ID, enum, integer, ISO time or hex digest; the free
 * text reason enters only as its SHA-256 digest.
 */
export const STATUS_APPROVAL_TTL_MS = 60_000;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_HEX = /^(?:[0-9a-fA-F]{2}){32,64}$/;

export interface StatusApprovalClaims {
  actorId: string;
  actorTokenVersion: number;
  memberId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  expectedUpdatedAt: string;
  reason: string;
}

export interface SignedStatusApproval {
  keyId: string;
  nonce: string;
  expiresAt: string;
  signature: string;
}

export interface StatusApprovalSigner {
  readonly keyId: string;
  sign(claims: StatusApprovalClaims, now?: Date): SignedStatusApproval;
}

export function statusApprovalPayload(
  keyId: string,
  claims: StatusApprovalClaims,
  nonce: string,
  expiresAt: string
): string {
  for (const value of [keyId, claims.actorId, claims.memberId, claims.status, claims.expectedUpdatedAt, nonce, expiresAt])
    if (/[\r\n]/.test(value)) throw new Error('STATUS_APPROVAL_FIELD_INVALID');
  if (!Number.isSafeInteger(claims.actorTokenVersion)) throw new Error('STATUS_APPROVAL_FIELD_INVALID');
  const reasonDigest = createHash('sha256').update(claims.reason, 'utf8').digest('hex');
  return [
    'salem-staff-member-status/v1',
    keyId,
    claims.actorId,
    String(claims.actorTokenVersion),
    claims.memberId,
    claims.status,
    claims.expectedUpdatedAt,
    reasonDigest,
    nonce,
    expiresAt,
  ].join('\n');
}

/**
 * The configured signer, or null when STAFF_STATUS_APPROVAL_KEY_ID /
 * STAFF_STATUS_APPROVAL_KEY are absent or malformed. Never throws: a bad key
 * closes isolated status changes (503) instead of stopping the API.
 */
export function createStatusApprovalSigner(env: NodeJS.ProcessEnv): StatusApprovalSigner | null {
  const keyId = env.STAFF_STATUS_APPROVAL_KEY_ID;
  const hex = env.STAFF_STATUS_APPROVAL_KEY;
  if (!keyId || !hex || !KEY_ID.test(keyId) || !KEY_HEX.test(hex)) return null;
  const key = Buffer.from(hex, 'hex');
  return {
    keyId,
    sign(claims, now = new Date()) {
      const nonce = randomBytes(32).toString('hex');
      const expiresAt = new Date(now.getTime() + STATUS_APPROVAL_TTL_MS).toISOString();
      const signature = createHmac('sha256', key)
        .update(statusApprovalPayload(keyId, claims, nonce, expiresAt), 'utf8')
        .digest('hex');
      return { keyId, nonce, expiresAt, signature };
    },
  };
}
