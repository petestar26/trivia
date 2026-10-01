import type { PrismaClient } from '@prisma/client';
import { PUBLICATION_AUTHORITIES } from './publication-authorities.js';
import type { PublicationAuthority } from './publication-authorities.js';
import {
  publicationAuthorityIdentity,
  PublicationWitnessUnavailable,
} from './publication-witness.js';
import {
  prepareDormantPublicationRequest,
  readPublicPublicationArchive,
  recordDormantPublicationReceipt,
  PublicationArchiveConflict,
} from './publication-store.js';
import type { PublicPublicationArchive } from './publication-store.js';
import {
  MAX_TIMESTAMP_HTTP_MS,
  postTimestampQuery,
  timestampSubmissionUrl,
  TimestampTransportUnavailable,
} from './publication-transport.js';
import { readPublicSpinProof } from './house-public-proof.js';

export interface TimestampSubmissionEndpoint {
  readonly authorityId: string;
  readonly url: string;
}

// Service usage, rate limits, independence and endpoint identity have not been
// approved. No production caller can submit using the default empty policy.
export const TIMESTAMP_SUBMISSION_ENDPOINTS: readonly TimestampSubmissionEndpoint[] = Object.freeze(
  []
);
const MAX_ATTEMPTS = 3;
const retryDelaysMs = [100, 250] as const;

/** Owner-run dormant orchestration, not registered with the API or worker.
 * Explicit policy exists for reviewed internal/test callers, not HTTP input.
 * Each attempt sends the originally persisted query. Network I/O never holds
 * the archive's transaction/round locks. Real CMS/TSA verification and commit
 * remain the existing owner-only importer; HTTP 200 alone proves nothing. */
export async function submitDormantPublication(
  owner: PrismaClient,
  roundId: string,
  authorityId: string,
  policy: {
    authorities: readonly PublicationAuthority[];
    endpoints: readonly TimestampSubmissionEndpoint[];
  } = { authorities: PUBLICATION_AUTHORITIES, endpoints: TIMESTAMP_SUBMISSION_ENDPOINTS }
): Promise<{ archive: PublicPublicationArchive; isReplay: boolean; attempts: number }> {
  // Snapshot reviewed source policy before any await. Database pins never
  // supply trust or an endpoint, and there is no environment fallback.
  const roots = policy.authorities.map((root) => Object.freeze({ ...root }));
  publicationAuthorityIdentity(authorityId, roots);
  const endpoints = policy.endpoints.filter((entry) => entry.authorityId === authorityId);
  if (endpoints.length !== 1) throw new PublicationWitnessUnavailable();
  const endpoint = timestampSubmissionUrl(endpoints[0].url).href;
  const prepared = await prepareDormantPublicationRequest(owner, roundId, authorityId, roots);
  const query = Buffer.from(prepared.archive.request.derBase64, 'base64');
  const stored = async () => {
    const archive = await readPublicPublicationArchive(owner, roundId, roots);
    if (
      !archive ||
      archive.authority.authorityId !== authorityId ||
      archive.request.sha256 !== prepared.archive.request.sha256
    )
      throw new PublicationWitnessUnavailable();
    return archive;
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await stored();
    if (existing.receipt) return { archive: existing, isReplay: true, attempts: attempt };
    const current = await readPublicSpinProof(owner, roundId);
    if (
      !current ||
      current.stage !== 'PENDING' ||
      current.commitmentHash !== prepared.archive.proof.commitmentHash
    )
      throw new PublicationWitnessUnavailable();
    const [clock] = await owner.$queryRaw<Array<{ now: bigint }>>`
      SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT AS now`;
    const remaining = BigInt(prepared.archive.proof.commitment.closesAtMs) - clock.now;
    if (remaining <= 0n) throw new PublicationWitnessUnavailable();
    let response: Buffer;
    try {
      response = await postTimestampQuery(
        endpoint,
        query,
        Number(
          remaining < BigInt(MAX_TIMESTAMP_HTTP_MS) ? remaining : BigInt(MAX_TIMESTAMP_HTTP_MS)
        )
      );
    } catch (error) {
      if (
        !(error instanceof TimestampTransportUnavailable) ||
        !error.retryable ||
        attempt + 1 === MAX_ATTEMPTS
      )
        throw new PublicationWitnessUnavailable();
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      continue;
    }
    try {
      const result = await recordDormantPublicationReceipt(owner, roundId, response, roots);
      return { ...result, attempts: attempt + 1 };
    } catch (error) {
      // Concurrent processes can obtain different valid TSA responses to one
      // identical query. Only the first verified commit wins; return its exact
      // reverified archive. Never overwrite it or retry a verification failure.
      if (error instanceof PublicationArchiveConflict) {
        const winner = await stored();
        if (winner.receipt) return { archive: winner, isReplay: true, attempts: attempt + 1 };
      }
      throw error;
    }
  }
  throw new PublicationWitnessUnavailable();
}
