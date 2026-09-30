import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { parseSpinPublicProof, spinPublicCommitmentFrame } from '@socialplay/shared';
import type { SpinPublicCommitment, SpinPublicProof } from '@socialplay/shared';
import { verifyQuicknetBeacon, deriveBeaconSpinOutcome } from './round-entropy.js';
import { verifySpinSeedCommitment } from './house-round-draw.js';

export class PublicSpinProofUnavailable extends Error {}
export async function readPublicSpinProof(
  client: Pick<PrismaClient, '$queryRaw'>,
  roundId: string
): Promise<SpinPublicProof | null> {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(roundId)) return null;
  // Exactly one snapshot and a parameterized, read-only projection. No owner
  // connection, private seed SELECT, lazy creation, clock tick, or database write.
  const [row] = await client.$queryRaw<
    Array<{
      proof: {
        commitment: SpinPublicCommitment;
        stage: string;
        reveal: unknown;
      } | null;
    }>
  >`SELECT public.house_public_spin_proof(${roundId}) AS proof`;
  if (!row?.proof) return null;
  try {
    const raw = row.proof;
    const proof = parseSpinPublicProof({
      schema: 'playqube-spin-proof-v1',
      ...raw,
      commitmentHash: createHash('sha256')
        .update(spinPublicCommitmentFrame(raw.commitment), 'utf8')
        .digest('hex'),
    });
    if (proof.reveal) {
      const c = proof.commitment,
        r = proof.reveal;
      if (!verifySpinSeedCommitment(c.roundId, c.rulesId, r.seedHex, c.seedCommitment))
        throw new Error();
      const beacon = await verifyQuicknetBeacon(c.closesAtMs, r.beacon);
      if (deriveBeaconSpinOutcome(c.roundId, c.rulesId, r.seedHex, beacon) !== r.outcome)
        throw new Error();
    }
    return proof;
  } catch {
    throw new PublicSpinProofUnavailable('Public round proof is unavailable');
  }
}
