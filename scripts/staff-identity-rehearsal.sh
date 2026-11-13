#!/usr/bin/env bash
# Staff identity rehearsal: DISPOSABLE LOCAL POSTGRESQL ONLY.
#
# Repeatable setup, verification, rollback and recovery of the dormant staff
# identity layout (docs/deployment/staff-identity-runbook.md) in a throwaway
# database it creates and removes itself. Synthetic roles, keys and accounts
# only; nothing is printed that could be a credential.
#
#   pnpm --filter api build        # the preDeploy checks run from apps/api/dist
#   STAFF_REHEARSAL_ACK=disposable \
#   REHEARSAL_ADMIN_URL=postgresql://<admin>:<password>@127.0.0.1:<port>/postgres \
#     scripts/staff-identity-rehearsal.sh
#
# Refuses any host other than 127.0.0.1/localhost, any run without the
# acknowledgement, and any run inside a deployment environment. It only ever
# creates or drops the database staff_identity_rehearsal_throwaway and roles
# named sir_*. Set REHEARSAL_KEEP=1 to keep them for inspection.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=staff_identity_rehearsal_throwaway
BOUNDARY="$ROOT/docs/deployment/staff-member-status-boundary.sql"
ISSUANCE="$ROOT/docs/deployment/owner-password-reset-issuance.sql"
INVENTORY="$ROOT/docs/deployment/staff-identity-inventory.sql"
SIG='public.staff_set_member_status(text, text, text, text, text, integer, text, text, text, text)'

refuse() { echo "REFUSED: $*" >&2; exit 2; }
[[ "${STAFF_REHEARSAL_ACK:-}" == disposable ]] || refuse 'set STAFF_REHEARSAL_ACK=disposable'
[[ -z "${RAILWAY_ENVIRONMENT:-}${RAILWAY_ENVIRONMENT_ID:-}${RAILWAY_PROJECT_ID:-}" ]] || refuse 'deployment environment detected'
ADMIN_URL="${REHEARSAL_ADMIN_URL:-}"
# shellcheck disable=SC2016  # ${...} below is a JavaScript template literal
HOSTPORT="$(node -e '
  const u = new URL(process.argv[1]);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !["127.0.0.1", "localhost"].includes(u.hostname)
      || u.pathname !== "/postgres") process.exit(3);
  console.log(`${u.hostname} ${u.port || 5432}`);' "$ADMIN_URL" 2>/dev/null)" \
  || refuse 'REHEARSAL_ADMIN_URL must be postgres(ql)://…@127.0.0.1|localhost[:port]/postgres'
read -r HOST PORT <<<"$HOSTPORT"
for tool in psql openssl node pnpm; do command -v "$tool" >/dev/null || refuse "$tool is required"; done
[[ "$(psql --version | grep -oE '[0-9]+' | head -1)" -ge 16 ]] || refuse 'psql 16 or later is required (\bind keeps keys out of server logs)'
for f in ledger-runtime-identity-check ledger-upgrade-preflight; do
  [[ -f "$ROOT/apps/api/dist/scripts/$f.js" ]] || refuse "build first: apps/api/dist/scripts/$f.js is missing"
done

[[ "$(psql "$ADMIN_URL" -X -Atc 'SHOW server_version_num')" -ge 160000 ]] \
  || refuse 'PostgreSQL 16 or later is required (membership SET/INHERIT options)'

