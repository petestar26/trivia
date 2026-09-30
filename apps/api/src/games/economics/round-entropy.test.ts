import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Crypto from 'node:crypto';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import {
  deriveBeaconSpinOutcome, QUICKNET_CHAIN_HASH, QUICKNET_CHAIN_INFO, QUICKNET_PROTOCOL,
  quicknetTargetForCutoff, verifyQuicknetBeacon,
} from './round-entropy.js';

const injected = vi.hoisted(() => ({ words: [] as number[], inputs: [] as string[] }));
// Only substitute digest words for the seven otherwise impractical rejection
// values. BLS validation and normal fixed vectors always use real cryptography.
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  return { ...original, createHash: (algorithm: string) => {
    const hash = original.createHash(algorithm);
    let isDraw = false;
    const wrapper = {
      update(data: string | Uint8Array, encoding?: BufferEncoding) {
        isDraw = typeof data === 'string' && data.startsWith('playqube:spin-win:quicknet-draw:v2\n');
        if (isDraw) injected.inputs.push(data as string);
        if (typeof data === 'string') hash.update(data, encoding ?? 'utf8');
        else hash.update(data);
        return wrapper;
      },
      digest(encoding?: 'hex') {
        if (isDraw && !encoding && injected.words.length) {
          const result = Buffer.alloc(32);
          result.writeUInt32BE(injected.words.shift()!);
          return result;
        }
        return encoding ? hash.digest(encoding) : hash.digest();
      },
    };
    return wrapper;
  } };
});

// Official mainnet response, retrieved from the chain-qualified historical
// endpoint /52db9ba.../public/1. Tests are offline and never fetch a relay.
const beacon = Object.freeze({
  round: 1,
  randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
  signature: 'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
});
const genesisMs = 1_692_803_367_000;
const cutoff = genesisMs - 6_001;
const roundId = 'spin-proof-v2:17';
const zeroSeed = '00'.repeat(32);
afterEach(() => { injected.words = []; injected.inputs = []; vi.restoreAllMocks(); });

describe('pinned future Quicknet provider', () => {
  it.each([
    [genesisMs - 6_001, 1, genesisMs],
    [genesisMs - 6_000, 2, genesisMs + 3_000],
    [genesisMs - 5_999, 2, genesisMs + 3_000],
    [genesisMs - 3_001, 2, genesisMs + 3_000],
    [genesisMs - 3_000, 3, genesisMs + 6_000],
    [genesisMs, 4, genesisMs + 9_000],
  ])('selects the first beacon strictly after cutoff + offset at %i', (cutoffMs, target, timeMs) => {
    const selected = quicknetTargetForCutoff(new Date(cutoffMs));
    expect(selected).toEqual({ cutoffMs, beaconRound: target, beaconTimeMs: timeMs });
    expect(selected.beaconTimeMs).toBeGreaterThan(cutoffMs + 6_000);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 100])(
    'rejects invalid or overflowing cutoff %s', (value) => {
      expect(() => quicknetTargetForCutoff(value)).toThrow(/safe integer/);
    },
  );

  it('verifies a real signed beacon offline and freezes proof metadata', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Verifier must remain offline');
    });
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    expect(verified).toEqual({
      cutoffMs: cutoff, beaconRound: 1, beaconTimeMs: genesisMs,
      protocol: QUICKNET_PROTOCOL, chainHash: QUICKNET_CHAIN_HASH,
      signatureHex: beacon.signature, randomnessHex: beacon.randomness,
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(QUICKNET_CHAIN_INFO)).toBe(true);
    expect(Object.isFrozen(QUICKNET_CHAIN_INFO.metadata)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    null, [], 'beacon', {},
    { ...beacon, round: 0 }, { ...beacon, round: 1.5 },
    { ...beacon, round: Number.MAX_SAFE_INTEGER + 1 },
    { ...beacon, round: '1' }, { ...beacon, round: 2 },
    { ...beacon, signature: '00'.repeat(47) },
    { ...beacon, signature: beacon.signature.toUpperCase() },
    { ...beacon, randomness: 'ff'.repeat(31) },
    { ...beacon, randomness: beacon.randomness.toUpperCase() },
    { ...beacon, previous_signature: undefined },
    { ...beacon, previous_signature: '00'.repeat(48) },
  ])('rejects malformed or non-target beacon %j', async (raw) => {
    await expect(verifyQuicknetBeacon(cutoff, raw)).rejects.toThrow();
  });

  it('rejects accessor fields without invoking them', async () => {
    const get = vi.fn(() => beacon.signature);
    const raw = { ...beacon };
    Object.defineProperty(raw, 'signature', { get });
    await expect(verifyQuicknetBeacon(cutoff, raw)).rejects.toThrow('own data fields');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects changed randomness and malformed curve points with no fallback', async () => {
    await expect(verifyQuicknetBeacon(cutoff, { ...beacon, randomness: '00'.repeat(32) })).rejects.toThrow();
    await expect(verifyQuicknetBeacon(cutoff, { ...beacon, signature: '00'.repeat(48) })).rejects.toThrow();
  });

  it('rejects a signature whose bytes and randomness agree but whose BLS proof is wrong', async () => {
    const signature = 'b4' + beacon.signature.slice(2);
    const randomness = (await import('node:crypto')).createHash('sha256')
      .update(Buffer.from(signature, 'hex')).digest('hex');
    await expect(verifyQuicknetBeacon(cutoff, { ...beacon, signature, randomness })).rejects.toThrow();
  });

  it('cannot reuse a valid beacon for a later canonical cutoff', async () => {
    await expect(verifyQuicknetBeacon(genesisMs - 6_000, beacon)).rejects.toThrow('pinned target round');
  });
});

