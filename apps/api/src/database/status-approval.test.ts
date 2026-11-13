import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStatusApprovalSigner, statusApprovalPayload } from './status-approval.js';

const env = { STAFF_STATUS_APPROVAL_KEY_ID: 'synthetic-key', STAFF_STATUS_APPROVAL_KEY: 'cd'.repeat(32) };
const claims = {
  actorId: '33333333-3333-4333-8333-333333333333',
  actorTokenVersion: 4,
  memberId: '11111111-1111-4111-8111-111111111111',
  status: 'SUSPENDED' as const,
  expectedUpdatedAt: '2026-11-13T00:00:00.000Z',
  reason: 'synthetic review',
};

describe('status approval signer', () => {
  it.each([
    [{}],
    [{ STAFF_STATUS_APPROVAL_KEY_ID: 'synthetic-key' }],
    [{ ...env, STAFF_STATUS_APPROVAL_KEY: 'zz'.repeat(32) }],
    [{ ...env, STAFF_STATUS_APPROVAL_KEY: 'ab'.repeat(31) }],
    [{ ...env, STAFF_STATUS_APPROVAL_KEY_ID: 'bad key id' }],
  ])('is absent (never throws) for missing or malformed configuration %#', (config) => {
    expect(createStatusApprovalSigner(config)).toBeNull();
  });

  it('signs a fresh nonce, a 60-second expiry and the exact payload the database recomputes', () => {
    const signer = createStatusApprovalSigner(env)!;
    const now = new Date('2026-11-13T00:00:00.000Z');
    const a = signer.sign(claims, now);
    const b = signer.sign(claims, now);
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAt).toBe('2026-11-13T00:01:00.000Z');
    const payload = statusApprovalPayload('synthetic-key', claims, a.nonce, a.expiresAt);
    expect(payload.split('\n')).toEqual([
      'salem-staff-member-status/v1', 'synthetic-key', claims.actorId, '4', claims.memberId, 'SUSPENDED',
      claims.expectedUpdatedAt, expect.stringMatching(/^[0-9a-f]{64}$/), a.nonce, a.expiresAt,
    ]);
    expect(a.signature).toBe(createHmac('sha256', Buffer.from(env.STAFF_STATUS_APPROVAL_KEY, 'hex')).update(payload).digest('hex'));
    expect(JSON.stringify(a)).not.toContain(env.STAFF_STATUS_APPROVAL_KEY);
  });

  it('refuses fields that could forge payload lines', () => {
    const signer = createStatusApprovalSigner(env)!;
    expect(() => signer.sign({ ...claims, memberId: `${claims.memberId}\nSUSPENDED` })).toThrow('STATUS_APPROVAL_FIELD_INVALID');
    expect(() => signer.sign({ ...claims, actorTokenVersion: Number.NaN })).toThrow('STATUS_APPROVAL_FIELD_INVALID');
  });
});
