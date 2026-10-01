import { z } from 'zod';
import { parseSpinPublicProof } from './spin-win-proof.js';
import type { SpinPublicProof } from './spin-win-proof.js';

export const MAX_PUBLICATION_JSON_BYTES = 196_608;
export const MAX_PUBLICATION_QUERY_BYTES = 4_096;
export const MAX_PUBLICATION_REPLY_BYTES = 65_536;
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const positiveHex = z.string().regex(/^[1-9a-f][0-9a-f]{0,39}$/);
const epoch = z.number().int().nonnegative().max(8_640_000_000_000_000);
const schema = z
  .object({
    schema: z.literal('playqube-spin-publication-v1'),
    roundId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    proof: z.unknown(),
    authority: z
      .object({
        authorityId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        rootCertificateSha256: hex32,
        signerCertificateSha256: hex32,
        policyOid: z
          .string()
          .max(MAX_PUBLICATION_QUERY_BYTES)
          .regex(/^\d+(?:\.\d+)+$/),
        maxAccuracyMs: z.number().int().min(1).max(5000),
      })
      .strict(),
    request: z
      .object({ sha256: hex32, derBase64: z.string().max(5464), nonceHex: positiveHex })
      .strict(),
    receipt: z
      .object({
        sha256: hex32,
        derBase64: z.string().max(87384),
        serialHex: positiveHex,
        observedFromMs: epoch,
        observedThroughMs: epoch,
      })
      .strict()
      .nullable(),
  })
  .strict();

export interface PublicPublicationArchive {
  schema: 'playqube-spin-publication-v1';
  roundId: string;
  // Original pending terms; not current round state or an authenticated timestamp.
  proof: SpinPublicProof;
  authority: {
    authorityId: string;
    rootCertificateSha256: string;
    signerCertificateSha256: string;
    policyOid: string;
    maxAccuracyMs: number;
  };
  request: { sha256: string; derBase64: string; nonceHex: string };
  receipt: null | {
    sha256: string;
    derBase64: string;
    serialHex: string;
    observedFromMs: number;
    observedThroughMs: number;
  };
}

function record(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some((d) => !('value' in d) || !d.enumerable)) throw new Error();
  return raw as Record<string, unknown>;
}

/** Canonical binary decoding only. It does not authenticate a CMS/TSA token. */
export function decodePublicationDer(text: string, maxBytes: number): Uint8Array {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_PUBLICATION_REPLY_BYTES ||
    typeof text !== 'string' ||
    !text.length ||
    text.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new Error('Invalid publication bytes');
  const binary = atob(text);
  if (!binary.length || binary.length > maxBytes || btoa(binary) !== text)
    throw new Error('Invalid publication bytes');
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}

/** Strict structural parser. Pins/metadata in this file NEVER supply trust.
 * Cryptographic verification against independent source trust is separate. */
export function parsePublicPublicationArchive(raw: unknown): PublicPublicationArchive {
  try {
    const r = record(raw);
    record(r.authority);
    record(r.request);
    if (r.receipt !== null) record(r.receipt);
    const p = record(r.proof);
    record(p.commitment);
    const result = schema.parse(r);
    const proof = parseSpinPublicProof(result.proof);
    if (
      proof.stage !== 'PENDING' ||
      proof.reveal !== null ||
      proof.commitment.roundId !== result.roundId
    )
      throw new Error();
    decodePublicationDer(result.request.derBase64, MAX_PUBLICATION_QUERY_BYTES);
    if (result.receipt) {
      const receipt = result.receipt;
      decodePublicationDer(receipt.derBase64, MAX_PUBLICATION_REPLY_BYTES);
      if (
        receipt.observedFromMs < proof.commitment.preparedAtMs ||
        receipt.observedThroughMs < receipt.observedFromMs ||
        receipt.observedThroughMs >= proof.commitment.closesAtMs ||
        receipt.observedThroughMs - receipt.observedFromMs > result.authority.maxAccuracyMs * 2 + 1
      )
        throw new Error();
    }
    return { ...result, proof };
  } catch {
    throw new Error('Publication archive is invalid');
  }
}

export function parsePublicationArchiveText(text: string): PublicPublicationArchive {
  try {
    if (
      typeof text !== 'string' ||
      text.length > MAX_PUBLICATION_JSON_BYTES ||
      new TextEncoder().encode(text).byteLength > MAX_PUBLICATION_JSON_BYTES
    )
      throw new Error();
    return parsePublicPublicationArchive(JSON.parse(text));
  } catch {
    throw new Error('Publication archive is invalid or oversized');
  }
}
