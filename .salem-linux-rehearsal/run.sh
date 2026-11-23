#!/bin/sh
# Dormant until the exact clean service ID is pinned and the entrypoint enabled.
set -eu
test "${RAILWAY_PROJECT_ID-}" = 84f1f0bc-7a7e-455c-9cc1-46053937c499
test "${RAILWAY_ENVIRONMENT_ID-}" = 772c7465-ea8d-4647-b20d-4e24f8281e72
test "${RAILWAY_SERVICE_ID-}" = 4a7d81d4-0730-4152-ae0f-7b7a2db3e730
test -z "${REHEARSAL_DATABASE_URL-}${DATABASE_URL-}${LEDGER_OWNER_DATABASE_URL-}"
exec env -i HOME=/tmp PATH=/usr/lib/postgresql/18/bin:/usr/local/bin:/usr/bin:/bin  /usr/bin/timeout -k 15s 420s /bin/sh /opt/salem/fixture/local-db.sh
