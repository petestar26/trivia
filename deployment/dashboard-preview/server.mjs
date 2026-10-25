import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = 'a30788bcea91e9671ed16f34bcbfd67148c8dbec';
export const SOURCE_TREE = '71b951fe2dd9f7bf61f39dc33296c5c811608633';
export const HTML_SHA256 = '0de5d63de864737741cce2aaa2366a541f3d298f1b3cc25b057d3834b6cc4821';

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
