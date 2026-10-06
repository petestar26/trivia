import { createHash } from 'node:crypto';
import { fetchBeacon } from 'drand-client';
import type { ChainClient, RandomnessBeacon } from 'drand-client';
import { identifier } from './money.js';
import { QUICKNET_PROTOCOL, QUICKNET_CHAIN_HASH, QUICKNET_CHAIN_INFO, quicknetTargetForCutoff, requireCanonicalQuicknetSignature } from '@socialplay/shared';
export { QUICKNET_PROTOCOL, QUICKNET_CHAIN_HASH, QUICKNET_CHAIN_INFO, QUICKNET_SAFETY_OFFSET_MS, quicknetTargetForCutoff } from '@socialplay/shared';

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
  requireCanonicalQuicknetSignature(signature);
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
