#!/usr/bin/env bash
set -euo pipefail
test "$(readlink /proc/self/ns/net)" != "$HOST_NET"
test "$(id -u)" -ne 0
test "$(uname -m)" = x86_64
command -v python3 >/dev/null
test "$(node --version)" = v20.20.2
test "$(sha256sum "$(command -v node)" | cut -d' ' -f1)" = "$NODE_SHA"
python3 - <<'PY'
import socket
interfaces = {name for _, name in socket.if_nameindex()}
assert interfaces == {'lo'}, 'non-loopback interface'
with socket.socket() as probe:
    probe.bind(('127.0.0.1',0))
with open('/proc/net/route') as f:
    assert all(r.split()[0]=='lo' for r in f.read().splitlines()[1:] if r.strip())
with open('/proc/net/ipv6_route') as f:
    assert all(r.split()[-1]=='lo' for r in f if r.strip())
PY
mkdir "$HOME" "$OUTPUT" "$BASELINE" "$STORE"
cp -a /in-baseline/. "$BASELINE/"
cp -a /in-store/. "$STORE/"
node - <<'JS'
const a=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const child=require('node:child_process');
const requireFrom=require('node:module').createRequire('/in-qa/package.json');
a.equal(requireFrom('playwright/package.json').version,'1.58.2');
a.equal(requireFrom('playwright-core/package.json').version,'1.58.2');
const core=path.dirname(requireFrom.resolve('playwright-core/package.json'));
const inventory=JSON.parse(fs.readFileSync(path.join(core,'browsers.json'),'utf8')).browsers;
const expected=inventory.find(x=>x.name==='chromium');
const shell=inventory.find(x=>x.name==='chromium-headless-shell');
a.ok(expected && shell && /^[0-9]+$/.test(expected.revision) && /^[0-9]+$/.test(shell.revision));
for (const [item, file] of [[expected,'chrome-linux64/chrome'],[shell,'chrome-headless-shell-linux64/chrome-headless-shell']]) {
  const root='/ms-playwright/'+item.name.replaceAll('-','_')+'-'+item.revision;
  const built=fs.realpathSync(path.join(root,file));
  a.ok(built.startsWith(root+'/') && fs.statSync(built).isFile());
  const actual=child.execFileSync(built,['--version'],{encoding:'utf8',timeout:5000});
  a.ok(actual.trim().endsWith(item.browserVersion));
  console.log(item.name+' revision='+item.revision+' version='+item.browserVersion);
}
JS
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
rc=0
node run.mjs || rc=$?
report="$QA_OUTPUT_DIR/synthetic-payment-ui.json"
if test -f "$report" && test ! -L "$report"; then
  test "$(stat -c %s "$report")" -le 65536
  cp --no-clobber "$report" /handoff/synthetic-payment-ui.json
else
  test "$rc" -ne 0
fi
exit "$rc"
