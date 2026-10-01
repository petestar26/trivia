import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { spinPublicCommitmentFrame } from '@socialplay/shared';
import { PUBLIC_PROOF } from '@/test/spin-public-proof-fixture';
import { parsePublicProofText, verifyPublicSpinProof } from './spin-proof-verifier';
const copy = () => structuredClone(PUBLIC_PROOF);
const pending = () => ({ ...copy(), stage: 'PENDING' as const, reveal: null });
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const resign = (proof: typeof PUBLIC_PROOF) => {
  proof.commitmentHash = createHash('sha256')
    .update(spinPublicCommitmentFrame(proof.commitment))
    .digest('hex');
  return proof;
};
describe('offline player proof verification', () => {
  it('reproduces a real signed round without fetching a relay or sending data', async () => {
    const fetch = vi.fn(() => {
      throw new Error('No network allowed');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(verifyPublicSpinProof(copy(), pending())).resolves.toMatchObject({
      status: 'VERIFIED',
      computedOutcome: 19,
      matchedSavedReceipt: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports a pending receipt as commitment-only, never a verified outcome', async () => {
    await expect(verifyPublicSpinProof(pending())).resolves.toMatchObject({
      status: 'COMMITMENT_ONLY',
      computedOutcome: null,
      matchedSavedReceipt: false,
    });
  });
  it('distinguishes verification without an earlier receipt', async () => {
    expect((await verifyPublicSpinProof(copy())).matchedSavedReceipt).toBe(false);
  });
  it('rejects a changed commitment even when its receipt hash is recomputed', async () => {
    const changed = copy();
    changed.commitment.roundId = 'changed:17';
    resign(changed);
    await expect(verifyPublicSpinProof(changed, pending())).rejects.toThrow('saved commitment');
  });
  it.each([
    'outcome',
    'seed',
    'randomness',
    'signature',
    'round',
    'chain',
    'protocol',
    'rules',
    'target',
    'timing',
    'hash',
    'extra',
  ])('rejects tampered %s', async (kind) => {
    const p = copy();
    if (kind === 'outcome') p.reveal!.outcome = 0;
    if (kind === 'seed') p.reveal!.seedHex = 'ff'.repeat(32);
    if (kind === 'randomness') p.reveal!.beacon.randomness = 'ff'.repeat(32);
    if (kind === 'signature') p.reveal!.beacon.signature = '00'.repeat(48);
    if (kind === 'round') p.reveal!.beacon.round = 2;
    if (kind === 'chain') (p.commitment as { chainHash: string }).chainHash = 'ff'.repeat(32);
    if (kind === 'protocol')
      (p.commitment as { protocol: string }).protocol = 'sha256-rejection-u32be-v1';
    if (kind === 'rules') (p.commitment as { rulesId: string }).rulesId = 'unknown';
    if (kind === 'target') p.commitment.beaconTimeMs++;
    if (kind === 'timing') p.commitment.preparedAtMs = p.commitment.closesAtMs;
    if (kind === 'hash') p.commitmentHash = 'ff'.repeat(32);
    if (kind === 'extra') Object.assign(p, { userId: 'private' });
    await expect(verifyPublicSpinProof(p)).rejects.toThrow();
  });
  it('rejects a revealed proof used as an allegedly earlier receipt', async () => {
    await expect(verifyPublicSpinProof(copy(), copy())).rejects.toThrow('pending-round');
  });
  it('enforces byte limits and rejects malformed JSON', () => {
    expect(() => parsePublicProofText(' '.repeat(32769))).toThrow('32 KiB');
    expect(() => parsePublicProofText('é'.repeat(16385))).toThrow('32 KiB');
    expect(() => parsePublicProofText('{')).toThrow();
  });
  it('fails closed if browser cryptography is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    await expect(verifyPublicSpinProof(copy())).rejects.toThrow('secure connection');
  });
  it('rejects timestamps outside the ISO-display domain before returning a result', async () => {
    const p = pending();
    p.commitment.closesAtMs = 8_640_000_000_000_001;
    await expect(verifyPublicSpinProof(p)).rejects.toThrow();
  });
});
