import { createHash } from 'node:crypto';
import { fetchBeacon } from 'drand-client';
import type { ChainClient, ChainInfo, RandomnessBeacon } from 'drand-client';
import { identifier } from './money.js';

/** Versioned provider contract. Historical seed-only draws remain unchanged. */
export const QUICKNET_PROTOCOL = 'sha256-quicknet-rejection-u32be-v2';
export const QUICKNET_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const QUICKNET_SAFETY_OFFSET_MS = 6_000;
// Pins match drand-client v1.4.2, commit ef8c9260294f8699b5e8c27a6b764f8f0d768bea,
// lib/defaults.ts. Never replace these with relay-supplied /info metadata.
export const QUICKNET_CHAIN_INFO: Readonly<ChainInfo> = Object.freeze({
  public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
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

export interface VerifiedQuicknetBeacon extends QuicknetTarget {
  readonly protocol: typeof QUICKNET_PROTOCOL;
  readonly chainHash: typeof QUICKNET_CHAIN_HASH;
  readonly signatureHex: string;
  readonly randomnessHex: string;
}

// Persistence is deliberately not a trust boundary: deserialized proof records
// must be verified again before sampling. A claimed "verified" flag is not proof.
const verifiedBeacons = new WeakSet<object>();
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
  return Object.freeze({ cutoffMs, beaconRound: Number(beaconRound), beaconTimeMs: Number(beaconTimeMs) });
}

// BLS12-381 compressed G1: C=1, I=0, either sign, and canonical Fp x.
// https://docs.rs/bls12_381/latest/bls12_381/notes/serialization/index.html
// Reject rather than normalize: drand randomness hashes the exact wire bytes.
const BLS12_381_FIELD_MODULUS = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const COMPRESSED_G1_X_MASK = (1n << 381n) - 1n;

function parseBeacon(raw: unknown, expectedRound: number): RandomnessBeacon {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RangeError('Quicknet beacon must be an object');
  }
  const value = raw as Record<string, unknown>;
  const fields = ['round', 'signature', 'randomness'].map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (fields.some((field) => !field || !('value' in field))) {
    throw new RangeError('Quicknet beacon requires ordinary own data fields');
  }
  const [round, signature, randomness] = fields.map((field) => field!.value as unknown);
  if (!Number.isSafeInteger(round) || (round as number) < 1) {
    throw new RangeError('Quicknet beacon round must be a positive safe integer');
  }
  if (round !== expectedRound) throw new RangeError('Quicknet beacon is not the pinned target round');
  if (typeof signature !== 'string' || !/^[0-9a-f]{96}$/.test(signature)) {
    throw new RangeError('Quicknet signature must be 48 bytes of lowercase hexadecimal');
  }
  const flags = Number.parseInt(signature.slice(0, 2), 16);
  const x = BigInt(`0x${signature}`) & COMPRESSED_G1_X_MASK;
  if ((flags & 0xc0) !== 0x80 || x >= BLS12_381_FIELD_MODULUS) {
    throw new RangeError('Quicknet signature requires canonical compressed non-infinity G1 encoding');
  }
  if (typeof randomness !== 'string' || !/^[0-9a-f]{64}$/.test(randomness)) {
    throw new RangeError('Quicknet randomness must be 32 bytes of lowercase hexadecimal');
  }
  if ('previous_signature' in value) throw new RangeError('Quicknet requires an unchained beacon');
  // Copy only the canonical fields; neither getters nor later caller mutation
  // can change the values observed by the asynchronous cryptographic verifier.
  return Object.freeze({ round: expectedRound, signature, randomness });
}

/** Offline BLS verification through drand's public API; no network or clock read.
 * The caller supplies a response for the immutable target, not a chosen round.
 * HTTP outage never authorizes switching beacon, chain or entropy algorithm.
 */
export async function verifyQuicknetBeacon(
  cutoff: Date | number, raw: unknown,
): Promise<Readonly<VerifiedQuicknetBeacon>> {
  const target = quicknetTargetForCutoff(cutoff);
  const beacon = parseBeacon(raw, target.beaconRound);
  const client: ChainClient = {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: QUICKNET_CHAIN_HASH, publicKey: QUICKNET_CHAIN_INFO.public_key,
      },
    },
    latest: async () => { throw new Error('Latest-beacon selection is forbidden'); },
    get: async (round) => {
      if (round !== target.beaconRound) throw new Error('Beacon target cannot change');
      return beacon;
    },
    chain: () => ({ baseUrl: 'offline:pinned-quicknet', info: async () => QUICKNET_CHAIN_INFO }),
  };
  await fetchBeacon(client, target.beaconRound);
  const result: Readonly<VerifiedQuicknetBeacon> = Object.freeze({
    ...target,
    protocol: QUICKNET_PROTOCOL,
    chainHash: QUICKNET_CHAIN_HASH,
    signatureHex: beacon.signature,
    randomnessHex: beacon.randomness,
  });
  verifiedBeacons.add(result);
  return result;
}

const DRAW_DOMAIN = 'playqube:spin-win:quicknet-draw:v2';
const ACCEPT_BELOW = 4_294_967_289;
const MAX_DRAW_ATTEMPTS = 128;

/** Spin adapter only; provider verification and target selection are reusable.
 * The seed must have been committed before admission by the integration layer.
 * No stake, bankroll, ticket or mutable financial state enters the draw.
 */
export function deriveBeaconSpinOutcome(
  roundId: string, rulesId: string, seedHex: string, verified: VerifiedQuicknetBeacon,
): number {
  identifier(roundId, 'Round ID');
  identifier(rulesId, 'Rules ID');
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new RangeError('Spin seed must be 32 bytes of lowercase hexadecimal');
  }
  if (verified === null || typeof verified !== 'object' || !verifiedBeacons.has(verified)) {
    throw new RangeError('Spin draw requires a cryptographically verified Quicknet beacon');
  }
  for (let counter = 0; counter < MAX_DRAW_ATTEMPTS; counter++) {
    const digest = createHash('sha256').update(
      `${DRAW_DOMAIN}\n${roundId}\n${rulesId}\n${seedHex}\n${verified.chainHash}\n${verified.beaconRound}\n${verified.randomnessHex}\n${counter}`,
      'utf8',
    ).digest();
    const word = digest.readUInt32BE(0);
    if (word < ACCEPT_BELOW) return word % 37;
  }
  throw new Error('Quicknet Spin sampling exhausted its bound');
}