WORK="$(mktemp -d)"; chmod 700 "$WORK"
rand() { openssl rand -hex "$1"; }
declare -A PW=([owner]='' [migrator]="$(rand 24)" [runtime]="$(rand 24)" [staff]="$(rand 24)")
STATUS_KEY="$(rand 32)"; STATUS_KEY_ID="rehearsal-$(rand 4)"
LEDGER_KEY="$(rand 32)"; LEDGER_KEY_ID=primary
step=0
pass() { step=$((step + 1)); printf 'PASS %02d %s\n' "$step" "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

admin() { psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
as() {  # as <login> [psql args...]: connects to the rehearsal database
  local who="$1"; shift
  PGPASSWORD="${PW[$who]}" psql "host=$HOST port=$PORT dbname=$DB user=sir_$who" -X -q -v ON_ERROR_STOP=1 "$@"
}
url() { printf 'postgresql://sir_%s:%s@%s:%s/%s' "$1" "${PW[$1]}" "$HOST" "$PORT" "$DB"; }
install_boundary() { as migrator -f "$BOUNDARY" 2>"$WORK/install.err" || { cat "$WORK/install.err" >&2; fail 'boundary install'; }; }
install_issuance() { as migrator -f "$ISSUANCE" 2>"$WORK/install.err" || { cat "$WORK/install.err" >&2; fail 'reset issuance install'; }; }
# Keys go in as bind parameters: a failing install logs "$1, $2", never the key.
install_key() {  # install_key <function> <key id> <hex key>
  # shellcheck disable=SC2016  # $1/$2 are SQL placeholders, not shell variables
  printf 'SELECT %s($1, decode($2, '"'hex'"')) \\bind %s %s \\g\n' "$1" "$2" "$3" | as migrator -At -f - >/dev/null
}
inventory() { as migrator -At -F '|' -f "$INVENTORY" | grep -v '^session|' > "$WORK/$1.inv"; }
changed() { diff "$WORK/$1.inv" "$WORK/$2.inv" | grep -E '^[<>]' || true; }

teardown() {
  admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" 2>/dev/null || true
  for r in staff runtime migrator owner; do admin -c "DROP ROLE IF EXISTS sir_$r" 2>/dev/null || true; done
}
cleanup() { [[ "${REHEARSAL_KEEP:-}" == 1 ]] || teardown; rm -rf "$WORK"; }
trap cleanup EXIT

# 1. Setup: the non-superuser ownership layout (database-ownership-assessment.md).
teardown
admin -c "CREATE ROLE sir_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
for r in migrator runtime staff; do
  printf "CREATE ROLE sir_%s LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$r" "${PW[$r]}" \
    | admin -f -
done
admin -c "GRANT sir_owner TO sir_migrator WITH INHERIT FALSE, SET TRUE" \
      -c "ALTER ROLE sir_migrator SET role = 'sir_owner'" \
      -c "CREATE DATABASE $DB OWNER sir_owner"
as migrator -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
[[ "$(as migrator -Atc "SELECT current_user || ',' || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)")" == sir_owner,false ]] \
  || fail 'migrator must act as the non-superuser owner'
pass 'roles: NOLOGIN non-superuser owner, SET-only migrator, runtime and staff logins'

(cd "$ROOT" && DATABASE_URL="$(url migrator)" pnpm --filter @socialplay/database exec prisma migrate deploy >"$WORK/migrate.log" 2>&1) \
  || { tail -20 "$WORK/migrate.log"; fail 'migrations as the non-superuser owner'; }
pass 'all migrations applied by the non-superuser owner'

as migrator -Atc "SELECT public.ledger_apply_runtime_grants('sir_runtime')" >/dev/null
install_key public.ledger_install_approval_key "$LEDGER_KEY_ID" "$LEDGER_KEY"
pass 'runtime grants and ledger approval key installed by the owner'

preflight() {  # the API's preDeployCommand checks, as the runtime login
  local runtime_url access refresh
  runtime_url="$(url runtime)"; access="$(rand 32)"; refresh="$(rand 32)"
  (cd "$ROOT" && export DATABASE_URL="$runtime_url" LEDGER_RUNTIME_ROLE=sir_runtime \
     JWT_ACCESS_SECRET="$access" JWT_REFRESH_SECRET="$refresh" \
     LEDGER_APPROVAL_SIGNING_KEY="$LEDGER_KEY" LEDGER_APPROVAL_KEY_ID="$LEDGER_KEY_ID" NODE_ENV=production LOG_PRETTY=false &&
   node apps/api/dist/scripts/ledger-runtime-identity-check.js &&
   pnpm --filter @socialplay/database exec prisma migrate status &&
   node apps/api/dist/scripts/ledger-upgrade-preflight.js) >"$WORK/preflight.log" 2>&1 \
    || { tail -20 "$WORK/preflight.log"; fail "preDeploy checks ($1)"; }
  (cd "$ROOT" && DATABASE_URL="$(url migrator)" LEDGER_RUNTIME_ROLE=sir_migrator \
     node apps/api/dist/scripts/ledger-runtime-identity-check.js) >/dev/null 2>&1 \
    && fail "identity check accepted the owner credential ($1)"
  return 0
}
preflight baseline
pass 'preDeploy checks pass as runtime and refuse the owner credential (baseline)'
inventory baseline
grep -q '^reach|sir_runtime|superuser=false,member_of_users_owner=false,can_set_users_owner=false' "$WORK/baseline.inv" \
  || fail 'runtime must not reach the users owner'
grep -q '^reach|sir_migrator|superuser=false,member_of_users_owner=true,can_set_users_owner=true' "$WORK/baseline.inv" \
  || fail 'migrator must reach the owner only through SET'
pass 'baseline inventory recorded; runtime reaches no owner'

# 2. Install the status boundary and the reset issuance records (no grants);
#    verify they change nothing else.
install_boundary; install_issuance
inventory installed
unexpected="$(changed baseline installed \
  | grep -vE 'staff_status_approval|staff_set_member_status|owner_password_reset|^[<>] owner\|objects in public\|' || true)"
[[ -z "$unexpected" ]] || { echo "$unexpected"; fail 'install changed something outside the boundary and issuance records'; }
changed baseline installed | grep -E '^[<>] grant\|' && fail 'install granted something'
install_boundary; install_issuance; inventory reinstalled
[[ -z "$(changed installed reinstalled)" ]] || fail 'reinstall is not idempotent'
pass 'boundary and reset issuance records installed by the owner: grant nothing, touch nothing else, reinstall idempotent'

# 3. Activation steps, rehearsed here only: status key, staff grants, EXECUTE.
install_key staff_status_approval.install_key "$STATUS_KEY_ID" "$STATUS_KEY"
as migrator -c "GRANT USAGE ON SCHEMA public TO sir_staff" -c "GRANT SELECT ON public.users TO sir_staff" \
            -c "GRANT EXECUTE ON FUNCTION $SIG TO sir_staff"
inventory activated
unexpected="$(changed installed activated \
  | grep -vE '^> grant\|sir_staff\||^[<>] key\||^[<>] definer\|public\.staff_set_member_status\(' || true)"
[[ -z "$unexpected" ]] || { echo "$unexpected"; fail 'activation changed more than the staff grants and key'; }
pass 'status key installed; staff granted only USAGE, SELECT on users and EXECUTE on the boundary'

# 4. Verification.
sql_q() { printf "'%s'" "${1//\'/\'\'}"; }
admin_id=00000000-0000-4000-8000-00000000a001; member_id=00000000-0000-4000-8000-00000000b001
as migrator -c "INSERT INTO users (id, username, role, \"updatedAt\") VALUES
  ('$admin_id', 'sir_admin', 'ADMIN', now()), ('$member_id', 'sir_member', 'USER', now())"
call() {  # call <signature-mode>: one boundary call as the staff login; prints the outcome
  local mode="$1" row version updated nonce expires reason='synthetic rehearsal' sig payload
  row="$(as migrator -At -F ' ' -c "SELECT (SELECT \"tokenVersion\" FROM users WHERE id = '$admin_id'),
    to_char(\"updatedAt\", 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), status FROM users WHERE id = '$member_id'")"
  read -r version updated status <<<"$row"
  local target=SUSPENDED; [[ "$status" == SUSPENDED ]] && target=ACTIVE
  nonce="${NONCE:-$(rand 32)}"; expires="$(node -e 'console.log(new Date(Date.now() + 60000).toISOString())')"
  payload="$(printf 'salem-staff-member-status/v1\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s' "$STATUS_KEY_ID" "$admin_id" "$version" \
    "$member_id" "$target" "$updated" "$(printf '%s' "$reason" | openssl dgst -sha256 -r | cut -d' ' -f1)" "$nonce" "$expires")"
  case "$mode" in
    valid) sig="$(printf '%s' "$payload" | KEY="$STATUS_KEY" node -e '
      let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () =>
        console.log(require("crypto").createHmac("sha256", Buffer.from(process.env.KEY, "hex")).update(d).digest("hex")))')" ;;
    unsigned) sig="$(printf '0%.0s' {1..64})" ;;
  esac
  as staff -At -c "SELECT outcome FROM public.staff_set_member_status($(sql_q "$STATUS_KEY_ID"), '$nonce', '$expires', '$sig',
    '$admin_id', $version, '$member_id', '$target', '$updated', $(sql_q "$reason"))" 2>&1 | head -1
}
[[ "$(call unsigned)" == APPROVAL_INVALID ]] || fail 'unsigned approval must be refused'
once="$(rand 32)"
[[ "$(NONCE="$once" call valid)" == OK ]] || fail 'signed suspension must succeed'
[[ "$(NONCE="$once" call valid)" == APPROVAL_REPLAYED ]] || fail 'replayed approval must be refused'
[[ "$(call valid)" == OK ]] || fail 'signed reactivation must succeed'
as staff -c "UPDATE users SET status = 'SUSPENDED' WHERE id = '$member_id'" 2>/dev/null && fail 'staff updated status directly'
as runtime -c "UPDATE users SET status = 'SUSPENDED' WHERE id = '$member_id'" 2>/dev/null && fail 'runtime updated status directly'
for who in staff runtime; do
  as "$who" -c 'SELECT 1 FROM staff_status_approval.keys' 2>/dev/null && fail "$who read the status key table"
  as "$who" -c 'SELECT 1 FROM owner_password_reset.issuances' 2>/dev/null && fail "$who read the reset issuance records"
  as "$who" -c "SELECT public.owner_password_reset_consume('x', 'y', 0)" 2>/dev/null && fail "$who consumed a reset record"
  as "$who" -c 'SELECT 1 FROM public.ledger_approval_keys' 2>/dev/null && fail "$who read the ledger key table"
