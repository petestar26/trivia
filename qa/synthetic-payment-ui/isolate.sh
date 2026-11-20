#!/usr/bin/env bash
set -euo pipefail
test "$(readlink /proc/self/ns/net)" != "$HOST_NET"
test "$$" -eq 1
ip link set lo up
python3 - <<'PY'
import socket
interfaces = {name for _, name in socket.if_nameindex()}
assert interfaces == {'lo'}, 'non-loopback interface'
with open('/proc/net/route') as f:
    assert all(r.split()[0]=='lo' for r in f.read().splitlines()[1:] if r.strip())
with open('/proc/net/ipv6_route') as f:
    assert all(r.split()[-1]=='lo' for r in f if r.strip())
PY
mkdir "$HOME" "$OUTPUT"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export QA_ISOLATION_ATTESTED=loopback-only-static-deny-v1
export QA_BASELINE_ROOT="$BASELINE"
export QA_BUILD_ATTESTATION="$OUTPUT/build-receipt.json"
export QA_ORIGIN=http://127.0.0.1:4173
export QA_OUTPUT_DIR="$OUTPUT/results"
export PLAYWRIGHT_MODULE="$HARNESS/node_modules/playwright/index.js"
node "$HARNESS/build-offline.mjs"
node "$HARNESS/prepare.mjs" --source "$BASELINE" --output "$OUTPUT/static"
python3 "$HARNESS/static-preview.py" "$OUTPUT/static" &
preview=$!
trap 'kill "$preview" 2>/dev/null || true; wait "$preview" 2>/dev/null || true' EXIT
python3 - <<'PY'
import http.client, time
deadline=time.monotonic()+8
def status(method,path):
    conn=http.client.HTTPConnection('127.0.0.1',4173,timeout=1)
    try:
        conn.request(method,path)
        return conn.getresponse().status
    finally:
        conn.close()
while True:
    try:
        assert status('HEAD','/') == 200
        break
    except OSError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(.1)
for path in ['/api','/api/v1/auth/me','/sg/callback','/graphql','/ws','/socket.io','/%61pi/v1/auth/me']:
    assert status('GET',path) == 403
assert status('POST','/') == 405
assert status('GET','/unknown-route') == 404
PY
cd "$HARNESS"
node --test fixtures.test.mjs
node run.mjs
