import {
  decodePublicationDer,
  MAX_PUBLICATION_JSON_BYTES,
  MAX_PUBLICATION_QUERY_BYTES,
  MAX_PUBLICATION_REPLY_BYTES,
  parsePublicPublicationArchive,
} from '@socialplay/shared';
import { API_BASE } from './api-config';
import { SpinProofCryptoUnavailable, verifyPublicSpinProof } from './spin-proof-verifier';

async function hash(bytes: Uint8Array) {
  if (!globalThis.crypto?.subtle) throw new SpinProofCryptoUnavailable();
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks structure, commitment and binary hashes only. This browser helper
 * does NOT authenticate CMS/TSA signatures, certificates or signed timestamps. */
export async function checkPublicationArchiveIntegrity(raw: unknown, savedReceipt?: unknown) {
  const archive = parsePublicPublicationArchive(raw);
  const commitment = await verifyPublicSpinProof(archive.proof, savedReceipt);
  if (
    (await hash(decodePublicationDer(archive.request.derBase64, MAX_PUBLICATION_QUERY_BYTES))) !==
    archive.request.sha256
  )
    throw new Error('Archive request hash mismatch');
  if (
    archive.receipt &&
    (await hash(decodePublicationDer(archive.receipt.derBase64, MAX_PUBLICATION_REPLY_BYTES))) !==
      archive.receipt.sha256
  )
    throw new Error('Archive response hash mismatch');
  return {
    archive,
    matchedSavedReceipt: commitment.matchedSavedReceipt,
    timestampSignatureVerified: false as const,
  };
}
export type PublicationArchiveIntegrity = Awaited<
  ReturnType<typeof checkPublicationArchiveIntegrity>
>;

/** The fixed public API is the only endpoint. Stream limits are enforced even
 * when Content-Length is missing or false. An aborted read cannot return data. */
export async function loadPublicPublicationArchive(roundId: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(roundId)) throw new Error('Invalid round ID');
  const response = await fetch(
    `${API_BASE}/games/scheduled/spin-win/proofs/${encodeURIComponent(roundId)}/publication`,
    {
      credentials: 'omit',
      cache: 'no-store',
      signal,
    }
  );
  const maxBytes = MAX_PUBLICATION_JSON_BYTES + 4096;
  const length = response.headers.get('content-length');
  if (
    !response.ok ||
    !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
  ) {
    await response.body?.cancel();
    throw new Error('Publication archive is unavailable');
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw new Error('Aborted');
    while (size <= maxBytes) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error('Aborted');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Archive too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !body ||
      typeof body !== 'object' ||
      !('success' in body) ||
      body.success !== true ||
      !('data' in body)
    )
      throw new Error('Invalid archive envelope');
    const archive = parsePublicPublicationArchive(body.data);
    if (archive.roundId !== roundId) throw new Error('Archive round mismatch');
    return archive;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
