import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TIMESTAMP_REQUEST_BYTES,
  MAX_TIMESTAMP_RESPONSE_BYTES,
} from './publication-witness.js';
import { postTimestampQuery, TimestampTransportUnavailable } from './publication-transport.js';

let directory: string;
let server: https.Server;
let endpoint: string;
let certificate: Buffer;
let seen: Array<{ body: Buffer; headers: IncomingMessage['headers'] }>;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const realRequest = https.request;
const reply = (res: ServerResponse, bytes = Buffer.from([0x30, 0])) => {
  res.setHeader('Content-Type', 'application/timestamp-reply');
  res.end(bytes);
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'playqube-tsa-transport-'));
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { timeout: 10_000, maxBuffer: 65536 }
  );
  certificate = await readFile(join(directory, 'cert.pem'));
  server = https.createServer(
    { key: await readFile(join(directory, 'key.pem')), cert: certificate },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks), headers: req.headers });
        handler(req, res);
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback server');
  endpoint = `https://127.0.0.1:${address.port}/timestamp`;
});
beforeEach(() => {
  seen = [];
  handler = (_req, res) => reply(res);
  // Test-only CA. The implementation still uses real TLS/hostname validation,
  // real sockets and Node's HTTP parser; no rejectUnauthorized=false shortcut.
  vi.spyOn(https, 'request').mockImplementation(((url, options, callback) =>
    realRequest(url, { ...options, ca: certificate }, callback)) as typeof https.request);
});
afterEach(() => {
  vi.restoreAllMocks();
  server.closeAllConnections();
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('bounded timestamp POST, real loopback TLS', () => {
  it('sends the exact snapshotted binary query with RFC3161 headers', async () => {
    const query = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]);
    const expected = Buffer.from(query);
    const pending = postTimestampQuery(endpoint, query);
    query.fill(0xff);
    expect(await pending).toEqual(Buffer.from([0x30, 0]));
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual(expected);
    expect(seen[0].headers).toMatchObject({
      'content-type': 'application/timestamp-query',
      accept: 'application/timestamp-reply',
      'accept-encoding': 'identity',
      'content-length': '5',
    });
  });
  it('accepts the exact maximum query and response byte counts', async () => {
    handler = (_req, res) => reply(res, Buffer.alloc(MAX_TIMESTAMP_RESPONSE_BYTES, 7));
    const response = await postTimestampQuery(
      endpoint,
      Buffer.alloc(MAX_TIMESTAMP_REQUEST_BYTES, 9)
    );
    expect(seen[0].body).toHaveLength(MAX_TIMESTAMP_REQUEST_BYTES);
    expect(response).toEqual(Buffer.alloc(MAX_TIMESTAMP_RESPONSE_BYTES, 7));
  });
  it.each([
    'http://localhost/tsa',
    'https://user:secret@example.com/tsa',
    'https://example.com/tsa?token=secret',
    'https://example.com/#private',
    'not a URL',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('rejects unsafe/unapproved URL form before opening a socket: %s', async (url) => {
    await expect(postTimestampQuery(url, Buffer.from([1]))).rejects.toThrow(
      TimestampTransportUnavailable
    );
    expect(https.request).not.toHaveBeenCalled();
  });
  it.each([Buffer.alloc(0), Buffer.alloc(MAX_TIMESTAMP_REQUEST_BYTES + 1)])(
    'refuses invalid query bounds before connecting',
    async (query) => {
      await expect(postTimestampQuery(endpoint, query)).rejects.toThrow(
        TimestampTransportUnavailable
      );
      expect(https.request).not.toHaveBeenCalled();
    }
  );
  it.each([0, 5001, 1.5, Number.NaN])('refuses invalid timeout %s', async (timeout) => {
    await expect(postTimestampQuery(endpoint, Buffer.from([1]), timeout)).rejects.toThrow(
      TimestampTransportUnavailable
    );
    expect(https.request).not.toHaveBeenCalled();
  });
  it.each([
    [502, true],
    [503, true],
    [504, true],
    [429, false],
    [400, false],
    [500, false],
    [302, false],
  ])('classifies HTTP %s without reading its error body', async (status, retryable) => {
    handler = (_req, res) => {
      res.writeHead(status as number, { Location: endpoint });
      res.end('secret-provider-error');
    };
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toMatchObject({
      message: 'Independent timestamp submission is unavailable',
      retryable,
    });
    expect(seen).toHaveLength(1); // In particular: no redirect follow.
  });
  it.each([
    { 'Content-Type': 'text/html' },
    { 'Content-Type': 'application/timestamp-reply', 'Content-Encoding': 'gzip' },
    {
      'Content-Type': 'application/timestamp-reply',
      'Content-Length': String(MAX_TIMESTAMP_RESPONSE_BYTES + 1),
    },
  ])('rejects unsafe response headers', async (headers) => {
    handler = (_req, res) => {
      res.writeHead(200, headers);
      res.flushHeaders();
    };
    await expect(postTimestampQuery(endpoint, Buffer.from([1]), 500)).rejects.toMatchObject({
      retryable: false,
    });
  });
  it('rejects a chunked oversized body even without Content-Length', async () => {
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/timestamp-reply');
      res.write(Buffer.alloc(MAX_TIMESTAMP_RESPONSE_BYTES));
      res.end(Buffer.from([1]));
    };
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toMatchObject({
      retryable: false,
    });
  });
  it('rejects an empty successful response', async () => {
    handler = (_req, res) => reply(res, Buffer.alloc(0));
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toThrow(
      TimestampTransportUnavailable
    );
  });
  it('rejects a truncated response', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/timestamp-reply',
        'Content-Length': '100',
      });
      res.write(Buffer.from([1]));
      setTimeout(() => res.destroy(), 10);
    };
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toThrow(
      TimestampTransportUnavailable
    );
  });
  it('bounds oversized response headers with the real parser', async () => {
    handler = (_req, res) => {
      res.setHeader('X-Large', 'x'.repeat(9000));
      reply(res);
    };
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toThrow(
      TimestampTransportUnavailable
    );
  });
  it('terminates when the provider never sends headers', async () => {
    handler = () => {};
    const start = performance.now();
    await expect(postTimestampQuery(endpoint, Buffer.from([1]), 100)).rejects.toMatchObject({
      retryable: true,
    });
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it('uses an absolute deadline despite a continuously trickling body', async () => {
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/timestamp-reply');
      res.flushHeaders();
      const timer = setInterval(() => res.write(Buffer.from([1])), 10);
      res.once('close', () => clearInterval(timer));
    };
    const start = performance.now();
    await expect(postTimestampQuery(endpoint, Buffer.from([1]), 100)).rejects.toMatchObject({
      retryable: true,
    });
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it('retains normal TLS validation and sanitizes certificate failures', async () => {
    vi.restoreAllMocks(); // Test-only trust removed; self-signed CA is untrusted.
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toMatchObject({
      message: 'Independent timestamp submission is unavailable',
      retryable: false,
    });
    expect(seen).toHaveLength(0);
  });
  it('sanitizes synchronous client failures as well as asynchronous socket errors', async () => {
    vi.mocked(https.request).mockImplementation(() => {
      throw new Error('sensitive endpoint and credential');
    });
    await expect(postTimestampQuery(endpoint, Buffer.from([1]))).rejects.toMatchObject({
      message: 'Independent timestamp submission is unavailable',
      retryable: false,
    });
  });
});
