import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import {
  executeCoinAdjustment, firstApproveCoinAdjustment, requestCoinAdjustment,
} from '../economy/admin-adjustment-service.js';

export interface Approvers { first: { id: string }; second: { id: string } }

/** Two distinct, active SUPER_ADMINs. */
export async function makeApprovers(label = 'adjust'): Promise<Approvers> {
  const make = async (role: string) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    return prisma.user.create({ data: {
      email: `${label}-${role}-${suffix}@test.local`, username: `${label}_${role}_${suffix}`.slice(0, 30),
      displayName: `Adjustment ${role}`, passwordHash: 'fixture-only', role: 'SUPER_ADMIN',
    } });
  };
  return { first: await make('first'), second: await make('second') };
}

/**
 * A Coin adjustment executed the only way the ledger accepts one: requested,
 * first-approved and then second-approved (which settles it) by two distinct
 * active SUPER_ADMINs. A positive delta mints UNCLASSIFIED value under a new
 * OPEN legacy review; a negative one consumes the user's lots.
 */
export async function executeTestAdjustment(targetUserId: string, delta: number, approvers?: Approvers) {
  const { first, second } = approvers ?? await makeApprovers();
  const requested = await requestCoinAdjustment(first.id, {
    targetUserId, caseId: `test-adjust-${randomUUID()}`, delta,
    rationale: 'Documented historical balance correction', supportingEvidence: ['case-evidence-test'],
  });
  await firstApproveCoinAdjustment(first.id, requested.approvalId);
  return executeCoinAdjustment(second.id, requested.approvalId);
}