done
as migrator -Atc "SELECT public.ledger_apply_runtime_grants('sir_runtime')" >/dev/null
as runtime -c 'SELECT 1 FROM staff_status_approval.keys' 2>/dev/null && fail 'runtime grants exposed the status key'
preflight activated
pass 'verified: forged and replayed approvals refused, signed changes work, no direct status writes, keys private, preDeploy unchanged'

# 5. Rollback level 1 (disable, keep evidence) and recovery.
evidence() { as migrator -Atc 'SELECT count(*) FROM staff_status_approval.approvals'; }
before_evidence="$(evidence)"
as migrator -c "REVOKE EXECUTE ON FUNCTION $SIG FROM sir_staff"
[[ "$(call valid)" == *'permission denied'* ]] || fail 'revoked EXECUTE must refuse'
as migrator -c "DROP FUNCTION IF EXISTS $SIG"
[[ "$(call valid)" == *'does not exist'* ]] || fail 'dropped boundary must be absent'
[[ "$(evidence)" == "$before_evidence" ]] || fail 'disabling must keep the approval evidence'
pass "disabled (EXECUTE revoked, function dropped); $before_evidence approval records kept"
install_boundary
as migrator -c "GRANT EXECUTE ON FUNCTION $SIG TO sir_staff"
[[ "$(call valid)" == OK ]] || fail 'recovery: reinstalled boundary must work with the kept key'
pass 'recovered: reinstall and re-grant; the kept key still verifies'

