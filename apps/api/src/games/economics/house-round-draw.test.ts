import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Crypto from 'node:crypto';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { deriveSpinCommittedOutcome, spinSeedCommitment, verifySpinSeedCommitment } from './house-round-draw.js';

const injected = vi.hoisted(() => ({ words: [] as number[], inputs: [] as string[] }));
// The sole substitution is digest words for the otherwise unreachable seven
// rejection values. Normal vectors still use Node's real SHA256 implementation.
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  return { ...original, createHash: (algorithm: string) => {
    const hash = original.createHash(algorithm);
    const wrapper = {
      update(data: string, encoding: BufferEncoding) {
        injected.inputs.push(data);
        hash.update(data, encoding);
        return wrapper;
      },
      digest(encoding?: 'hex') {
        if (!encoding && injected.words.length) {
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

const roundId = 'spin-proof-v1:17';
const zeroSeed = '00'.repeat(32);
afterEach(() => { injected.words = []; injected.inputs = []; });

describe('committed dormant Spin randomness', () => {
  it.each([
    [zeroSeed, 'bc44567dc6313c4fb358139685852007179d7f18b68f97be5eb00ebaea0253ee', 10],
    ['ff'.repeat(32), 'e36d63cd2c3d23e94b19102a1261775971db613e81dbf31c011ac0d4d254cfbe', 3],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      'e9922e341efd204bcf8cf89cb37a4bbb5f77e58b5fd64260ccae9b995471b7cc', 2],
  ])('matches independently calculated commitment and draw for %s', (seed, commitment, outcome) => {
    expect(spinSeedCommitment(roundId, SPIN90_RULES_ID, seed as string)).toBe(commitment);
    expect(deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, seed as string)).toBe(outcome);
    expect(verifySpinSeedCommitment(roundId, SPIN90_RULES_ID, seed as string, commitment as string)).toBe(true);
  });

  it('binds the seed to one round and rejects altered or malformed reveal proofs', () => {
    const commitment = spinSeedCommitment(roundId, SPIN90_RULES_ID, zeroSeed);
    expect(verifySpinSeedCommitment(roundId + '8', SPIN90_RULES_ID, zeroSeed, commitment)).toBe(false);
    expect(verifySpinSeedCommitment(roundId, SPIN90_RULES_ID, '01' + zeroSeed.slice(2), commitment)).toBe(false);
    expect(verifySpinSeedCommitment(roundId, SPIN90_RULES_ID, zeroSeed, commitment.toUpperCase())).toBe(false);
    expect(verifySpinSeedCommitment(roundId, SPIN90_RULES_ID, zeroSeed, 'not-a-commitment')).toBe(false);
    expect(() => spinSeedCommitment('round\ninjected', SPIN90_RULES_ID, zeroSeed)).toThrow('Round ID');
    expect(() => spinSeedCommitment(roundId, 'unsupported', zeroSeed)).toThrow('Unsupported');
    for (const seed of ['', '0'.repeat(63), 'f'.repeat(65), 'GG'.repeat(32), 'AA'.repeat(32)]) {
      expect(() => deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, seed)).toThrow('32 bytes');
    }
  });

  it('accepts the last unbiased word but rejects all seven trailing uint32 words', () => {
    injected.words = [4_294_967_288];
    expect(deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, zeroSeed)).toBe(36);
    injected.inputs = [];
    injected.words = [4_294_967_289, 4_294_967_290, 4_294_967_291, 4_294_967_292,
      4_294_967_293, 4_294_967_294, 4_294_967_295, 1_234_567_890];
    expect(deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, zeroSeed)).toBe(1_234_567_890 % 37);
    expect(injected.inputs).toHaveLength(8);
    expect(injected.inputs.map((input) => input.split('\n').at(-1))).toEqual(['0','1','2','3','4','5','6','7']);
  });

  it('fails closed at the sampling bound without an outcome fallback', () => {
    injected.words = Array(128).fill(4_294_967_295);
    expect(() => deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, zeroSeed)).toThrow('exhausted its bound');
    expect(injected.inputs).toHaveLength(128);
  });

  it('replays the same seed proof without any mutable ticket or funding input', () => {
    const before = deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, zeroSeed);
    expect(deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, zeroSeed)).toBe(before);
    expect(injected.inputs.every((input) => !input.includes('commit:v1'))).toBe(true);
  });
});
