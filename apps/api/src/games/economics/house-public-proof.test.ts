import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  QUICKNET_CHAIN_HASH,
  QUICKNET_PROTOCOL,
  SPIN90_RULES_ID,
  spinSeedCommitmentFrame,
} from '@socialplay/shared';

// Real mainnet round 1. No mocked BLS, signature, randomness or draw hashes.
const beacon = {
  round: 1,
  randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
  signature:
    'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
};
const fixture = () => ({
  stage: 'DRAWN',
  commitment: {
    roundId: 'spin-proof-v2:17',
    rulesId: SPIN90_RULES_ID,
    protocol: QUICKNET_PROTOCOL,
    chainHash: QUICKNET_CHAIN_HASH,
    opensAtMs: 1692803356999,
    closesAtMs: 1692803360999,
    pinnedAtMs: 1692803357099,
    preparedAtMs: 1692803357199,
    seedCommitment: '6b694235aef3515fe96b6d9a374a3341760db211ccf59d8eca266821dd3c8882',
    beaconRound: 1,
    beaconTimeMs: 1692803367000,
  },
  reveal: {
    seedHex: '00'.repeat(32),
    outcome: 19,
    drawnAtMs: 1692803367001,
    beacon: { ...beacon },
  },
});
type Projection = ReturnType<typeof fixture>;
async function setup() {
  const entropy = await import('./round-entropy.js');
  const verify = vi.spyOn(entropy, 'verifyQuicknetBeacon');
  const service = await import('./house-public-proof.js');
  const projection = fixture();
  const query = vi.fn(async () => [{ proof: structuredClone(projection) }]);
  const client = { $queryRaw: query } as unknown as Pick<PrismaClient, '$queryRaw'>;
  return {
    verify,
    query,
    read: () => service.readPublicSpinProof(client, projection.commitment.roundId),
    change: (edit: (proof: Projection) => void) => {
      edit(projection);
    },
  };
}
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('public proof beacon memoization', () => {
  it('coalesces concurrent and repeated reads, while querying the current projection every time', async () => {
    const s = await setup();
    const reads = await Promise.all(Array.from({ length: 8 }, () => s.read()));
    expect(reads.every((proof) => proof?.reveal?.outcome === 19)).toBe(true);
    await expect(s.read()).resolves.toMatchObject({ reveal: { outcome: 19 } });
    expect(s.query).toHaveBeenCalledTimes(9);
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'seed',
      (p: Projection) => {
        p.reveal.seedHex = 'ff'.repeat(32);
      },
    ],
    [
      'outcome',
      (p: Projection) => {
        p.reveal.outcome = 20;
      },
    ],
    [
      'protocol',
      (p: Projection) => {
        p.commitment.protocol = 'unexpected' as typeof QUICKNET_PROTOCOL;
      },
    ],
    [
      'chain',
      (p: Projection) => {
        p.commitment.chainHash = '00'.repeat(32) as typeof QUICKNET_CHAIN_HASH;
      },
    ],
    [
      'target',
      (p: Projection) => {
        p.commitment.beaconRound = 2;
      },
    ],
    [
      'timing',
      (p: Projection) => {
        p.commitment.preparedAtMs = p.commitment.beaconTimeMs;
      },
    ],
  ] as const)('does not hide a changed %s behind a valid cached beacon', async (_name, edit) => {
    const s = await setup();
    await s.read();
    s.change(edit);
    await expect(s.read()).rejects.toThrow('Public round proof is unavailable');
    expect(s.query).toHaveBeenCalledTimes(2);
    expect(s.verify).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'randomness',
      (p: Projection) => {
        p.reveal.beacon.randomness = '00'.repeat(32);
      },
    ],
    [
      'signature',
      (p: Projection) => {
        p.reveal.beacon.signature = 'b4' + p.reveal.beacon.signature.slice(2);
        p.reveal.beacon.randomness = createHash('sha256')
          .update(Buffer.from(p.reveal.beacon.signature, 'hex'))
          .digest('hex');
      },
    ],
  ] as const)(
    're-verifies changed %s and never caches a failed verification',
    async (_name, edit) => {
      const s = await setup();
      await s.read();
      s.change(edit);
      await expect(s.read()).rejects.toThrow('Public round proof is unavailable');
      await expect(s.read()).rejects.toThrow('Public round proof is unavailable');
      expect(s.verify).toHaveBeenCalledTimes(3);
    }
  );

  it('rechecks a changed cutoff even when it selects the same signed beacon round', async () => {
    const s = await setup();
    await s.read();
    s.change((p) => {
      p.commitment.closesAtMs -= 1;
    });
    await expect(s.read()).resolves.toMatchObject({ reveal: { outcome: 19 } });
    expect(s.verify).toHaveBeenCalledTimes(2);
  });

  it('recomputes the seed commitment and draw rather than returning an earlier database response', async () => {
    const s = await setup();
    await s.read();
    s.change((p) => {
      p.reveal.seedHex = 'ff'.repeat(32);
      p.commitment.seedCommitment = createHash('sha256')
        .update(
          spinSeedCommitmentFrame(p.commitment.roundId, p.commitment.rulesId, p.reveal.seedHex)
        )
        .digest('hex');
    });
    await expect(s.read()).rejects.toThrow('Public round proof is unavailable');
    s.change((p) => {
      p.reveal.outcome = 16;
    });
    await expect(s.read()).resolves.toMatchObject({ reveal: { outcome: 16 } });
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(s.query).toHaveBeenCalledTimes(3);
  });

  it('expires successful verifications at the configured lifetime', async () => {
    const entropy = await import('./round-entropy.js');
    const verify = vi.spyOn(entropy, 'verifyQuicknetBeacon');
    const { PublicProofBeaconCache } = await import('./public-proof-beacon-cache.js');
    let now = 0;
    const cache = new PublicProofBeaconCache(2, 10, () => now);
    const first = await cache.verify(1692803360999, beacon);
    now = 9;
    expect(await cache.verify(1692803360999, beacon)).toBe(first);
    now = 10;
    expect(await cache.verify(1692803360999, beacon)).not.toBe(first);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used verification when its bound is reached', async () => {
    const entropy = await import('./round-entropy.js');
    const verify = vi.spyOn(entropy, 'verifyQuicknetBeacon');
    const { PublicProofBeaconCache } = await import('./public-proof-beacon-cache.js');
    const cache = new PublicProofBeaconCache(2);
    const first = await cache.verify(1692803360999, beacon);
    const second = await cache.verify(1692803360998, beacon);
    expect(await cache.verify(1692803360999, beacon)).toBe(first);
    await cache.verify(1692803360997, beacon);
    expect(await cache.verify(1692803360999, beacon)).toBe(first);
    expect(await cache.verify(1692803360998, beacon)).not.toBe(second);
    expect(verify).toHaveBeenCalledTimes(4);
  });
});
