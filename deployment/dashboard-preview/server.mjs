import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = '328bc9e536356ea9242244491aa0c39f22c5d6da';
export const SOURCE_TREE = 'ab0dab8ecc8e3bb875e3064c3345dbcc8d85c3c8';
export const HTML_SHA256 = '2fb2361b310cb8a56225a8ff5e24da6e2cd15072f13ee6a9244493c24c44afef';

/** Isolated UI-review artifact. No proxy, authentication, database or external requests. */
export async function createPreviewServer() {
  const html = await readFile(new URL('./index.html', import.meta.url));
  if (createHash('sha256').update(html).digest('hex') !== HTML_SHA256) {
    throw new Error('Preview artifact integrity check failed');
  }
  const health = Buffer.from(JSON.stringify({
    status: 'ok', preview: true, syntheticData: true, backendConnected: false,
    sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE, htmlSha256: HTML_SHA256,
  }));
  return http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...headers, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Read-only UI preview');
      return;
    }
    const pathname = req.url?.split('?')[0];
    const isPage = pathname === '/' || pathname === '/index.html';
    const body = isPage ? html : pathname === '/health' ? health : Buffer.from('Not found');
    res.writeHead(isPage || pathname === '/health' ? 200 : 404, {
      ...headers,
      'content-type': isPage ? 'text/html; charset=utf-8' : pathname === '/health' ? 'application/json' : 'text/plain; charset=utf-8',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const server = await createPreviewServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, '0.0.0.0', () => console.log('Read-only dashboard preview ready'));
}
