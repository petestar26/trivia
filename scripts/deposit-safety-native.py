#!/usr/bin/env python3
"""Disposable native PostgreSQL SQL-boundary tests; no Prisma or external DB URL.

Requires an already available postgres:16 image and the managed local Docker socket.
Creates a network-isolated tmpfs container, applies the full migration chain, runs
synthetic SQL/real multi-connection tests, then destroys only its own container.
This is not an HTTP/service or end-to-end ledger test.
"""
import concurrent.futures
import os
import re
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
ENV = {k: v for k, v in os.environ.items() if k not in {
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}}
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
NAME = 'deposit-safety-' + uuid.uuid4().hex[:12]
DB = 'deposit_audit_throwaway'


def docker(*args, **kwargs):
    return subprocess.run(DOCKER + list(args), env=ENV, text=True,
                          capture_output=True, **kwargs)


def sql(statement, ok=True, transaction=False):
    args = ['exec', '-i', NAME, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
            '-U', 'postgres', '-d', DB]
    if transaction:
        args += ['--single-transaction']
    result = docker(*args, input=statement, timeout=30)
    if ok and result.returncode:
        raise AssertionError(result.stderr)
    return result


def rejected(statement, message):
    result = sql(statement, ok=False)
    assert result.returncode and message in result.stderr, result.stdout + result.stderr


def scalar(statement):
    return sql(statement).stdout.strip()


def account(name, status='APPROVED'):
    sql(f'''INSERT INTO agent_payment_accounts
      (id,"agentId","countryId","methodDefId","accountDetails",status,"updatedAt")
      VALUES ('{name}','agent','country','method','{{"number":"original"}}','{status}',now());''')


def order_sql(name, account_id, status='CREATED'):
    return f'''INSERT INTO agent_orders
      (id,"orderNumber","userId","agentId","countryId","paymentMethodDefId",
       "paymentAccountId","paymentSnapshot","fiatAmount","fiatCurrency",
       "exchangeRateConfigId","exchangeRateValue","coinAmount",status,"idempotencyKey","updatedAt")
      VALUES ('{name}','SYN-{name}','buyer','agent','country','method','{account_id}',
        '{{"number":"original"}}',100,'ETB','synthetic-rate',1,100,'{status}','{name}',now());'''


def wait_sleep(application):
    # Barrier based on the backend actually holding its row lock, not a blind delay.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if scalar(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{application}' AND wait_event='PgSleep'") == '1':
            return
        time.sleep(.02)
    raise AssertionError('Native transaction barrier not reached')


