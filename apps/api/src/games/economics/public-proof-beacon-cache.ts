import { QUICKNET_CHAIN_HASH, QUICKNET_CHAIN_INFO, QUICKNET_PROTOCOL } from '@socialplay/shared';
import type { SpinPublicProof } from '@socialplay/shared';
import { verifyQuicknetBeacon } from './round-entropy.js';
import type { VerifiedQuicknetBeacon } from './round-entropy.js';

type Beacon = NonNullable<SpinPublicProof['reveal']>['beacon'];
type Entry = { expiresAt: number; verified: Promise<Readonly<VerifiedQuicknetBeacon>> };

/** Cache only a real cryptographic verification, never a database proof or draw.
 * Keys include the complete verifier input and protocol pins. Callers must still
 * validate the current receipt, seed commitment, timing and derived outcome.
 */
export class PublicProofBeaconCache {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 300_000,
    private readonly now: () => number = () => performance.now()
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1
    )
      throw new RangeError('Public beacon cache requires positive integer limits');
  }

  verify(cutoffMs: number, beacon: Beacon): Promise<Readonly<VerifiedQuicknetBeacon>> {
    const key = JSON.stringify([
      QUICKNET_PROTOCOL,
      QUICKNET_CHAIN_HASH,
      QUICKNET_CHAIN_INFO.public_key,
      cutoffMs,
      beacon.round,
      beacon.signature,
      beacon.randomness,
    ]);
    const time = this.now();
    // Remove expired entries even when the requested key has never been seen.
    for (const [storedKey, entry] of this.entries)
      if (entry.expiresAt <= time) this.entries.delete(storedKey);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.verified;
    }
    while (this.entries.size >= this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
    const entry: Entry = {
      expiresAt: time + this.ttlMs,
      verified: verifyQuicknetBeacon(cutoffMs, beacon),
    };
    // Share in-flight work. A failure is never retained; an evicted old request
    // must not remove a replacement entry when its rejection arrives later.
    entry.verified = entry.verified.catch((cause: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw cause;
    });
    this.entries.set(key, entry);
    return entry.verified;
  }
}
