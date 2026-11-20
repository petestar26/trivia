#!/usr/bin/env bash
set -euo pipefail
[[ $# == 3 ]]
baseline=$(realpath "$1")
harness=$(realpath "$2")
store=$(realpath "$3")
[[ "$(id -u)" != 0 && "$(uname -m)" == x86_64 ]]
node=$(realpath "$(command -v node)")
node_root=$(dirname "$(dirname "$node")")
[[ "$node_root" == "$(realpath "$RUNNER_TOOL_CACHE")"/node/20.20.2/x64 ]]
[[ "$("$node" --version)" == v20.20.2 ]]
node_sha=$(sha256sum "$node" | cut -d' ' -f1)
# Fresh checkouts must not retain HTTP auth headers or credential helpers.
for repo in "$baseline" "$GITHUB_WORKSPACE/harness"; do
  names=$(git -C "$repo" config --local --name-only --list)
  if grep -Eiq '(^credential\.|\.extraheader$)' <<<"$names"; then
    echo 'refuse repository with retained credential configuration' >&2
    exit 1
  fi
done
test ! -e "$baseline/node_modules"
docker info --format '{{.OSType}} {{.Architecture}}' | grep -Ex 'linux (x86_64|amd64)'
tag=mcr.microsoft.com/playwright:v1.58.2-noble
index=$(timeout 45s docker buildx imagetools inspect --format '{{json .Manifest}}' "$tag")
index_pin=sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
jq -e --arg pin "$index_pin" '.digest==$pin' <<<"$index" >/dev/null
digest=$(jq -er '[.manifests[]|select(.platform.os=="linux" and .platform.architecture=="amd64" and ((.platform.variant//"")==""))]|if length==1 then .[0].digest else error("ambiguous amd64 child") end' <<<"$index")
[[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
image=mcr.microsoft.com/playwright@"$digest"
printf 'Official index=%s linux/amd64=%s\n' "$index_pin" "$digest"
timeout 180s docker pull --platform linux/amd64 "$image"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]]
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -Fx "$image" >/dev/null
out="$RUNNER_TEMP/salem-ui/results"
mkdir -m 0700 "$RUNNER_TEMP/salem-ui" "$out"
cid=
cleanup() { [[ -z $cid ]] || docker rm -f "$cid" >/dev/null; }
trap cleanup EXIT
cid=$(docker create --pull=never --platform linux/amd64 --network=none \
  --read-only --init --user "$(id -u):$(id -g)" --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=256 --shm-size=768m --memory=6g --cpus=2 \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m,mode=1777 \
  --tmpfs /work:rw,exec,nosuid,nodev,size=5g,mode=1777 \
  --mount "type=bind,source=$baseline,target=/in-baseline,readonly" \
  --mount "type=bind,source=$harness,target=/in-qa,readonly" \
  --mount "type=bind,source=$store,target=/in-store,readonly" \
  --mount "type=bind,source=$node_root,target=/in-node,readonly" \
  --mount "type=bind,source=$out,target=/handoff" \
  --entrypoint /usr/bin/env "$image" -i PATH=/in-node/bin:/usr/bin:/bin \
    HOME=/work/home OUTPUT=/work/output BASELINE=/work/baseline HARNESS=/in-qa STORE=/work/store \
    HOST_NET="$(readlink /proc/self/ns/net)" NODE_SHA="$node_sha" \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright LANG=C.UTF-8 TZ=UTC CI=1 PYTHONNOUSERSITE=1 \
    /bin/bash /in-qa/isolate.sh)
docker inspect "$cid" | jq -e '.[0] |
  (.HostConfig.NetworkMode=="none") and (.HostConfig.Privileged==false) and
  (.HostConfig.ReadonlyRootfs==true) and ((.HostConfig.PortBindings//{})=={}) and
  ([.Mounts[]|select(.Type=="bind")|[.Destination,.RW]]|sort)==
    [["/handoff",true],["/in-baseline",false],["/in-node",false],["/in-qa",false],["/in-store",false]]' >/dev/null
timeout --signal=TERM --kill-after=10s 720s docker start --attach "$cid"
test "$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$cid")" = 'exited 0'