def run():
    assert docker('image', 'inspect', 'postgres:16').returncode == 0, 'postgres:16 must already be available'
    started = docker('run', '-d', '--name', NAME, '--network', 'none',
                     '--tmpfs', '/var/lib/postgresql/data',
                     '-e', 'POSTGRES_PASSWORD=synthetic-disposable-only',
                     '-e', f'POSTGRES_DB={DB}', 'postgres:16')
    assert started.returncode == 0, started.stderr
    try:
        for _ in range(100):
            startup = docker('logs', NAME)
            initialized = 'PostgreSQL init process complete; ready for start up.' in startup.stdout
            if initialized and docker('exec', NAME, 'pg_isready', '-U', 'postgres', '-d', DB).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise AssertionError('PostgreSQL did not become ready')
        print('SERVER', scalar('SELECT version()'), flush=True)
        migrations = sorted((ROOT / 'packages/database/prisma/migrations').glob('*/migration.sql'))
        for migration in migrations:
            sql(migration.read_text(), transaction=True)
        print(f'PASS full migration chain: {len(migrations)} migrations', flush=True)
        # Execute the production I3 search-path predicate verbatim, including
        # privileged/SECURITY DEFINER/cascade classification AND ordinary ELSE.
        checker = (ROOT / 'apps/api/src/economy/ledger-invariant-checker.ts').read_text()
        names = []
        for constant in ('PRIVILEGED_APPROVAL_FUNCTIONS', 'STRICT_SCHEDULED_FUNCTIONS'):
            body = re.search(r'const ' + constant + r'[^=]*= \[(.*?)\];', checker, re.S).group(1)
            body = re.sub(r'//[^\n]*', '', body)
            names.extend(re.findall(r"'([^']+)'", body))
        approval_sql = 'ARRAY[' + ','.join("'" + name + "'" for name in names) + ']::text[]'
        path_query = checker.split("      SELECT 'search_path:'", 1)[1].split('      UNION ALL', 1)[0]
        path_query = "SELECT 'search_path:'" + path_query
        path_query = path_query.replace('${privilegedApprovalFunctionsSql}', approval_sql)
        assert '${' not in path_query
        assert scalar(path_query) == '', scalar(path_query)
        assert scalar("""SELECT count(*) FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE 'deposit_%' AND NOT p.prosecdef""") == '8'
        # Prove both wrong-way pins are detected, then roll back each mutation.
        for name, wrong in [('deposit_revision_insert', 'pg_catalog,pg_temp'),
                            ('deposit_recovery_safety', 'pg_catalog,pg_temp'),
                            ('deposit_account_revision', 'public,pg_temp')]:
            findings = scalar(f'BEGIN; ALTER FUNCTION public.{name}() SET search_path={wrong}; '
                              + path_query + '; ROLLBACK;')
            assert findings == f'search_path:{name}()', findings
        assert scalar(path_query) == ''
        print('PASS complete production I3 search-path CASE (all schema functions); both branches detect wrong pins with rollback', flush=True)
        sql('''INSERT INTO users (id,username,"updatedAt") VALUES
          ('buyer','synthetic-buyer',now()),('agent-user','synthetic-agent',now()),('reviewer','synthetic-reviewer',now());
          INSERT INTO countries (id,code,name,"currencyCode","updatedAt") VALUES ('country','SYN','Synthetic only','ETB',now());
          INSERT INTO agents (id,"userId","countryId","displayName","contactEmail","updatedAt")
          VALUES ('agent','agent-user','country','Synthetic agent','synthetic@example.test',now());
          INSERT INTO payment_method_definitions (id,"countryId",type,name,"fieldSchema","updatedAt")
          VALUES ('method','country','BANK_TRANSFER','Synthetic method','{"requiredFields":["number"]}',now());
          CREATE TABLE synthetic_side_effects (label text);
          CREATE ROLE synthetic_runtime NOLOGIN;
          GRANT USAGE ON SCHEMA public TO synthetic_runtime;
          GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON agent_payment_accounts,agent_payment_account_revisions,
            agent_orders,late_payment_cases,agent_reservations,agent_order_settlements,disputes TO synthetic_runtime;''')

        account('revision')
        sql(order_sql('open', 'revision') + order_sql('paid', 'revision', 'PAYMENT_SUBMITTED'))
        sql('''UPDATE agent_payment_accounts SET "accountDetails"='{"number":"replacement"}' WHERE id='revision';''')
        rejected(order_sql('paused', 'revision'), 'not approved')
        sql("UPDATE agent_payment_accounts SET status='APPROVED' WHERE id='revision'")
        assert scalar('''SELECT count(*) FROM agent_orders WHERE id IN ('open','paid')
          AND "paymentAccountRevision"=1 AND "paymentSnapshot"='{"number":"original"}'::jsonb''') == '2'
        assert scalar('''SELECT count(*) FROM agent_payment_account_revisions WHERE "accountId"='revision' ''') == '2'
        rejected("SET ROLE synthetic_runtime; UPDATE agent_payment_account_revisions SET revision=99", 'immutable')
        rejected("SET ROLE synthetic_runtime; DELETE FROM agent_payment_account_revisions", 'immutable')
        rejected("SET ROLE synthetic_runtime; TRUNCATE agent_payment_account_revisions", 'immutable')
        rejected('''SET ROLE synthetic_runtime; INSERT INTO agent_payment_account_revisions
          ("accountId",revision,"agentId","countryId","methodDefId","accountDetails")
          VALUES ('revision',99,'agent','country','method','{}')''', 'current approved destination')
        rejected("SET ROLE synthetic_runtime; DELETE FROM agent_payment_accounts WHERE id='revision'", 'immutable')
        rejected("SET ROLE synthetic_runtime; TRUNCATE agent_payment_accounts", 'immutable')
        for state in ['CREATED','PAYMENT_SUBMITTED','COMPLETED']:
            rejected(order_sql('missing-' + state, 'absent', state), 'missing')
        print('PASS immutable revisions, direct forgery/deletion denial and no synthetic admission bypass', flush=True)

        account('unsafe')
        sql(order_sql('held', 'unsafe', 'DISPUTE') + order_sql('late', 'unsafe', 'CANCELLED'))
        sql('''INSERT INTO agent_reservations (id,"orderId","agentId",amount) VALUES ('reservation','held','agent',100);
          INSERT INTO disputes (id,"orderId","openedBy",reason,description,status,"assignedAdminId")
          VALUES ('dispute','held','buyer','OTHER','Synthetic investigation','ASSIGNED','reviewer');
          INSERT INTO late_payment_cases (id,"orderId","openedBy","idempotencyKey","paymentReference","paidAmount","paidAt",description)
          VALUES ('late-case','late','buyer','synthetic-key','SYNTHETIC',100,now(),'Synthetic late report');
          UPDATE late_payment_cases SET status='ASSIGNED',"assignedAdminId"='reviewer',"assignedAt"=now() WHERE id='late-case';
          UPDATE agent_payment_accounts SET status='DISABLED' WHERE id='unsafe';''')
        assert scalar('SELECT "safetyHold" FROM agent_orders WHERE id=\'held\'') == 't'
        assert scalar("SELECT status FROM disputes WHERE id='dispute'") == 'ASSIGNED'
        for state in ['COMPLETED','CANCELLED','EXPIRED','PAYMENT_SUBMITTED']:
            rejected(f"UPDATE agent_orders SET status='{state}' WHERE id='held'", 'safety hold')
        rejected("UPDATE agent_reservations SET status='RELEASED' WHERE id='reservation'", 'safety hold')
        rejected("UPDATE disputes SET status='RESOLVED' WHERE id='dispute'", 'safety hold')
        rejected('''INSERT INTO agent_order_settlements
          (id,"orderId","reservationId","coinAmount","walletTransactionId","resolvedVia","releasedBy")
          VALUES ('blocked-settlement','held','reservation',100,'synthetic-wallet','AGENT_RELEASE','agent-user')''', 'safety hold')
        for state in ['REJECTED','REFUNDED']:
            rejected(f"UPDATE late_payment_cases SET status='{state}' WHERE id='late-case'", 'safety hold')
        rejected('UPDATE agent_payment_accounts SET "safetyHold"=false WHERE id=\'unsafe\'', 'separately approved policy')
        rejected('UPDATE agent_orders SET "safetyHold"=false WHERE id=\'held\'', 'separately approved policy')
        rejected("BEGIN; INSERT INTO synthetic_side_effects VALUES ('must-rollback'); UPDATE disputes SET status='RESOLVED' WHERE id='dispute'; COMMIT;", 'safety hold')
        assert scalar('SELECT count(*) FROM synthetic_side_effects') == '0'
        print('PASS independent holds on order, reservation, settlement, dispute and terminal-order recovery; rollback', flush=True)

        # P1: rejected replacement details must not remove the safety-disable path
        # for an older approved revision that still has a paid order.
        account('rejected-replacement')
        sql(order_sql('rejected-pinned', 'rejected-replacement', 'PAYMENT_SUBMITTED'))
        sql('''UPDATE agent_payment_accounts SET "accountDetails"='{"number":"rejected-new"}' WHERE id='rejected-replacement';
          UPDATE agent_payment_accounts SET status='REJECTED' WHERE id='rejected-replacement';''')
        token = scalar('SELECT "updatedAt"::text FROM agent_payment_accounts WHERE id=\'rejected-replacement\'')
        sql(f'''UPDATE agent_payment_accounts SET "safetyHold"=true
          WHERE id='rejected-replacement' AND "updatedAt"='{token}' AND "safetyHold"=false;''')
        assert scalar('SELECT status,"safetyHold" FROM agent_payment_accounts WHERE id=\'rejected-replacement\'') == 'REJECTED|t'
        assert scalar('''SELECT "paymentAccountRevision","paymentSnapshot","safetyHold" FROM agent_orders WHERE id='rejected-pinned' ''') == '1|{"number": "original"}|t'
        rejected("UPDATE agent_orders SET status='COMPLETED' WHERE id='rejected-pinned'", 'safety hold')
        assert scalar(f'''WITH loser AS (UPDATE agent_payment_accounts SET "safetyHold"=true
          WHERE id='rejected-replacement' AND "updatedAt"='{token}' AND "safetyHold"=false RETURNING id)
          SELECT count(*) FROM loser''') == '0'
        print('PASS P1 approved -> pinned paid order -> edit -> rejection -> independent safety disable -> settlement denied', flush=True)

        # P1: the bounded sweep must select past >=200 older held orders.
        account('starvation-held'); account('starvation-eligible')
        sql(''.join(order_sql(f'starved-held-{i}', 'starvation-held') for i in range(200))
            + order_sql('starved-eligible', 'starvation-eligible'))
        sql('''UPDATE agent_orders SET "createdAt"='2000-01-01' WHERE "paymentAccountId"='starvation-held';
          UPDATE agent_orders SET "createdAt"='2001-01-01' WHERE id='starved-eligible';
          UPDATE agent_payment_accounts SET "safetyHold"=true WHERE id='starvation-held';
          INSERT INTO agent_reservations (id,"orderId","agentId",amount)
          SELECT 'reservation-'||id,id,'agent',100 FROM agent_orders
          WHERE "paymentAccountId" IN ('starvation-held','starvation-eligible');''')
        snapshot_query = '''SELECT jsonb_agg(to_jsonb(o) ORDER BY id)::text FROM agent_orders o
          WHERE "paymentAccountId"='starvation-held' '''
        held_before = scalar(snapshot_query)
        reservation_snapshot = "SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM agent_reservations r WHERE id LIKE 'reservation-starved-held-%'"
        reservations_before = scalar(reservation_snapshot)
        sql('''WITH candidates AS (
          SELECT id FROM agent_orders WHERE status='CREATED' AND "safetyHold"=false
          ORDER BY "createdAt", id LIMIT 200
        ) UPDATE agent_orders o SET status='EXPIRED'
          FROM candidates c WHERE o.id=c.id AND o.status='CREATED' AND NOT o."safetyHold"
          AND o."createdAt" < now()-interval '15 minutes';''')
        assert scalar("SELECT status FROM agent_orders WHERE id='starved-eligible'") == 'EXPIRED'
        assert scalar(snapshot_query) == held_before
        assert scalar(reservation_snapshot) == reservations_before
        assert scalar("SELECT count(*) FROM agent_reservations WHERE id LIKE 'reservation-starved-held-%' AND status='ACTIVE'") == '200'
        assert scalar('''SELECT count(*) FROM agent_orders WHERE "paymentAccountId"='starvation-held'
          AND status='CREATED' AND "safetyHold"''') == '200'
        print('PASS P1 expiry progresses beyond 200 held expired rows; all held rows remain byte-equivalent', flush=True)

        # All concurrent SQL is on separate native PostgreSQL backend sessions.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            account('create-first')
            first = pool.submit(sql, '''SET application_name='create-first'; BEGIN;
              SELECT id FROM agent_payment_accounts WHERE id='create-first' FOR SHARE;
              SELECT pg_sleep(1);''' + order_sql('race-created','create-first') + 'COMMIT;')
            wait_sleep('create-first')
            second = pool.submit(sql, "UPDATE agent_payment_accounts SET \"safetyHold\"=true WHERE id='create-first'")
            first.result(); second.result()
            assert scalar('SELECT "safetyHold" FROM agent_orders WHERE id=\'race-created\'') == 't'
            account('disable-first')
            first = pool.submit(sql, "SET application_name='disable-first'; BEGIN; UPDATE agent_payment_accounts SET \"safetyHold\"=true WHERE id='disable-first'; SELECT pg_sleep(1); COMMIT;")
            wait_sleep('disable-first')
            second = pool.submit(sql, order_sql('race-denied','disable-first'), False)
            first.result()
            loser = second.result()
            assert loser.returncode and 'not approved' in loser.stderr
            assert scalar("SELECT count(*) FROM agent_orders WHERE id='race-denied'") == '0'
            print('PASS native creation/disable serialization in both commit orders', flush=True)

            account('version', 'PENDING_APPROVAL')
            sql('UPDATE agent_payment_accounts SET "updatedAt"=\'2099-01-01\' WHERE id=\'version\'')
            token = scalar('SELECT "updatedAt"::text FROM agent_payment_accounts WHERE id=\'version\'')
            claim = f'''WITH winner AS (UPDATE agent_payment_accounts SET status='APPROVED',"updatedAt"='{token}'
              WHERE id='version' AND "updatedAt"='{token}' RETURNING id)
              INSERT INTO synthetic_side_effects SELECT id FROM winner;'''
            first = pool.submit(sql, "SET application_name='version-first'; BEGIN;" + claim + 'SELECT pg_sleep(1); COMMIT;')
            wait_sleep('version-first')
            second = pool.submit(sql, claim)
            first.result(); second.result()
            assert scalar("SELECT count(*) FROM synthetic_side_effects WHERE label='version'") == '1'
            assert scalar('''SELECT "updatedAt"='2099-01-01 00:00:00.001'::timestamp FROM agent_payment_accounts WHERE id='version' ''') == 't'
            assert scalar('''SELECT count(*) FROM agent_payment_account_revisions WHERE "accountId"='version' ''') == '1'
            print('PASS native competing same-version approval: one winner, one revision, one side effect, +1ms token', flush=True)

            for name, first_write, second_write, expected in [
                ('edit-review', '\"accountDetails\"=\'{"number":"edited"}\'', "status='APPROVED'", 'PENDING_APPROVAL|f|0'),
                ('review-disable', "status='APPROVED'", '"safetyHold"=true', 'APPROVED|f|1'),
                ('disable-review', '"safetyHold"=true', "status='APPROVED'", 'PENDING_APPROVAL|t|0'),
            ]:
                account(name, 'PENDING_APPROVAL')
                token = scalar(f'SELECT "updatedAt"::text FROM agent_payment_accounts WHERE id=\'{name}\'')
                def operation(write):
                    return f'''WITH winner AS (UPDATE agent_payment_accounts SET {write}
                      WHERE id='{name}' AND "updatedAt"='{token}' RETURNING id)
                      INSERT INTO synthetic_side_effects SELECT id FROM winner;'''
                first = pool.submit(sql, f"SET application_name='{name}'; BEGIN;" + operation(first_write) + 'SELECT pg_sleep(1); COMMIT;')
                wait_sleep(name)
                second = pool.submit(sql, operation(second_write))
                first.result(); second.result()
                assert scalar(f"SELECT count(*) FROM synthetic_side_effects WHERE label='{name}'") == '1'
                assert scalar(f'SELECT status,"safetyHold","approvedRevision" FROM agent_payment_accounts WHERE id=\'{name}\'') == expected
            print('PASS native edit/review, review/disable and disable/review losers leave no side effects', flush=True)
        print('PASS native SQL audit complete; Prisma/service/HTTP checks remain separate', flush=True)
    finally:
        removed = docker('rm', '-f', NAME)
        assert removed.returncode == 0, removed.stderr


if __name__ == '__main__':
    run()
