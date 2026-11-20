"""Loopback-only static fixture preview. No API handler, CGI, proxy or mutations."""
import http.server
import pathlib
import sys
import urllib.parse
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
documents = {'/', '/payment-requirements', '/wallet/deposit', '/wallet/withdraw',
             '/wallet/orders/deposit/11111111-1111-4111-8111-111111111111', '/admin/pricing'}
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root), **kwargs)
    def allowed(self):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        parts = pathlib.PurePosixPath(path).parts
        if '..' in parts or any(p.lower() in {'api', 'sg', 'graphql', 'ws', 'socket.io'} for p in parts):
            self.send_error(403, 'API disabled in synthetic preview'); return False
        if url.scheme or url.netloc or url.query or '\\' in path or '\x00' in path:
            self.send_error(400); return False
        if path in documents:
            self.path = path = '/index.html'
        target = (root / path.lstrip('/')).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            self.send_error(404); return False
        return True
    def do_GET(self):
        if self.allowed(): super().do_GET()
    def do_HEAD(self):
        if self.allowed(): super().do_HEAD()
    def do_POST(self): self.send_error(405)
    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_POST
http.server.ThreadingHTTPServer(('127.0.0.1', 4173), Handler).serve_forever()