describe('Spin outcome using verified external entropy', () => {
  it.each([
    [zeroSeed, 19], ['ff'.repeat(32), 16],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 30],
  ])('matches independently calculated draw for seed %s', async (seed, expected) => {
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    expect(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, seed as string, verified)).toBe(expected);
    expect(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, seed as string, verified)).toBe(expected);
  });

  it('requires freshly verified proof instead of trusting a copied persisted flag', async () => {
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    expect(() => deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, { ...verified }))
      .toThrow('cryptographically verified');
    const restored = await verifyQuicknetBeacon(cutoff, {
      round: verified.beaconRound, signature: verified.signatureHex, randomness: verified.randomnessHex,
    });
    expect(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, restored))
      .toBe(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, verified));
  });

  it('binds the draw frame to immutable round, rules and seed terms', async () => {
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    for (const seed of ['', '0'.repeat(63), 'G'.repeat(64), 'AA'.repeat(32)]) {
      expect(() => deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, seed, verified)).toThrow('32 bytes');
    }
    expect(() => deriveBeaconSpinOutcome('round\ninjected', SPIN90_RULES_ID, zeroSeed, verified)).toThrow('Round ID');
    expect(() => deriveBeaconSpinOutcome(roundId, 'rules\ninjected', zeroSeed, verified)).toThrow('Rules ID');
    deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, verified);
    expect(injected.inputs.at(-1)).toBe([
      'playqube:spin-win:quicknet-draw:v2', roundId, SPIN90_RULES_ID, zeroSeed,
      QUICKNET_CHAIN_HASH, '1', beacon.randomness, '0',
    ].join('\n'));
  });

  it('rejects all seven biased uint32 words and accepts the last unbiased one', async () => {
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    injected.words = [4_294_967_288];
    expect(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, verified)).toBe(36);
    injected.inputs = [];
    injected.words = [4_294_967_289, 4_294_967_290, 4_294_967_291, 4_294_967_292,
      4_294_967_293, 4_294_967_294, 4_294_967_295, 1_234_567_890];
    expect(deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, verified)).toBe(1_234_567_890 % 37);
    expect(injected.inputs.map((input) => input.split('\n').at(-1))).toEqual(['0','1','2','3','4','5','6','7']);
  });

  it('fails closed at 128 attempts without switching entropy', async () => {
    const verified = await verifyQuicknetBeacon(cutoff, beacon);
    injected.words = Array(128).fill(4_294_967_295);
    expect(() => deriveBeaconSpinOutcome(roundId, SPIN90_RULES_ID, zeroSeed, verified)).toThrow('exhausted its bound');
    expect(injected.inputs).toHaveLength(128);
  });
});
