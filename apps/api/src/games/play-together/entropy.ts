import {
  quicknetTargetForCutoff,
  QUICKNET_CHAIN_HASH,
  type TogetherProof,
} from '@socialplay/shared';
import { verifyQuicknetBeacon } from '../economics/round-entropy.js';

export async function fetchTogetherBeacon(closesAt: number): Promise<TogetherProof['beacon']> {
  const target = quicknetTargetForCutoff(closesAt);
  if (Date.now() < target.beaconTimeMs) throw new Error('Beacon is not due yet');
  let last: unknown;
  // Fetch the pinned round. An outage never permits a substitute draw.
  for (const base of ['https://api.drand.sh', 'https://api2.drand.sh']) {
    try {
      const response = await fetch(
        base + '/' + QUICKNET_CHAIN_HASH + '/public/' + target.beaconRound,
        { signal: AbortSignal.timeout(4000), redirect: 'error' }
      );
      if (!response.ok) throw new Error('Randomness service unavailable');
      const verified = await verifyQuicknetBeacon(closesAt, await response.json());
      return {
        round: verified.beaconRound,
        signature: verified.signatureHex,
        randomness: verified.randomnessHex,
      };
    } catch (error) {
      last = error;
    }
  }
  throw last ?? new Error('Randomness service unavailable');
}
