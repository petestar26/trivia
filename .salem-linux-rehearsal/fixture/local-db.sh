#!/bin/sh
set -eu
umask 077
root=$(mktemp -d /tmp/salem-near-db.XXXXXX)
started=0
stage=init
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    printf 'SALEM_NEAR_DB_STOP_STAGE=%s EXIT=%s\n' "$stage" "$result"
  fi
  if [ "$started" = 1 ]; then
    if pg_ctl -D "$root/data" stop -m fast -w -t 10 > /dev/null 2>&1; then
      echo SALEM_DISPOSABLE_DB_STOPPED
    else
      echo SALEM_DISPOSABLE_DB_STOP_UNCONFIRMED
    fi
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
s=/opt/salem/source
f=/opt/salem/fixture
echo SALEM_NEAR_DB_SYNTHETIC_RUN
nonce=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')
owner=salem_etb_boot_$nonce
db=salem_backing_$nonce
pw=$(node -e 'console.log(require("crypto").randomBytes(25).toString("hex"))')
rp=$(node -e 'console.log(require("crypto").randomBytes(25).toString("hex"))')
printf '%s\n' "$pw" >"$root/boot"
stage=initdb
initdb -D "$root/data" -U "$owner" --auth-local=scram-sha-256 --auth-host=scram-sha-256 --pwfile="$root/boot" --no-locale --encoding=UTF8 >"$root/init.log" 2>&1
rm "$root/boot"
stage=start-db
pg_ctl -D "$root/data" -l "$root/pg.log" -o "-k $root -h 127.0.0.1 -p 55448 -c ssl=off" -w -t 15 start >/dev/null
started=1
export PGHOST=127.0.0.1 PGPORT=55448 PGUSER="$owner" PGPASSWORD="$pw" PGCONNECT_TIMEOUT=5
export PGOPTIONS='-c statement_timeout=120000 -c lock_timeout=10000'
stage=version
test "$(psql -XwqAt -d postgres -c 'SHOW server_version_num')" = 180006
stage=create-db
createdb "$db"
export PGDATABASE="$db"
stage=create-role
printf "CREATE ROLE playqube_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '%s';\n" "$rp" |
  psql -Xwq -v ON_ERROR_STOP=1 >"$root/role.log" 2>&1
export DATABASE_URL="postgresql://$owner:$pw@127.0.0.1:55448/$db?sslmode=disable&connect_timeout=5&options=-c%20lock_timeout%3D10s"
stage=verify-source-pins
(cd "$s/packages/database/prisma/migrations" && sha256sum -c "$f/MIGRATIONS.SHA256") >"$root/pins.log" 2>&1
cd "$s"
stage=migrate
node packages/database/node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma >"$root/migrate.log" 2>&1
sed -E 's!^([a-f0-9]{64})  ([^/]+).*$!\2|\1|t|t!' "$f/MIGRATIONS.SHA256" >"$root/expected"
stage=migration-history
psql -XwqAt -v ON_ERROR_STOP=1 -c 'SELECT migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NULL FROM public._prisma_migrations ORDER BY migration_name COLLATE "C"' >"$root/actual"
cmp -s "$root/expected" "$root/actual"
test "$(wc -l < "$root/actual" | tr -d ' ')" = 133
echo SALEM_NEAR_DB_MIGRATIONS_PASS_133
stage=canonical-grants
key=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
runtime_url="postgresql://playqube_app:$rp@127.0.0.1:55448/$db?sslmode=disable&connect_timeout=5&options=-c%20lock_timeout%3D10s"
owner_url="$DATABASE_URL"
DATABASE_URL="$runtime_url" LEDGER_OWNER_DATABASE_URL="$owner_url" LEDGER_RUNTIME_ROLE=playqube_app   LEDGER_APPROVAL_SIGNING_KEY="$key" LEDGER_APPROVAL_KEY_ID=fixture-rollback   node /opt/salem/fallback/apps/api/dist/scripts/ledger-runtime-access.js --json > "$root/grants.log" 2>&1
echo SALEM_FALLBACK_CANONICAL_RUNTIME_GRANTS_PASS
export LEDGER_APPROVAL_SIGNING_KEY="$key" ETB_SYNTHETIC_LOG_ROOT="$root"
stage=atomic-dormant-install
psql -Xwq -v ON_ERROR_STOP=1 -f "$f/20261123_01_etb_funding_dormant.sql" >"$root/atomic.log" 2>&1
dormant=$(psql -XwqAt -v ON_ERROR_STOP=1 -c "SELECT version FROM deposit_capacity_review.install_receipt CROSS JOIN deposit_capacity_review.release_switch WHERE NOT funding_open AND NOT managed_admission_open AND NOT EXISTS(SELECT FROM staff_access.main_admin)")
test "$dormant" = 20261123_01_etb_funding_dormant
echo SALEM_ATOMIC_DORMANT_INSTALL_PASS
stage=runtime-client-and-http
env -i HOME="$root" PATH="$PATH" DATABASE_URL="$runtime_url" LEDGER_APPROVAL_SIGNING_KEY="$key" node /opt/salem/fixture/smoke.cjs "$root"
echo SALEM_EXACT_LINUX_API_AND_FALLBACK_PASS
