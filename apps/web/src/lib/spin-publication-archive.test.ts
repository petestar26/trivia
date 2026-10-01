import { webcrypto } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PUBLICATION_JSON_BYTES } from '@socialplay/shared';
import { PUBLICATION_ARCHIVE } from '@/test/spin-publication-fixture';
import {
  checkPublicationArchiveIntegrity,
  loadPublicPublicationArchive,
} from './spin-publication-archive';
import { SpinProofCryptoUnavailable } from './spin-proof-verifier';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const round = PUBLICATION_ARCHIVE.roundId;
const envelope = JSON.stringify({ success: true, data: PUBLICATION_ARCHIVE });
function response(text = envelope, headers: Record<string, string> = {}, ok = true) {
  const cancel = vi.fn();
  let offset = 0;
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 17));
      offset = Math.min(offset + 17, bytes.length);
    },
    cancel,
  });
  return { ok, headers: new Headers(headers), body, cancel };
}
const load = () => loadPublicPublicationArchive(round, new AbortController().signal);
describe('browser archive integrity, never timestamp authentication', () => {
  it('checks hashes and earlier commitment but never authenticates even bogus TSA bytes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await checkPublicationArchiveIntegrity(
      PUBLICATION_ARCHIVE,
      PUBLICATION_ARCHIVE.proof
    );
    expect(result.matchedSavedReceipt).toBe(true);
    expect(result.timestampSignatureVerified).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('request-only archives remain explicitly unverified', async () => {
    expect(
      await checkPublicationArchiveIntegrity({ ...PUBLICATION_ARCHIVE, receipt: null })
    ).toMatchObject({ timestampSignatureVerified: false, archive: { receipt: null } });
  });
  it.each(['request', 'receipt'] as const)('rejects binary hash mismatch for %s', async (key) => {
    const raw = structuredClone(PUBLICATION_ARCHIVE);
    raw[key]!.sha256 = '0'.repeat(64);
    await expect(checkPublicationArchiveIntegrity(raw)).rejects.toThrow();
  });
  it('rejects a different or drawn earlier receipt', async () => {
    const saved = structuredClone(PUBLICATION_ARCHIVE.proof);
    saved.commitment.opensAtMs--;
    await expect(checkPublicationArchiveIntegrity(PUBLICATION_ARCHIVE, saved)).rejects.toThrow();
    await expect(
      checkPublicationArchiveIntegrity(PUBLICATION_ARCHIVE, { ...saved, stage: 'DRAWN' })
    ).rejects.toThrow();
  });
  it('missing Web Crypto is never a verified archive', async () => {
    vi.stubGlobal('crypto', {});
    await expect(checkPublicationArchiveIntegrity(PUBLICATION_ARCHIVE)).rejects.toBeInstanceOf(
      SpinProofCryptoUnavailable
    );
  });
});
describe('bounded public archive download', () => {
  it('uses only the fixed public GET without credentials and handles partial chunks', async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch);
    expect(await load()).toEqual(PUBLICATION_ARCHIVE);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/proofs/${encodeURIComponent(round)}/publication`),
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      })
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects claimed oversized bodies before reading and cancels them', async () => {
    const r = response(envelope, { 'content-length': String(MAX_PUBLICATION_JSON_BYTES + 4097) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(r));
    await expect(load()).rejects.toThrow();
    expect(r.cancel).toHaveBeenCalledOnce();
  });
  const lengths: Record<string, string>[] = [{}, { 'content-length': '1' }];
  it.each(lengths)(
    'enforces actual byte bound despite missing or false length: %j',
    async (headers) => {
      const r = response(' '.repeat(MAX_PUBLICATION_JSON_BYTES * 2), headers);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(r));
      await expect(load()).rejects.toThrow();
      expect(r.cancel).toHaveBeenCalledOnce();
    }
  );
  it.each([
    JSON.stringify({ success: false, data: PUBLICATION_ARCHIVE }),
    '{',
    JSON.stringify({ success: true, data: {} }),
  ])('rejects invalid envelope/archive safely', async (text) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(text)));
    await expect(load()).rejects.toThrow();
  });
  it('rejects an internally valid archive for a different requested round', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    await expect(
      loadPublicPublicationArchive('other:1', new AbortController().signal)
    ).rejects.toThrow('Archive round mismatch');
  });
  it('an aborted stalled body is cancelled rather than returned', async () => {
    const cancel = vi.fn(),
      controller = new AbortController();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(envelope.slice(0, 20)));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body, headers: new Headers() }));
    const promise = loadPublicPublicationArchive(round, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('invalid IDs never issue a request; server errors cancel their bodies', async () => {
    const r = response('private error', {}, false),
      fetch = vi.fn().mockResolvedValue(r);
    vi.stubGlobal('fetch', fetch);
    await expect(
      loadPublicPublicationArchive('../unsafe', new AbortController().signal)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(load()).rejects.toThrow();
    expect(r.cancel).toHaveBeenCalledOnce();
  });
});
