// Private visual review only: no upstream connection, account, payment, or provider.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.GUEST_PREVIEW_DIST || resolve(directory, 'dist'));
const port = Number(process.env.PORT || 5186);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; form-action 'self'; base-uri 'none'"
  );
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/socket.io') ||
    request.method !== 'GET'
  ) {
    // Never read, store, forward, or log request bodies or credentials.
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Private visual preview: no real account or provider connection.',
        },
      })
    );
    return;
  }
  if (pathname === '/sw.js' || pathname.endsWith('.map')) {
    response.writeHead(404).end();
    return;
  }
  const candidate = resolve(root, `.${pathname}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  let file = candidate;
  try {
    if (!(await stat(file)).isFile()) file = resolve(root, 'index.html');
  } catch {
    if (extname(pathname)) {
      response.writeHead(404).end();
      return;
    }
    file = resolve(root, 'index.html');
  }
  try {
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    response.end(bytes);
  } catch {
    response.writeHead(404).end('Preview build not found.');
  }
});
server.on('upgrade', (_request, socket) => socket.destroy());
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Private guest preview: http://127.0.0.1:${server.address().port}\nEvery API is stubbed. Do not enter real credentials. Stop with Ctrl+C.`
  )
);
