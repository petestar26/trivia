import { z } from 'zod';
import { SPIN90_RULES_ID } from './spin-win-90.js';

interface QuicknetChainInfo {
  public_key: string;
  period: number;
  genesis_time: number;
  hash: string;
  groupHash: string;
  schemeID: string;
  metadata: { beaconID: string };
}

/** Versioned provider contract. Historical seed-only draws remain unchanged. */
export const QUICKNET_PROTOCOL = 'sha256-quicknet-rejection-u32be-v2';
export const QUICKNET_CHAIN_HASH =
  '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const QUICKNET_SAFETY_OFFSET_MS = 6_000;
// Pins match drand-client v1.4.2, commit ef8c9260294f8699b5e8c27a6b764f8f0d768bea,
// lib/defaults.ts. Never replace these with relay-supplied /info metadata.
export const QUICKNET_CHAIN_INFO: Readonly<QuicknetChainInfo> = Object.freeze({
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1_692_803_367,
  hash: QUICKNET_CHAIN_HASH,
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: Object.freeze({ beaconID: 'quicknet' }),
});

export interface QuicknetTarget {
  readonly cutoffMs: number;
  readonly beaconRound: number;
  readonly beaconTimeMs: number;
}

const GENESIS_MS = BigInt(QUICKNET_CHAIN_INFO.genesis_time) * 1_000n;
const PERIOD_MS = BigInt(QUICKNET_CHAIN_INFO.period) * 1_000n;
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** First scheduled beacon strictly AFTER cutoff + six seconds, never latest.
 * drand's genesis timestamp is round ONE. Pin this result before admission.
 */
export function quicknetTargetForCutoff(cutoff: Date | number): Readonly<QuicknetTarget> {
  const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : cutoff;
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
    throw new RangeError('Entropy cutoff must be a nonnegative safe integer in epoch milliseconds');
  }
  const afterMs = BigInt(cutoffMs) + BigInt(QUICKNET_SAFETY_OFFSET_MS);
  const beaconRound = afterMs < GENESIS_MS ? 1n : (afterMs - GENESIS_MS) / PERIOD_MS + 2n;
  const beaconTimeMs = GENESIS_MS + (beaconRound - 1n) * PERIOD_MS;
  if (afterMs > SAFE_INTEGER || beaconRound > SAFE_INTEGER || beaconTimeMs > SAFE_INTEGER) {
    throw new RangeError('Entropy target exceeds the safe integer range');
  }
  return Object.freeze({
    cutoffMs,
    beaconRound: Number(beaconRound),
    beaconTimeMs: Number(beaconTimeMs),
  });
}

// BLS12-381 compressed G1: C=1, I=0, either sign, and canonical Fp x.
// https://docs.rs/bls12_381/latest/bls12_381/notes/serialization/index.html
// Reject rather than normalize: drand randomness hashes the exact wire bytes.
const BLS12_381_FIELD_MODULUS =
  0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const COMPRESSED_G1_X_MASK = (1n << 381n) - 1n;

export function requireCanonicalQuicknetSignature(signature: unknown): asserts signature is string {
  if (typeof signature !== 'string' || !/^[0-9a-f]{96}$/.test(signature)) {
    throw new RangeError('Quicknet signature must be 48 bytes of lowercase hexadecimal');
  }
  const flags = Number.parseInt(signature.slice(0, 2), 16);
  const x = BigInt(`0x${signature}`) & COMPRESSED_G1_X_MASK;
  if ((flags & 0xc0) !== 0x80 || x >= BLS12_381_FIELD_MODULUS) {
    throw new RangeError(
      'Quicknet signature requires canonical compressed non-infinity G1 encoding'
    );
  }
}

// Also fit JavaScript Date: the UI displays these values as ISO timestamps.
const epoch = z.number().int().nonnegative().max(8_640_000_000_000_000);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);
const commitmentSchema = z
  .object({
    roundId: identity,
    rulesId: z.literal(SPIN90_RULES_ID),
    protocol: z.literal(QUICKNET_PROTOCOL),
    chainHash: z.literal(QUICKNET_CHAIN_HASH),
    opensAtMs: epoch,
    closesAtMs: epoch,
    pinnedAtMs: epoch,
    preparedAtMs: epoch,
    seedCommitment: hex32,
    beaconRound: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    beaconTimeMs: epoch,
  })
  .strict();
const revealSchema = z
  .object({
    seedHex: hex32,
    outcome: z.number().int().min(0).max(36),
    drawnAtMs: epoch,
    beacon: z
      .object({
        round: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        signature: z.string().regex(/^[0-9a-f]{96}$/),
        randomness: hex32,
      })
      .strict(),
  })
  .strict();
const proofSchema = z
  .object({
    schema: z.literal('playqube-spin-proof-v1'),
    commitment: commitmentSchema,
    commitmentHash: hex32,
    stage: z.enum(['PENDING', 'DRAWN']),
    reveal: revealSchema.nullable(),
  })
  .strict();
export type SpinPublicCommitment = z.infer<typeof commitmentSchema>;
export type SpinPublicProof = z.infer<typeof proofSchema>;

export function parseSpinPublicProof(raw: unknown): SpinPublicProof {
  const proof = proofSchema.parse(raw);
  const c = proof.commitment;
  const target = quicknetTargetForCutoff(c.closesAtMs);
  if (
    c.opensAtMs >= c.closesAtMs ||
    c.pinnedAtMs < c.opensAtMs ||
    c.preparedAtMs < c.pinnedAtMs ||
    c.preparedAtMs >= c.closesAtMs ||
    target.beaconRound !== c.beaconRound ||
    target.beaconTimeMs !== c.beaconTimeMs ||
    (proof.stage === 'DRAWN') !== (proof.reveal !== null)
  ) {
    throw new Error('Invalid public commitment timing or stage');
  }
  if (proof.reveal) {
    if (proof.reveal.drawnAtMs < c.beaconTimeMs || proof.reveal.beacon.round !== c.beaconRound)
      throw new Error('Draw does not match the committed beacon target');
    requireCanonicalQuicknetSignature(proof.reveal.beacon.signature);
  }
  return proof;
}

/** Explicit ordered UTF-8 frame: no JSON key order or number formatting ambiguity. */
export function spinPublicCommitmentFrame(c: SpinPublicCommitment): string {
  return [
    'playqube:spin-win:public-commitment:v1',
    c.roundId,
    c.rulesId,
    c.protocol,
    c.chainHash,
    c.opensAtMs,
    c.closesAtMs,
    c.pinnedAtMs,
    c.preparedAtMs,
    c.seedCommitment,
    c.beaconRound,
    c.beaconTimeMs,
  ].join('\n');
}
export function spinSeedCommitmentFrame(roundId: string, rulesId: string, seedHex: string): string {
  return ['playqube:spin-win:commit:v1', roundId, rulesId, seedHex].join('\n');
}
export function spinBeaconDrawFrame(
  c: SpinPublicCommitment,
  seedHex: string,
  randomness: string,
  counter: number
): string {
  return [
    'playqube:spin-win:quicknet-draw:v2',
    c.roundId,
    c.rulesId,
    seedHex,
    c.chainHash,
    c.beaconRound,
    randomness,
    counter,
  ].join('\n');
}
