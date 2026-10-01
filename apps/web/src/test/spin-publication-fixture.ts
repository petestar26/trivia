import { createHash } from 'node:crypto';
import type { PublicPublicationArchive } from '@socialplay/shared';
import { PUBLIC_PROOF } from './spin-public-proof-fixture';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
// Intentionally NOT a TSA token. Browser checks hashes, never timestamp signatures.
export const PUBLICATION_ARCHIVE: PublicPublicationArchive = {
  schema: 'playqube-spin-publication-v1',
  roundId: PUBLIC_PROOF.commitment.roundId,
  proof: { ...PUBLIC_PROOF, stage: 'PENDING', reveal: null },
  authority: {
    authorityId: 'test-not-trusted',
    rootCertificateSha256: 'a'.repeat(64),
    signerCertificateSha256: 'b'.repeat(64),
    policyOid: '1.2.3',
    maxAccuracyMs: 10,
  },
  request: { derBase64: 'AA==', sha256: hash(new Uint8Array([0])), nonceHex: '1' },
  receipt: {
    derBase64: 'AQ==',
    sha256: hash(new Uint8Array([1])),
    serialHex: '1',
    observedFromMs: PUBLIC_PROOF.commitment.preparedAtMs + 100,
    observedThroughMs: PUBLIC_PROOF.commitment.preparedAtMs + 102,
  },
};
