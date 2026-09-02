import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import {
  startTotpEnrollment,
  activateTotpFactor,
  verifyTotpForUser,
  disableTotpFactor,
  listOwnFactors,
} from './totp-service';
import {
  performStepUp,
  requireStepUp,
  requiresStepUp,
  setOwnStepUpPolicy,
} from './step-up-service';
import { issueChallenge, consumeChallenge } from './challenge-service';
import { encryptSecret, decryptSecret } from './crypto';
import {
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  timeStepFor,
  base32Encode,
  base32Decode,
} from './totp';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `sec-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `sec_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Sec ${tag}`,
    },
  });
}

async function cleanSecurityFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'sec-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.stepUpVerification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.securityChallenge.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTotpFactor.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userSecurityPolicy.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

/** Completes a full enrollment and returns the live secret for the test. */
async function enrollActiveTotp(userId: string) {
  const started = await startTotpEnrollment(userId);
  const code = generateTotpCode(started.secret, timeStepFor());
  await activateTotpFactor(userId, started.challenge, code);
  return started.secret;
}

/** A code for a future time step, so replay guards don't reject it. */
function codeAtStepOffset(secret: string, offset: number): { code: string; step: number } {
  const step = timeStepFor() + offset;
  return { code: generateTotpCode(secret, step), step };
}

// ═══════════════════════════════════════════════════════════════
// PURE PRIMITIVES (no database required)
// ═══════════════════════════════════════════════════════════════

describe('TOTP primitives (RFC 6238)', () => {
  it('base32 round-trips', () => {
    const buf = Buffer.from('the quick brown fox', 'utf8');
    expect(base32Decode(base32Encode(buf)).toString('utf8')).toBe('the quick brown fox');
  });

  it('rejects invalid base32 characters', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow();
  });

  it('generates a 6-digit numeric code', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret, timeStepFor());
    expect(code).toMatch(/^\d{6}$/);
  });

  it('accepts a correct current code', () => {
    const secret = generateTotpSecret();
    const step = timeStepFor();
    const result = verifyTotpCode(secret, generateTotpCode(secret, step));
    expect(result.valid).toBe(true);
    expect(result.timeStep).toBe(step);
  });

  it('rejects a code from the wrong secret', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    const result = verifyTotpCode(a, generateTotpCode(b, timeStepFor()));
    expect(result.valid).toBe(false);
  });

  it('rejects malformed codes without throwing', () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(verifyTotpCode(secret, bad).valid).toBe(false);
    }
  });

  it('rejects a code at or below the replay watermark', () => {
    const secret = generateTotpSecret();
    const step = timeStepFor();
    const code = generateTotpCode(secret, step);
    // Same step already consumed → replay rejected.
    expect(verifyTotpCode(secret, code, { minTimeStep: step }).valid).toBe(false);
    // Watermark below the step → still acceptable.
    expect(verifyTotpCode(secret, code, { minTimeStep: step - 1 }).valid).toBe(true);
  });

  it('tolerates clock skew within the window but not beyond it', () => {
    const secret = generateTotpSecret();
    const step = timeStepFor();
    expect(verifyTotpCode(secret, generateTotpCode(secret, step - 1)).valid).toBe(true);
    expect(verifyTotpCode(secret, generateTotpCode(secret, step - 5)).valid).toBe(false);
  });
});

describe('Secret encryption at rest', () => {
  // These run only when the server is configured for TOTP; otherwise the
  // helper correctly fails closed and there is nothing to assert.
  const configured = Boolean(process.env.SECURITY_TOTP_ENCRYPTION_KEY);
  const itIf = configured ? it : it.skip;

  itIf('round-trips a secret', () => {
    const secret = generateTotpSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  itIf('never stores the plaintext secret in the ciphertext', () => {
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  itIf('produces a different ciphertext each time (random IV)', () => {
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  itIf('rejects tampered ciphertext rather than returning bad plaintext', () => {
    const encoded = encryptSecret(generateTotpSecret());
    const parts = encoded.split(':');
    // Flip a byte in the ciphertext segment.
    parts[3] = (parts[3][0] === 'a' ? 'b' : 'a') + parts[3].slice(1);
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  itIf('rejects a malformed envelope', () => {
    expect(() => decryptSecret('not-a-valid-envelope')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// DATABASE-BACKED SECURITY BEHAVIOUR
// ═══════════════════════════════════════════════════════════════

describeIf('TOTP enrollment lifecycle', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('enrollment starts pending and activates with a valid code', async () => {
    const user = await createUser('enroll1');
    const started = await startTotpEnrollment(user.id);
    expect(started.otpauthUri).toContain('otpauth://totp/');

    const pending = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(pending!.status).toBe('PENDING_ACTIVATION');

    const factor = await activateTotpFactor(
      user.id,
      started.challenge,
      generateTotpCode(started.secret, timeStepFor())
    );
    expect(factor.status).toBe('ACTIVE');
    expect(factor.activatedAt).toBeTruthy();
  });

  it('rejects activation with an invalid code and leaves the factor pending', async () => {
    const user = await createUser('enroll2');
    const started = await startTotpEnrollment(user.id);

    await expect(
      activateTotpFactor(user.id, started.challenge, '000000')
    ).rejects.toThrow(/invalid verification code/i);

    const factor = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(factor!.status).toBe('PENDING_ACTIVATION');
  });

  it('rejects activation with a malformed code', async () => {
    const user = await createUser('enroll3');
    const started = await startTotpEnrollment(user.id);
    await expect(activateTotpFactor(user.id, started.challenge, 'abcdef')).rejects.toThrow();
  });

  it('refuses to restart enrollment once the factor is ACTIVE', async () => {
    const user = await createUser('enroll4');
    await enrollActiveTotp(user.id);
    await expect(startTotpEnrollment(user.id)).rejects.toThrow(/already enabled/i);
  });

  it('never returns the stored secret from the factor listing', async () => {
    const user = await createUser('enroll5');
    const secret = await enrollActiveTotp(user.id);
    const factors = await listOwnFactors(user.id);
    expect(JSON.stringify(factors)).not.toContain(secret);
    expect(JSON.stringify(factors)).not.toMatch(/secret/i);
  });

  it('stores the secret encrypted, never in plaintext', async () => {
    const user = await createUser('enroll6');
    const secret = await enrollActiveTotp(user.id);
    const row = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(row!.encryptedSecret).not.toContain(secret);
    expect(row!.encryptedSecret.startsWith('v1:')).toBe(true);
  });
});

describeIf('TOTP verification and replay protection', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('verifies a valid code for an active factor', async () => {
    const user = await createUser('verify1');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    const result = await verifyTotpForUser(user.id, next.code);
    expect(result.verified).toBe(true);
  });

  it('rejects an invalid code', async () => {
    const user = await createUser('verify2');
    await enrollActiveTotp(user.id);
    await expect(verifyTotpForUser(user.id, '000000')).rejects.toThrow();
  });

  it('rejects reuse of the same code (replay)', async () => {
    const user = await createUser('verify3');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);

    await verifyTotpForUser(user.id, next.code);
    // Exact same code, same time step → must be refused.
    await expect(verifyTotpForUser(user.id, next.code)).rejects.toThrow();
  });

  it('rejects verification when no factor exists, without revealing that', async () => {
    const user = await createUser('verify4');
    await expect(verifyTotpForUser(user.id, '123456')).rejects.toThrow(
      /two-factor verification failed/i
    );
  });

  it('rejects verification for a DISABLED factor', async () => {
    const user = await createUser('verify5');
    const secret = await enrollActiveTotp(user.id);
    const off = codeAtStepOffset(secret, 1);
    await disableTotpFactor(user.id, off.code);

    const later = codeAtStepOffset(secret, 2);
    await expect(verifyTotpForUser(user.id, later.code)).rejects.toThrow();
  });

  it('REGRESSION (Defect 1): concurrent wrong codes each increment the counter', async () => {
    // The failure path previously did a read-then-write:
    //   const attempts = factor.failedAttempts + 1;  // stale snapshot
    //   update({ data: { failedAttempts: attempts } })
    // so N parallel wrong codes all read the same value and all wrote the
    // same value — the counter advanced by 1 instead of N, letting an
    // attacker brute-force past the lockout by submitting in parallel.
    // The fix uses an atomic `{ increment: 1 }`.
    const user = await createUser('bruteforce1');
    await enrollActiveTotp(user.id);

    const ATTEMPTS = 4; // deliberately below MAX_FAILED_ATTEMPTS (5)
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () => verifyTotpForUser(user.id, '000000'))
    );
    // Every attempt must be rejected — none of these are valid codes.
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const factor = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    // The core assertion: no increments lost. Pre-fix this was 1.
    expect(factor!.failedAttempts).toBe(ATTEMPTS);
    // Still below the threshold, so not locked yet.
    expect(factor!.lockedUntil).toBeNull();
  });

  it('REGRESSION (Defect 1): concurrent wrong codes crossing the threshold apply the lockout', async () => {
    const user = await createUser('bruteforce2');
    const secret = await enrollActiveTotp(user.id);

    const ATTEMPTS = 6; // exceeds MAX_FAILED_ATTEMPTS (5)
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () => verifyTotpForUser(user.id, '000000'))
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const factor = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(factor!.failedAttempts).toBe(ATTEMPTS);
    // Lockout must actually be applied once the threshold is crossed.
    expect(factor!.lockedUntil).not.toBeNull();
    expect(factor!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // And the lockout must be enforced: even a genuinely VALID code is
    // refused while locked, with the rate-limit error rather than the
    // generic verification failure.
    const valid = codeAtStepOffset(secret, 1);
    await expect(verifyTotpForUser(user.id, valid.code)).rejects.toThrow(
      /too many failed attempts/i
    );
  });

  it('a successful verification clears the failed-attempt counter', async () => {
    const user = await createUser('bruteforce3');
    const secret = await enrollActiveTotp(user.id);

    await expect(verifyTotpForUser(user.id, '000000')).rejects.toThrow();
    const afterFailure = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(afterFailure!.failedAttempts).toBeGreaterThan(0);

    const valid = codeAtStepOffset(secret, 1);
    await verifyTotpForUser(user.id, valid.code);

    const afterSuccess = await prisma.userTotpFactor.findUnique({ where: { userId: user.id } });
    expect(afterSuccess!.failedAttempts).toBe(0);
    expect(afterSuccess!.lockedUntil).toBeNull();
  });

  it('CONCURRENCY: the same code cannot be consumed twice in parallel', async () => {
    const user = await createUser('verify6');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);

    const results = await Promise.allSettled([
      verifyTotpForUser(user.id, next.code),
      verifyTotpForUser(user.id, next.code),
      verifyTotpForUser(user.id, next.code),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
  });
});

describeIf('Security challenges', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('a valid challenge is accepted exactly once', async () => {
    const user = await createUser('chal1');
    const issued = await issueChallenge(user.id, 'STEP_UP');

    await expect(consumeChallenge(user.id, 'STEP_UP', issued.challenge)).resolves.toBeUndefined();
    await expect(consumeChallenge(user.id, 'STEP_UP', issued.challenge)).rejects.toThrow(
      /invalid or expired challenge/i
    );
  });

  it('rejects a challenge belonging to another user', async () => {
    const owner = await createUser('chal2owner');
    const stranger = await createUser('chal2stranger');
    const issued = await issueChallenge(owner.id, 'STEP_UP');

    await expect(
      consumeChallenge(stranger.id, 'STEP_UP', issued.challenge)
    ).rejects.toThrow(/invalid or expired challenge/i);

    // And it must still be usable by its real owner.
    await expect(consumeChallenge(owner.id, 'STEP_UP', issued.challenge)).resolves.toBeUndefined();
  });

  it('rejects a challenge used for the wrong purpose', async () => {
    const user = await createUser('chal3');
    const issued = await issueChallenge(user.id, 'TOTP_ENROLLMENT');
    await expect(consumeChallenge(user.id, 'STEP_UP', issued.challenge)).rejects.toThrow();
  });

  it('rejects an expired challenge', async () => {
    const user = await createUser('chal4');
    const issued = await issueChallenge(user.id, 'STEP_UP', -1); // already expired
    await expect(consumeChallenge(user.id, 'STEP_UP', issued.challenge)).rejects.toThrow();
  });

  it('rejects an unknown challenge value', async () => {
    const user = await createUser('chal5');
    await expect(consumeChallenge(user.id, 'STEP_UP', 'no-such-challenge')).rejects.toThrow();
  });

  it('CONCURRENCY: parallel consumption succeeds exactly once', async () => {
    const user = await createUser('chal6');
    const issued = await issueChallenge(user.id, 'STEP_UP');

    const results = await Promise.allSettled([
      consumeChallenge(user.id, 'STEP_UP', issued.challenge),
      consumeChallenge(user.id, 'STEP_UP', issued.challenge),
      consumeChallenge(user.id, 'STEP_UP', issued.challenge),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });
});

describeIf('Step-up authentication', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('a successful step-up produces a bounded, purpose-scoped authorisation', async () => {
    const user = await createUser('step1');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);

    const result = await performStepUp(
      { userId: user.id, tokenIat: 1000 },
      'SENSITIVE_ACCOUNT_OPERATION',
      'TOTP',
      next.code
    );
    expect(result.purpose).toBe('SENSITIVE_ACCOUNT_OPERATION');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await expect(
      requireStepUp({ userId: user.id, tokenIat: 1000 }, 'SENSITIVE_ACCOUNT_OPERATION')
    ).resolves.toBeUndefined();
  });

  it('a step-up is single-use', async () => {
    const user = await createUser('step2');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    await requireStepUp({ userId: user.id, tokenIat: 1000 }, 'OP');
    await expect(requireStepUp({ userId: user.id, tokenIat: 1000 }, 'OP')).rejects.toThrow(
      /step-up authentication required/i
    );
  });

  it('rejects a step-up used for a different purpose', async () => {
    const user = await createUser('step3');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: user.id, tokenIat: 1000 }, 'PURPOSE_A', 'TOTP', next.code);

    await expect(
      requireStepUp({ userId: user.id, tokenIat: 1000 }, 'PURPOSE_B')
    ).rejects.toThrow(/step-up authentication required/i);
  });

  it('rejects a step-up bound to a different token instance', async () => {
    const user = await createUser('step4');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    // Same user, same purpose, different token → must not carry over.
    await expect(requireStepUp({ userId: user.id, tokenIat: 2000 }, 'OP')).rejects.toThrow();
  });

  it('rejects another user attempting to use a step-up', async () => {
    const owner = await createUser('step5owner');
    const stranger = await createUser('step5stranger');
    const secret = await enrollActiveTotp(owner.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: owner.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    await expect(requireStepUp({ userId: stranger.id, tokenIat: 1000 }, 'OP')).rejects.toThrow();
  });

  it('rejects an expired step-up', async () => {
    const user = await createUser('step6');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    const result = await performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    // Force expiry rather than waiting out the TTL.
    await prisma.stepUpVerification.update({
      where: { id: result.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(requireStepUp({ userId: user.id, tokenIat: 1000 }, 'OP')).rejects.toThrow();
  });

  it('rejects an unsupported factor type', async () => {
    const user = await createUser('step7');
    await enrollActiveTotp(user.id);
    await expect(
      performStepUp(
        { userId: user.id, tokenIat: 1000 },
        'OP',
        'WEBAUTHN' as unknown as 'TOTP',
        '123456'
      )
    ).rejects.toThrow(/unsupported authentication factor/i);
  });

  it('step-up fails when the code is invalid', async () => {
    const user = await createUser('step8');
    await enrollActiveTotp(user.id);
    await expect(
      performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', '000000')
    ).rejects.toThrow();
  });

  it('CONCURRENCY: one step-up cannot authorise two operations', async () => {
    const user = await createUser('step9');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    const results = await Promise.allSettled([
      requireStepUp({ userId: user.id, tokenIat: 1000 }, 'OP'),
      requireStepUp({ userId: user.id, tokenIat: 1000 }, 'OP'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });
});

describeIf('Security policy', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('defaults to not requiring step-up', async () => {
    const user = await createUser('policy1');
    expect(await requiresStepUp(user.id)).toBe(false);
  });

  it('cannot require step-up without an active factor', async () => {
    const user = await createUser('policy2');
    await expect(setOwnStepUpPolicy(user.id, true)).rejects.toThrow(
      /enable an authentication factor/i
    );
  });

  it('can require step-up once a factor is active', async () => {
    const user = await createUser('policy3');
    await enrollActiveTotp(user.id);
    const policy = await setOwnStepUpPolicy(user.id, true);
    expect(policy.requiresStepUpForSensitiveOps).toBe(true);
    expect(await requiresStepUp(user.id)).toBe(true);
  });

  it('policy is per-user and never leaks across users', async () => {
    const a = await createUser('policy4a');
    const b = await createUser('policy4b');
    await enrollActiveTotp(a.id);
    await setOwnStepUpPolicy(a.id, true);
    expect(await requiresStepUp(b.id)).toBe(false);
  });
});

describeIf('Audit and secret hygiene', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it('audit records the lifecycle without ever containing secret material', async () => {
    const user = await createUser('audit1');
    const started = await startTotpEnrollment(user.id);
    await activateTotpFactor(
      user.id,
      started.challenge,
      generateTotpCode(started.secret, timeStepFor())
    );

    const logs = await prisma.auditLog.findMany({ where: { userId: user.id } });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('TOTP_ENROLLMENT_STARTED');
    expect(actions).toContain('TOTP_ENABLED');

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(started.secret);
    expect(serialized).not.toContain(started.challenge);
    expect(serialized).not.toMatch(/otpauth:\/\//);
  });

  it('step-up audit contains no code or secret', async () => {
    const user = await createUser('audit2');
    const secret = await enrollActiveTotp(user.id);
    const next = codeAtStepOffset(secret, 1);
    await performStepUp({ userId: user.id, tokenIat: 1000 }, 'OP', 'TOTP', next.code);

    const logs = await prisma.auditLog.findMany({
      where: { userId: user.id, action: 'SECURITY_STEP_UP_SUCCEEDED' },
    });
    expect(logs.length).toBe(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(next.code);
  });

  it('notifies the user when a factor is enabled and disabled', async () => {
    const user = await createUser('audit3');
    const secret = await enrollActiveTotp(user.id);
    const off = codeAtStepOffset(secret, 1);
    await disableTotpFactor(user.id, off.code);

    const notifications = await prisma.notification.findMany({ where: { userId: user.id } });
    const events = notifications.map((n) => (n.data as Record<string, unknown>)?.securityEvent);
    expect(events).toContain('TOTP_ENABLED');
    expect(events).toContain('TOTP_DISABLED');
    // Notifications must not leak secret material either.
    expect(JSON.stringify(notifications)).not.toContain(secret);
  });
});

describeIf('Cross-user isolation', () => {
  beforeAll(async () => {
    await cleanSecurityFixtures();
  });

  it("a user's factor listing only ever shows their own factor", async () => {
    const a = await createUser('iso1a');
    const b = await createUser('iso1b');
    await enrollActiveTotp(a.id);

    expect((await listOwnFactors(a.id)).length).toBe(1);
    expect((await listOwnFactors(b.id)).length).toBe(0);
  });

  it("one user's code cannot verify against another user's factor", async () => {
    const a = await createUser('iso2a');
    const b = await createUser('iso2b');
    const secretA = await enrollActiveTotp(a.id);
    await enrollActiveTotp(b.id);

    // A's current code must not satisfy B's factor.
    const aCode = codeAtStepOffset(secretA, 1);
    await expect(verifyTotpForUser(b.id, aCode.code)).rejects.toThrow();
  });

  it('disabling is scoped to the caller and cannot target another user', async () => {
    const a = await createUser('iso3a');
    const b = await createUser('iso3b');
    const secretA = await enrollActiveTotp(a.id);
    await enrollActiveTotp(b.id);

    // B cannot disable using A's code; B's factor stays ACTIVE.
    const aCode = codeAtStepOffset(secretA, 1);
    await expect(disableTotpFactor(b.id, aCode.code)).rejects.toThrow();

    const bFactor = await prisma.userTotpFactor.findUnique({ where: { userId: b.id } });
    expect(bFactor!.status).toBe('ACTIVE');
  });
});
