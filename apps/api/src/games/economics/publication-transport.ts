import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  MAX_TIMESTAMP_REQUEST_BYTES,
  MAX_TIMESTAMP_RESPONSE_BYTES,
} from './publication-witness.js';

export const MAX_TIMESTAMP_HTTP_MS = 5000;

/** Deliberately does not expose URLs, response bodies or TLS/socket errors. */
export class TimestampTransportUnavailable extends Error {
  constructor(readonly retryable = false) {
    super('Independent timestamp submission is unavailable');
  }
}

/** Endpoints come from reviewed source policy, never a round, HTTP input or env.
 * HTTPS uses Node's normal certificate/hostname validation. No redirects, URL
 * credentials, query secrets, proxy configuration or decompression are used. */
export function timestampSubmissionUrl(value: string): URL {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new TimestampTransportUnavailable();
  }
}

/** One bounded RFC 3161 POST; the caller controls the separately bounded retry.
 * The absolute timer includes DNS, TLS and the entire body, including trickles.
 * request.setTimeout alone would bound only socket inactivity. */
export async function postTimestampQuery(
  endpoint: string,
  query: Uint8Array,
  timeoutMs = MAX_TIMESTAMP_HTTP_MS
): Promise<Buffer> {
  const url = timestampSubmissionUrl(endpoint);
  if (
    !(query instanceof Uint8Array) ||
    !query.byteLength ||
    query.byteLength > MAX_TIMESTAMP_REQUEST_BYTES ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMESTAMP_HTTP_MS
  )
    throw new TimestampTransportUnavailable();
  const bytes = Buffer.from(query); // Snapshot before the first await.
  return new Promise<Buffer>((resolve, reject) => {
    let finished = false;
    let response: IncomingMessage | undefined;
    const req = https.request(url, {
      method: 'POST',
      agent: false,
      maxHeaderSize: 8192,
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
        'Accept-Encoding': 'identity',
        'Content-Length': bytes.length,
      },
    });
    const stop = (error?: TimestampTransportUnavailable, body?: Buffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Also stops oversized/rejected bodies, not just the outgoing request.
      response?.destroy();
      req.destroy();
      if (error) reject(error);
      else resolve(body!);
    };
    const timer = setTimeout(() => stop(new TimestampTransportUnavailable(true)), timeoutMs);
    req.once('error', (error: NodeJS.ErrnoException) => {
      // Certificate/hostname and protocol errors are terminal. No raw message
      // or cause is propagated, even when a URL/credential appears in one.
      stop(
        new TimestampTransportUnavailable(
          ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(
            error.code ?? ''
          )
        )
      );
    });
    req.once('upgrade', (_res, socket) => {
      socket.destroy();
      stop(new TimestampTransportUnavailable());
    });
    req.once('response', (res) => {
      response = res;
      res.once('error', () => stop(new TimestampTransportUnavailable(true)));
      res.once('aborted', () => stop(new TimestampTransportUnavailable(true)));
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        // 429 is terminal: retry policy/rate limits must be approved with the
        // provider, not guessed from an untrusted Retry-After header.
        stop(new TimestampTransportUnavailable([502, 503, 504].includes(status)));
        return;
      }
      const contentType = res.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const encoding = res.headers['content-encoding'];
      const length = res.headers['content-length'];
      if (
        contentType !== 'application/timestamp-reply' ||
        (encoding !== undefined && encoding.toLowerCase() !== 'identity') ||
        (length !== undefined &&
          (!/^[0-9]+$/.test(length) ||
            Number(length) < 1 ||
            Number(length) > MAX_TIMESTAMP_RESPONSE_BYTES))
      ) {
        stop(new TimestampTransportUnavailable());
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_TIMESTAMP_RESPONSE_BYTES) {
          stop(new TimestampTransportUnavailable());
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () => {
        if (!res.complete || !size || (length !== undefined && size !== Number(length)))
          stop(new TimestampTransportUnavailable());
        else stop(undefined, Buffer.concat(chunks, size));
      });
    });
    req.end(bytes);
  }).catch((error: unknown) => {
    if (error instanceof TimestampTransportUnavailable) throw error;
    throw new TimestampTransportUnavailable();
  });
}
