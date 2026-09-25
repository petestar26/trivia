import { createHmac, randomBytes } from 'node:crypto';
import { config } from '@socialplay/config';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';

export type ApprovalSubject = 'ADMIN_ADJUSTMENT' | 'LEGACY_REVIEW';
export type ApprovalAction = 'REQUEST' | 'FIRST_APPROVAL' | 'SECOND_APPROVAL' | 'REJECT' | 'CANCEL' | 'REOPEN';

/** The terms one approval decision binds (see ledger_approval_assertions). */
export interface ApprovalAssertionTerms {
  subjectType: ApprovalSubject;
  subjectId: string;
  action: ApprovalAction;
  actorId: string;
  userId: string;
  /** Signed, whole Coins. */
  amount: number;
  caseId: string;
  evidence: unknown;
}

export interface SignedApprovalAssertion {
  keyId: string;
  nonce: string;
  signature: string;
}

function approvalSigningKey(): { keyId: string; secret: Buffer } {
  const hex = config.LEDGER_APPROVAL_SIGNING_KEY;
  if (!hex) throw ApiError.serviceUnavailable('Ledger approvals are not configured on this server');
  return { keyId: config.LEDGER_APPROVAL_KEY_ID, secret: Buffer.from(hex, 'hex') };
}

/**
 * Signs one approval decision, after the API has authenticated its actor as
 * an active SUPER_ADMIN. The payload text comes from the database
 * (ledger_approval_payload), so both sides sign and verify exactly the same
 * bytes; the key never leaves this process. The database verifies the
 * signature with its own copy of the key, which the runtime role cannot
 * read, so SQL run as that role cannot produce a valid approval.
 */
export async function signApprovalAssertion(
  tx: Prisma.TransactionClient, terms: ApprovalAssertionTerms,
): Promise<SignedApprovalAssertion> {
  const key = approvalSigningKey();
  const nonce = randomBytes(24).toString('hex');
  const rows = await tx.$queryRaw<{ payload: string }[]>`
    SELECT "ledger_approval_payload"(${terms.subjectType}, ${terms.subjectId}, ${terms.action}, ${terms.actorId},
      ${terms.userId}, ${String(terms.amount)}::numeric, ${terms.caseId},
      "ledger_evidence_digest"(${JSON.stringify(terms.evidence ?? null)}::jsonb), ${nonce}) AS "payload"
  `;
  const payload = rows[0]?.payload;
  if (!payload) throw ApiError.internal('Ledger approval payload unavailable');
  return { keyId: key.keyId, nonce, signature: createHmac('sha256', key.secret).update(payload, 'utf8').digest('hex') };
}
