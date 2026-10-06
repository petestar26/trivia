import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { parseSpinPublicProof, spinPublicCommitmentFrame } from '@socialplay/shared';
import type { PublicPublicationArchive } from '@socialplay/shared';
export type { PublicPublicationArchive } from '@socialplay/shared';
import { PUBLICATION_AUTHORITIES } from './publication-authorities.js';
import type { PublicationAuthority } from './publication-authorities.js';
import { readPublicSpinProof } from './house-public-proof.js';
import { inspectTimestampRequest } from './rfc3161-codec.js';
import {
  createPublicationRequest,
  MAX_TIMESTAMP_REQUEST_BYTES,
  MAX_TIMESTAMP_RESPONSE_BYTES,
  publicationAuthorityIdentity,
  PublicationWitnessUnavailable,
  verifyPublicationWitness,
} from './publication-witness.js';
import type { PublicationRequest } from './publication-witness.js';

type Reader = Pick<PrismaClient, '$queryRaw'>;
type RequestRow = {
  round_id: string;
  authority_id: string;
  root_certificate_sha256: string;
  signer_certificate_sha256: string;
  policy_oid: string;
  max_accuracy_ms: number;
  commitment: unknown;
  commitment_hash: string;
  query_der: Uint8Array;
  query_sha256: string;
  nonce_hex: string;
};
type ReceiptRow = {
  response_der: Uint8Array;
  response_sha256: string;
  serial_hex: string;
  observed_from_ms: bigint;
  observed_through_ms: bigint;
};
export class PublicationArchiveConflict extends Error {
  readonly statusCode = 409;
  constructor() {
    super('Publication request or receipt conflicts with the stored archive');
  }
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(id);

async function loadRequest(client: Reader, roundId: string) {
  const [request] = await client.$queryRaw<RequestRow[]>`
    SELECT round_id,authority_id,root_certificate_sha256,signer_certificate_sha256,policy_oid,max_accuracy_ms,
      commitment,commitment_hash,query_der,query_sha256,nonce_hex
    FROM public.house_publication_requests WHERE round_id=${roundId}`;
  return request;
}
async function loadReceipt(client: Reader, roundId: string) {
  const [receipt] = await client.$queryRaw<ReceiptRow[]>`
    SELECT response_der,response_sha256,serial_hex,observed_from_ms,observed_through_ms
    FROM public.house_publication_receipts WHERE round_id=${roundId}`;
  return receipt;
}
function validateRequest(row: RequestRow, roots: readonly PublicationAuthority[]) {
  const identity = publicationAuthorityIdentity(row.authority_id, roots);
  if (
    identity.rootCertificateSha256 !== row.root_certificate_sha256 ||
    identity.signerCertificateSha256 !== row.signer_certificate_sha256 ||
    identity.policyOid !== row.policy_oid ||
    identity.maxAccuracyMs !== row.max_accuracy_ms ||
    !(row.query_der instanceof Uint8Array) ||
    !row.query_der.byteLength ||
    row.query_der.byteLength > MAX_TIMESTAMP_REQUEST_BYTES ||
    hash(row.query_der) !== row.query_sha256
  )
    throw new PublicationWitnessUnavailable();
  const proof = parseSpinPublicProof({
    schema: 'playqube-spin-proof-v1',
    stage: 'PENDING',
    reveal: null,
    commitment: row.commitment,
    commitmentHash: row.commitment_hash,
  });
  const query = inspectTimestampRequest(Buffer.from(row.query_der));
  if (
    proof.commitment.roundId !== row.round_id ||
    hash(spinPublicCommitmentFrame(proof.commitment)) !== row.commitment_hash ||
    query.hash !== row.commitment_hash ||
    query.policy !== identity.policyOid ||
    query.nonce !== row.nonce_hex
  )
    throw new PublicationWitnessUnavailable();
  const request: PublicationRequest = {
    authorityId: identity.authorityId,
    commitmentHash: row.commitment_hash,
    queryDer: Buffer.from(row.query_der),
  };
  return { identity, proof, request };
}
async function archive(
  row: RequestRow,
  receipt: ReceiptRow | undefined,
  roots: readonly PublicationAuthority[]
): Promise<PublicPublicationArchive> {
  const { identity, proof, request } = validateRequest(row, roots);
  const result: PublicPublicationArchive = {
    schema: 'playqube-spin-publication-v1',
    roundId: row.round_id,
    proof,
    authority: identity,
    request: {
      sha256: row.query_sha256,
      derBase64: request.queryDer.toString('base64'),
      nonceHex: row.nonce_hex,
    },
    receipt: null,
  };
  if (receipt) {
    // Never return cached database claims as verification. Re-run CMS, ESS,
    // imprint, nonce, signed time and current source-trust checks on raw DER.
    const witness = await verifyPublicationWitness(proof, request, receipt.response_der, roots);
    if (
      witness.responseSha256 !== receipt.response_sha256 ||
      witness.serial !== receipt.serial_hex ||
      BigInt(witness.observedFromMs) !== receipt.observed_from_ms ||
      BigInt(witness.observedThroughMs) !== receipt.observed_through_ms
    )
      throw new PublicationWitnessUnavailable();
    result.receipt = {
      sha256: witness.responseSha256,
      derBase64: Buffer.from(receipt.response_der).toString('base64'),
      serialHex: witness.serial,
      observedFromMs: witness.observedFromMs,
      observedThroughMs: witness.observedThroughMs,
    };
  }
  return result;
}
async function lockRound(tx: Prisma.TransactionClient, roundId: string) {
  if (!validId(roundId)) throw new PublicationWitnessUnavailable();
  const [access] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT CURRENT_USER=pg_catalog.pg_get_userbyid(c.relowner) AS allowed
    FROM pg_catalog.pg_class c WHERE c.oid='public.house_publication_requests'::pg_catalog.regclass`;
  if (!access?.allowed) throw new PublicationWitnessUnavailable();
  const [row] = await tx.$queryRaw<Array<{ stream_id: string }>>`
    SELECT stream_id FROM public.scheduled_game_rounds WHERE id=${roundId}`;
  if (!row) throw new PublicationWitnessUnavailable();
  // Same ordering as preparation/draw and the schedule's database guards.
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(${'scheduled-round:' + row.stream_id},0))) AS waiting`;
  await tx.$queryRaw`SELECT id FROM public.scheduled_game_rounds WHERE id=${roundId} FOR UPDATE`;
}
async function currentCommitment(tx: Prisma.TransactionClient, roundId: string, expected?: string) {
  const proof = await readPublicSpinProof(tx, roundId);
  if (!proof || (expected && proof.commitmentHash !== expected))
    throw new PublicationWitnessUnavailable();
  return proof;
}

/** Owner-only, offline preparation. One immutable query/nonce per round;
 * provider retry must resend these bytes, never generate a replacement nonce.
 * Explicit roots are for offline/test callers, never an HTTP request parameter. */
export async function prepareDormantPublicationRequest(
  owner: PrismaClient,
  roundId: string,
  authorityId: string,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
) {
  return owner.$transaction(
    async (tx) => {
      await lockRound(tx, roundId);
      const existing = await loadRequest(tx, roundId);
      if (existing) {
        if (existing.authority_id !== authorityId) throw new PublicationArchiveConflict();
        validateRequest(existing, roots);
        return { archive: await archive(existing, undefined, roots), isReplay: true };
      }
      const proof = await currentCommitment(tx, roundId);
      const identity = publicationAuthorityIdentity(authorityId, roots);
      const request = await createPublicationRequest(proof, authorityId, roots);
      const query = inspectTimestampRequest(request.queryDer);
      // The INSERT guard rechecks exact current terms and the real database
      // cutoff after request generation, while the round/stream locks are held.
      await tx.$executeRaw`
      INSERT INTO public.house_publication_requests(round_id,authority_id,root_certificate_sha256,
        signer_certificate_sha256,policy_oid,max_accuracy_ms,commitment,commitment_hash,query_der,query_sha256,nonce_hex)
      VALUES (${roundId},${authorityId},${identity.rootCertificateSha256},${identity.signerCertificateSha256},
        ${identity.policyOid},${identity.maxAccuracyMs},${JSON.stringify(proof.commitment)}::JSONB,
        ${proof.commitmentHash},${request.queryDer},${hash(request.queryDer)},${query.nonce})`;
      const stored = await loadRequest(tx, roundId);
      if (!stored) throw new PublicationWitnessUnavailable();
      return { archive: await archive(stored, undefined, roots), isReplay: false };
    },
    { isolationLevel: 'ReadCommitted', timeout: 20_000 }
  );
}

/** Owner-only import of supplied bytes. No provider request, network, financial
 * hold or gate change. A response is stored only after real offline verification. */
export async function recordDormantPublicationReceipt(
  owner: PrismaClient,
  roundId: string,
  response: Uint8Array,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
) {
  if (
    !(response instanceof Uint8Array) ||
    !response.byteLength ||
    response.byteLength > MAX_TIMESTAMP_RESPONSE_BYTES
  )
    throw new PublicationWitnessUnavailable();
  // Snapshot the caller's buffer before the first await; later mutation cannot
  // replace the bytes verified or committed.
  const bytes = Buffer.from(response);
  return owner.$transaction(
    async (tx) => {
      await lockRound(tx, roundId);
      const row = await loadRequest(tx, roundId);
      if (!row) throw new PublicationWitnessUnavailable();
      const stored = await loadReceipt(tx, roundId);
      if (stored) {
        if (!Buffer.from(stored.response_der).equals(bytes)) throw new PublicationArchiveConflict();
        return { archive: await archive(row, stored, roots), isReplay: true };
      }
      const { proof, request } = validateRequest(row, roots);
      await currentCommitment(tx, roundId, row.commitment_hash);
      const witness = await verifyPublicationWitness(proof, request, bytes, roots);
      await tx.$executeRaw`
      INSERT INTO public.house_publication_receipts(round_id,response_der,response_sha256,serial_hex,observed_from_ms,observed_through_ms)
      VALUES (${roundId},${bytes},${witness.responseSha256},${witness.serial},
        ${BigInt(witness.observedFromMs)},${BigInt(witness.observedThroughMs)})`;
      const receipt = await loadReceipt(tx, roundId);
      return { archive: await archive(row, receipt, roots), isReplay: false };
    },
    { isolationLevel: 'ReadCommitted', timeout: 20_000 }
  );
}

/** Two parameterized SELECTs, zero writes/locks/lazy creation. Request rows are
 * immutable and receipts append once, so a racing import yields a coherent
 * request-only or completed archive. Archived evidence survives terminal rounds.
 * Default production trust stays empty and fails closed. */
export async function readPublicPublicationArchive(
  client: Reader,
  roundId: string,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
): Promise<PublicPublicationArchive | null> {
  if (!validId(roundId)) return null;
  try {
    const row = await loadRequest(client, roundId);
    if (!row) return null;
    return await archive(row, await loadReceipt(client, roundId), roots);
  } catch {
    throw new PublicationWitnessUnavailable();
  }
}
