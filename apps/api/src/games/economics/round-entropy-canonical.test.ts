import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChainClient } from 'drand-client';
import type * as Drand from 'drand-client';
import { verifyQuicknetBeacon, QUICKNET_CHAIN_INFO } from './round-entropy.js';

const injected = vi.hoisted(() => ({ publicKey: '', calls: 0 }));
vi.mock('drand-client', async (importOriginal) => {
  const original = await importOriginal<typeof Drand>();
  return { ...original, fetchBeacon: async (client: ChainClient, round: number) => {
    injected.calls++;
    if (!injected.publicKey) return original.fetchBeacon(client, round);
    const chain = client.chain();
    const info = { ...await chain.info(), public_key: injected.publicKey };
    return original.fetchBeacon({ ...client,
      options: { ...client.options, chainVerificationParams: {
        chainHash: info.hash, publicKey: info.public_key,
      } },
      chain: () => ({ ...chain, info: async () => info }),
    }, round);
  } };
});

// Offline synthetic key (scalar 10), same RFC9380 scheme and round-1 message.
// Only the test adapter substitutes the public key; pairing verification is real.
const publicKey = 'afb665f5a7559cb0fa1300048a0e6f1ab5547226e86f8e752dd13c28eda4168492e3d3bf2f8a6b230dd57f79b1afa9911796abe0d9e4a703962be528e6a5cb65c60725886f925db0e2a89107ec248bb39fa332bc63bd91d28ae66e0dfce8f754';
const canonical = 'a2730a00f7e4b23cdb8d28f83445e98db3f6680d2fb00c7ca21cdbb60cbfe66d4f47ded6bd882311aaa7d51c8c8af95e';
const alternate = 'bc741beb316498d726a8d0ae77919665186db39223351f3c094dae570370dc916df3ded56edc231164a6d51c8c8aa409';
const modulus = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
const cutoff = 1_692_803_367_000 - 6_001;
const proof = (signature: string) => ({ round: 1, signature,
  randomness: createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex') });
afterEach(() => { injected.publicKey = ''; injected.calls = 0; });

describe('canonical compressed Quicknet signature boundary', () => {
  it('rejects the alternate encoding despite real library verification accepting both', async () => {
    const { fetchBeacon } = await vi.importActual<typeof Drand>('drand-client');
    for (const signature of [canonical, alternate]) {
      const beacon = proof(signature);
      await expect(fetchBeacon({
        options: { disableBeaconVerification: false, noCache: true },
        get: async () => beacon, latest: async () => beacon,
        chain: () => ({ baseUrl: 'offline:synthetic', info: async () => ({ ...QUICKNET_CHAIN_INFO, public_key: publicKey }) }),
      }, 1)).resolves.toEqual(beacon);
    }
    expect(proof(canonical).randomness).not.toBe(proof(alternate).randomness);
    injected.publicKey = publicKey;
    await expect(verifyQuicknetBeacon(cutoff, proof(canonical))).resolves.toMatchObject({ signatureHex: canonical });
    injected.calls = 0;
    await expect(verifyQuicknetBeacon(cutoff, proof(alternate))).rejects.toThrow('canonical compressed');
    expect(injected.calls).toBe(0);
  });

  it.each([modulus, modulus + 1n, (1n << 381n) - 1n])('rejects x >= field modulus (%s) before pairing', async (x) => {
    const signature = ((1n << 383n) | x).toString(16).padStart(96, '0');
    await expect(verifyQuicknetBeacon(cutoff, proof(signature))).rejects.toThrow('canonical compressed');
    expect(injected.calls).toBe(0);
  });

  it.each([0x00, 0x20, 0x40, 0x60, 0xc0, 0xe0])('rejects invalid compression/infinity flags %i before pairing', async (flags) => {
    const signature = (flags | 2).toString(16).padStart(2, '0') + canonical.slice(2);
    await expect(verifyQuicknetBeacon(cutoff, proof(signature))).rejects.toThrow('canonical compressed');
    expect(injected.calls).toBe(0);
  });
});