# 6. Key rotation: new key ID installed, old one retired.
OLD_ID="$STATUS_KEY_ID"; OLD_KEY="$STATUS_KEY"
STATUS_KEY_ID="rehearsal-$(rand 4)"; STATUS_KEY="$(rand 32)"
install_key staff_status_approval.install_key "$STATUS_KEY_ID" "$STATUS_KEY"
[[ "$(call valid)" == OK ]] || fail 'new key must verify'
as migrator -Atc "SELECT staff_status_approval.retire_key('$OLD_ID')" >/dev/null
NEW_ID="$STATUS_KEY_ID"; NEW_KEY="$STATUS_KEY"; STATUS_KEY_ID="$OLD_ID"; STATUS_KEY="$OLD_KEY"
[[ "$(call valid)" == APPROVAL_INVALID ]] || fail 'retired key must not verify'
STATUS_KEY_ID="$NEW_ID"; STATUS_KEY="$NEW_KEY"
pass 'rotated: new key verifies, retired key refused'

# 7. Rollback level 2 (full removal; destroys approval evidence, rehearsal only).
as migrator -c "REVOKE EXECUTE ON FUNCTION $SIG FROM sir_staff" -c "DROP FUNCTION IF EXISTS $SIG" \
            -c "REVOKE SELECT ON public.users FROM sir_staff" -c "REVOKE USAGE ON SCHEMA public FROM sir_staff" \
            -c "DROP SCHEMA staff_status_approval CASCADE" \
            -c "DROP FUNCTION IF EXISTS public.owner_password_reset_consume(text, text, integer)" \
            -c "DROP SCHEMA owner_password_reset CASCADE" 2>/dev/null
inventory removed
[[ -z "$(changed baseline removed)" ]] || { changed baseline removed; fail 'full removal did not restore the baseline'; }
preflight removed
pass 'fully removed: inventory identical to baseline; preDeploy checks pass'

echo "REHEARSAL PASSED ($step steps). Database and roles $( [[ "${REHEARSAL_KEEP:-}" == 1 ]] && echo kept || echo removed )."
