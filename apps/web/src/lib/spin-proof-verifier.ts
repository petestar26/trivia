import { fetchBeacon } from 'drand-client';
import type { ChainClient } from 'drand-client';
import {
  parseSpinPublicProof,
  QUICKNET_CHAIN_HASH,
  QUICKNET_CHAIN_INFO,
  spinPublicCommitmentFrame,
  spinSeedCommitmentFrame,
  spinBeaconDrawFrame,
} from '@socialplay/shared';
import type { SpinPublicProof } from '@socialplay/shared';

export const MAX_PUBLIC_PROOF_BYTES = 32_768;
export class SpinProofCryptoUnavailable extends Error {
  constructor() {
    super('This browser requires a secure connection for verification');
  }
}
export function parsePublicProofText(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_PUBLIC_PROOF_BYTES)
    throw new Error('Proof JSON exceeds the 32 KiB limit');
  return JSON.parse(text);
}
async function digest(text: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) throw new SpinProofCryptoUnavailable();
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function hexDigest(text: string) {
  return Array.from(await digest(text), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function validatedReceipt(raw: unknown) {
  const proof = parseSpinPublicProof(raw);
  if ((await hexDigest(spinPublicCommitmentFrame(proof.commitment))) !== proof.commitmentHash)
    throw new Error('Commitment receipt hash does not match its terms');
  return proof;
}
export interface PublicSpinVerification {
  status: 'COMMITMENT_ONLY' | 'VERIFIED';
  proof: SpinPublicProof;
  matchedSavedReceipt: boolean;
  computedOutcome: number | null;
}

/** Offline verification using the shipped protocol pins, never relay metadata.
 * Receipt matching proves consistency, not independently witnessed timing.
 */
export async function verifyPublicSpinProof(
  raw: unknown,
  savedReceipt?: unknown
): Promise<PublicSpinVerification> {
  const proof = await validatedReceipt(raw);
  let matchedSavedReceipt = false;
  if (savedReceipt !== undefined) {
    const saved = await validatedReceipt(savedReceipt);
    if (saved.stage !== 'PENDING')
      throw new Error('Saved commitment must be a pending-round receipt');
    if (saved.commitmentHash !== proof.commitmentHash)
      throw new Error('Proof differs from the saved commitment receipt');
    matchedSavedReceipt = true;
  }
  if (!proof.reveal)
    return { status: 'COMMITMENT_ONLY', proof, matchedSavedReceipt, computedOutcome: null };
  const c = proof.commitment,
    r = proof.reveal;
  if (
    (await hexDigest(spinSeedCommitmentFrame(c.roundId, c.rulesId, r.seedHex))) !== c.seedCommitment
  )
    throw new Error('Revealed seed does not match the commitment');
  const client: ChainClient = {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: QUICKNET_CHAIN_HASH,
        publicKey: QUICKNET_CHAIN_INFO.public_key,
      },
    },
    latest: async () => {
      throw new Error('Latest beacon is forbidden');
    },
    get: async (round) => {
      if (round !== c.beaconRound) throw new Error('Beacon target cannot change');
      return r.beacon;
    },
    chain: () => ({ baseUrl: 'offline:public-spin-proof', info: async () => QUICKNET_CHAIN_INFO }),
  };
  await fetchBeacon(client, c.beaconRound);
  for (let counter = 0; counter < 128; counter++) {
    const bytes = await digest(spinBeaconDrawFrame(c, r.seedHex, r.beacon.randomness, counter));
    const word = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    if (word >= 4_294_967_289) continue;
    const computedOutcome = word % 37;
    if (computedOutcome !== r.outcome)
      throw new Error('Published outcome does not match the verified draw');
    return { status: 'VERIFIED', proof, matchedSavedReceipt, computedOutcome };
  }
  throw new Error('Draw exceeded its sampling bound');
}
