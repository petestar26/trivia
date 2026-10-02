import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
export function upstreamOrigin(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('WEB_API_ORIGIN must be an HTTP(S) origin without credentials');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('WEB_API_ORIGIN must use HTTPS outside localhost');
  return url;
}
function cleanHeaders(headers) {
  const blocked = new Set([
    ...HOP,
    ...String(headers.connection || '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase()))
  );
}
function sameOrigin(req) {
  try {
    return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}
function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ success: false, error: { code: 'WEB_GATEWAY', message } }));
}
/** Fixed-origin gateway: no client-supplied upstream, tokens, or credentials in browser storage. */
export function createWebServer({
  apiOrigin,
  staticRoot = path.join(ROOT, 'dist'),
  timeoutMs = 15000,
}) {
  const upstream = upstreamOrigin(apiOrigin);
  const transport = upstream.protocol === 'https:' ? https : http;
  const root = path.resolve(staticRoot);
  function proxy(req, res) {
    // Browser writes must originate from this frontend. CORS alone is not CSRF protection.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      fail(res, 403, 'This request must originate from the app.');
      return;
    }
    const headers = cleanHeaders(req.headers);
    headers.host = upstream.host;
    const request = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: req.url,
        headers,
      },
      (response) => {
        const responseHeaders = cleanHeaders(response.headers);
        responseHeaders['cache-control'] = 'private, no-store';
        res.writeHead(response.statusCode || 502, responseHeaders);
        response.on('error', () => res.destroy());
        response.pipe(res);
      }
    );
    // Engine.IO polling can wait for the next heartbeat; allow its 25s ping interval.
    request.setTimeout(req.url.startsWith('/ws') ? Math.max(timeoutMs, 45000) : timeoutMs, () =>
      request.destroy()
    );
    request.on('error', () =>
      fail(res, 502, 'The service is temporarily unavailable. Please retry.')
    );
    req.on('aborted', () => request.destroy());
    res.on('close', () => {
      if (!res.writableEnded) request.destroy();
    });
    req.pipe(request);
  }
  const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      fail(res, 400, 'Invalid request path.');
      return;
    }
    const pathname = req.url.split('?')[0];
    if (
      pathname === '/health' ||
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname === '/ws' ||
      pathname.startsWith('/ws/')
    ) {
      proxy(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      fail(res, 405, 'Method not allowed.');
      return;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      fail(res, 400, 'Invalid request path.');
      return;
    }
    if (
      decoded.includes('\\') ||
      decoded.includes('\0') ||
      decoded.split('/').some((s) => s.startsWith('.'))
    ) {
      fail(res, 404, 'Not found.');
      return;
    }
    let file = path.resolve(root, '.' + decoded);
    if (!file.startsWith(root + path.sep) && file !== root) {
      fail(res, 404, 'Not found.');
      return;
    }
    try {
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = path.join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) {
        if (path.extname(decoded)) {
          fail(res, 404, 'Not found.');
          return;
        }
        file = path.join(root, 'index.html');
      }
      const bytes = await readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': bytes.length,
        'x-content-type-options': 'nosniff',
        'cache-control':
          ext === '.html' || /(?:sw|workbox).*\.js$/.test(file)
            ? 'no-cache'
            : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      fail(res, 503, 'The app is temporarily unavailable.');
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws') || !/^\/ws(?:\/|\?|$)/.test(req.url) || !sameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const headers = {
      ...cleanHeaders(req.headers),
      host: upstream.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
    };
    const request = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: 'GET',
      path: req.url,
      headers,
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      request.setTimeout(0);
      const lines = Object.entries(response.headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`)
      );
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    request.on('response', (response) => {
      response.resume();
      socket.end(
        `HTTP/1.1 ${response.statusCode || 502} Service unavailable\r\nConnection: close\r\n\r\n`
      );
    });
    request.on('error', () => socket.destroy());
    socket.on('close', () => request.destroy());
    request.end();
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 20000;
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apiOrigin = process.env.WEB_API_ORIGIN || process.env.VITE_API_URL;
  if (!apiOrigin) throw new Error('WEB_API_ORIGIN is required');
  await stat(path.join(ROOT, 'dist/index.html'));
  const server = createWebServer({ apiOrigin });
  server.listen(Number(process.env.PORT || 1443), '0.0.0.0', () =>
    console.log('PlayQube web gateway ready')
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
