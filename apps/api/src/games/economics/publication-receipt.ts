import { createHash } from 'node:crypto';
import {
  decodePublicationDer,
  MAX_PUBLICATION_QUERY_BYTES,
  MAX_PUBLICATION_REPLY_BYTES,
  parsePublicPublicationArchive,
  spinPublicCommitmentFrame,
} from '@socialplay/shared';
import { PUBLICATION_AUTHORITIES } from './publication-authorities.js';
import type { PublicationAuthority } from './publication-authorities.js';
import {
  publicationAuthorityIdentity,
  PublicationWitnessUnavailable,
  verifyPublicationWitness,
} from './publication-witness.js';
import { inspectTimestampRequest } from './rfc3161-codec.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Portable, offline verification with an independently saved expected hash.
 * No database, provider request, ambient CA, uploaded certificate or trust
 * selected by file metadata. A null receipt is never a verified timestamp. */
export async function verifyPortablePublicationArchive(
  raw: unknown,
  expectedCommitmentHash: string,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
) {
  try {
    if (
      typeof expectedCommitmentHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expectedCommitmentHash)
    )
      throw new Error();
    // Parse/snapshot inputs before awaiting cryptographic subprocesses.
    const archive = parsePublicPublicationArchive(raw);
    const trusted = roots.map((root) => Object.freeze({ ...root }));
    const identity = publicationAuthorityIdentity(archive.authority.authorityId, trusted);
    for (const key of [
      'authorityId',
      'rootCertificateSha256',
      'signerCertificateSha256',
      'policyOid',
      'maxAccuracyMs',
    ] as const)
      if (archive.authority[key] !== identity[key]) throw new Error();
    if (
      archive.proof.commitmentHash !== expectedCommitmentHash ||
      hash(spinPublicCommitmentFrame(archive.proof.commitment)) !== expectedCommitmentHash
    )
      throw new Error();
    const queryDer = Buffer.from(
      decodePublicationDer(archive.request.derBase64, MAX_PUBLICATION_QUERY_BYTES)
    );
    const query = inspectTimestampRequest(queryDer);
    if (
      hash(queryDer) !== archive.request.sha256 ||
      query.hash !== expectedCommitmentHash ||
      query.nonce !== archive.request.nonceHex ||
      query.policy !== identity.policyOid
    )
      throw new Error();
    const summary = {
      roundId: archive.roundId,
      commitmentHash: expectedCommitmentHash,
      authorityId: identity.authorityId,
    };
    if (!archive.receipt)
      return {
        status: 'REQUEST_ONLY' as const,
        ...summary,
        observedFromMs: null,
        observedThroughMs: null,
      };
    const response = decodePublicationDer(archive.receipt.derBase64, MAX_PUBLICATION_REPLY_BYTES);
    const witness = await verifyPublicationWitness(
      archive.proof,
      { authorityId: identity.authorityId, commitmentHash: expectedCommitmentHash, queryDer },
      response,
      trusted
    );
    if (
      witness.responseSha256 !== archive.receipt.sha256 ||
      witness.serial !== archive.receipt.serialHex ||
      witness.observedFromMs !== archive.receipt.observedFromMs ||
      witness.observedThroughMs !== archive.receipt.observedThroughMs
    )
      throw new Error();
    return {
      status: 'VERIFIED_TIMESTAMP' as const,
      ...summary,
      observedFromMs: witness.observedFromMs,
      observedThroughMs: witness.observedThroughMs,
    };
  } catch {
    throw new PublicationWitnessUnavailable();
  }
}
