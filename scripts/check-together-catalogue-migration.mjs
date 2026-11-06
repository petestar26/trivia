// Run immediately after migrations on an isolated test database, before suites
// append their own administrator policies. All probes are rolled back.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const url = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
assert(!url.searchParams.has('host'));
assert(['/playqube_scheduled_throwaway', '/playqube_expansion_migration'].includes(url.pathname));
assert.equal(process.env.SCHEDULED_NATIVE_DB_ACK, 'throwaway');
const migration = readFileSync(
  new URL(
    '../packages/database/prisma/migrations/20261106020000_together_practice_catalogue/migration.sql',
    import.meta.url
  ),
  'utf8'
)
  .replace(/^BEGIN;\s*/m, '')
  .replace(/^COMMIT;\s*/m, '');
const sql = `BEGIN;
DO $$ BEGIN
 IF (SELECT max(version) FROM play_together_policies)<>2 OR
    (SELECT cardinality(enabled_games) FROM play_together_policies WHERE version=2)<>12 OR
    (SELECT cash_enabled FROM play_together_policies WHERE version=2) OR
    (SELECT cardinality(enabled_games) FROM play_together_policies WHERE version=1)<>4 OR
    EXISTS(SELECT 1 FROM platform_gates WHERE key IN ('GROUP_PLAY','CASINO_PLAY') AND enabled)
 THEN RAISE EXCEPTION 'Initial practice catalogue or cash protection mismatch'; END IF;
END $$;
${migration}
DO $$ BEGIN
 IF (SELECT count(*) FROM play_together_policies)<>2 THEN RAISE EXCEPTION 'Migration replay added a policy'; END IF;
END $$;
INSERT INTO play_together_policies(version,fee_bps,min_entry,max_entry,enabled_games,practice_enabled,cash_enabled,public_rooms_enabled)
 VALUES(3,321,200,9000,ARRAY['spin_win'],false,false,false);
${migration}
DO $$ BEGIN
 IF (SELECT count(*) FROM play_together_policies)<>3 OR
    (SELECT enabled_games FROM play_together_policies WHERE version=3)<>ARRAY['spin_win'] OR
    (SELECT fee_bps FROM play_together_policies WHERE version=3)<>321 OR
    (SELECT practice_enabled FROM play_together_policies WHERE version=3)
 THEN RAISE EXCEPTION 'Migration overwrote administrator choices'; END IF;
END $$;
ROLLBACK;`;
const result = spawnSync(process.env.PSQL ?? 'psql', [url.href, '-X', '-v', 'ON_ERROR_STOP=1'], {
  input: sql,
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr || String(result.error));
console.log(
  'PASS: twelve practice modes, unchanged cash gates, immutable previous terms, safe replay and preserved administrator policy.'
);
