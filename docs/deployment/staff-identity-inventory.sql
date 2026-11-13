-- Staff identity inventory: READ ONLY. Changes nothing, grants nothing.
--
--   psql -X -At -F '|' -v ON_ERROR_STOP=1 -f docs/deployment/staff-identity-inventory.sql
--
-- Run it as the users owner (or a member that can see every catalog) in the
-- environment being reviewed, before and after every setup step, and diff the
-- output. Each row is "section|subject|detail", sorted, so two runs diff
-- cleanly. It reads the system catalogs only, plus key IDs and dates from the
-- two key tables. It never selects a secret column, password hash, member data
-- or query text.
--
-- What it answers, for the security review:
--   identity      who is running this, and whether that login is a superuser;
--   role          every non-system role and its attributes;
--   member        every membership edge with its INHERIT/SET/ADMIN options
--                 (users_privilege_guard lets ANY member of the users owner
--                 change role/status, whatever the options);
--   reach         for every login: superuser, member of the users owner,
--                 able to SET ROLE to it, member of the database owner, and
--                 membership of predefined roles that read or write every
--                 table (pg_read_all_data, pg_write_all_data) or the server's
--                 files;
--   owner         owners of the database, of each non-system schema, and the
--                 count of objects per owner in public and
--                 staff_status_approval and owner_password_reset (extension
--                 members listed apart);
--   guard         users_privilege_guard: definition digest, owner, trigger
--                 state; boundary and append-only triggers;
--   definer       every SECURITY DEFINER function: owner, search_path, ACL;
--   grant         every privilege held by anyone but the owner on schemas,
--                 tables, columns, sequences and functions in public and
--                 staff_status_approval and owner_password_reset;
--   default_acl   default privileges that would apply to future objects;
--   extension     extensions, versions, schemas, owners;
--   key           key IDs and installed/retired dates (never the secret),
--                 and which logins could read each key table;
--   migration     applied, failed and rolled-back Prisma migrations;
--   session       open connections per login (no query text).
\set QUIET on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

-- identity
SELECT 'identity', 'server_version', current_setting('server_version_num')
UNION ALL SELECT 'identity', 'database', current_database()
UNION ALL SELECT 'identity', 'current_user', current_user::text
UNION ALL SELECT 'identity', 'session_user', session_user::text
UNION ALL SELECT 'identity', 'current_user_superuser', (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user)
UNION ALL SELECT 'identity', 'users_owner',
  COALESCE((SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.users')), '<missing>')
ORDER BY 1, 2;

-- role
SELECT 'role', r.rolname,
  concat_ws(',',
    CASE WHEN r.rolsuper THEN 'SUPERUSER' END, CASE WHEN r.rolcreaterole THEN 'CREATEROLE' END,
    CASE WHEN r.rolcreatedb THEN 'CREATEDB' END, CASE WHEN r.rolreplication THEN 'REPLICATION' END,
    CASE WHEN r.rolbypassrls THEN 'BYPASSRLS' END, CASE WHEN r.rolcanlogin THEN 'LOGIN' ELSE 'NOLOGIN' END,
    CASE WHEN r.rolinherit THEN 'INHERIT' ELSE 'NOINHERIT' END,
    'connlimit=' || r.rolconnlimit, 'valid_until=' || COALESCE(r.rolvaliduntil::text, 'none'),
    'config=' || COALESCE(array_to_string(r.rolconfig, ';'), 'none'))
FROM pg_roles r WHERE r.rolname !~ '^pg_'
ORDER BY 1, 2;

-- member: options exist from PostgreSQL 16; NULL means "not reported by this server".
SELECT 'member', m.member::regrole::text || ' -> ' || m.roleid::regrole::text,
  concat_ws(',', 'admin=' || m.admin_option,
    'inherit=' || COALESCE(to_jsonb(m) ->> 'inherit_option', 'n/a'),
    'set=' || COALESCE(to_jsonb(m) ->> 'set_option', 'n/a'),
    'grantor=' || m.grantor::regrole::text)
FROM pg_auth_members m
ORDER BY 1, 2;

-- reach: per login role.
WITH ctx AS (
  SELECT (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.users')) AS users_owner,
         (SELECT datdba FROM pg_database WHERE datname = current_database()) AS db_owner)
SELECT 'reach', r.rolname,
  concat_ws(',',
    'superuser=' || r.rolsuper,
    'member_of_users_owner=' || COALESCE(pg_has_role(r.oid, ctx.users_owner, 'MEMBER'), false),
    'can_set_users_owner=' || COALESCE(pg_has_role(r.oid, ctx.users_owner, 'SET'), false),
    'member_of_database_owner=' || COALESCE(pg_has_role(r.oid, ctx.db_owner, 'MEMBER'), false),
    'predefined=' || COALESCE((
      SELECT string_agg(p.rolname, ';' ORDER BY p.rolname) FROM pg_roles p
      WHERE p.rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files',
                          'pg_write_server_files', 'pg_execute_server_program', 'pg_signal_backend',
                          'pg_create_subscription', 'pg_checkpoint')
        AND p.oid <> r.oid AND pg_has_role(r.oid, p.oid, 'MEMBER')), 'none'))
FROM pg_roles r, ctx WHERE r.rolcanlogin
ORDER BY 1, 2;

-- owner
SELECT 'owner', 'database ' || d.datname, pg_get_userbyid(d.datdba)
FROM pg_database d WHERE d.datname = current_database()
UNION ALL
SELECT 'owner', 'schema ' || n.nspname, pg_get_userbyid(n.nspowner)
FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
UNION ALL
SELECT 'owner', 'objects in ' || x.nsp || CASE WHEN x.ext THEN ' (extension members)' ELSE '' END,
  x.owner || ' ' || x.kind || '=' || count(*)
FROM (
  SELECT n.nspname AS nsp, pg_get_userbyid(c.relowner) AS owner,
         CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
           WHEN 'm' THEN 'matview' WHEN 'i' THEN 'index' WHEN 'I' THEN 'index' ELSE 'relation' END AS kind,
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS ext
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'staff_status_approval', 'owner_password_reset', 'economy_lock_restriction') AND c.relkind NOT IN ('t', 'c')
  UNION ALL
  SELECT n.nspname, pg_get_userbyid(p.proowner), 'function',
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'staff_status_approval', 'owner_password_reset', 'economy_lock_restriction')
  UNION ALL
  SELECT n.nspname, pg_get_userbyid(t.typowner), 'type',
         EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname IN ('public', 'staff_status_approval', 'owner_password_reset', 'economy_lock_restriction') AND t.typrelid = 0 AND t.typelem = 0
) x
GROUP BY x.nsp, x.ext, x.owner, x.kind
ORDER BY 1, 2, 3;

-- guard
SELECT 'guard', 'function ' || p.oid::regprocedure::text,
  concat_ws(',', 'owner=' || pg_get_userbyid(p.proowner), 'md5=' || md5(pg_get_functiondef(p.oid)))
FROM pg_proc p
WHERE p.oid IN (to_regprocedure('public.users_privilege_guard()'),
                to_regprocedure('staff_status_approval.approvals_append_only()'),
                to_regprocedure('owner_password_reset.issuances_guard()'))
UNION ALL
SELECT 'guard', 'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname,
  concat_ws(',', 'function=' || t.tgfoid::regproc::text,
    'enabled=' || CASE t.tgenabled WHEN 'O' THEN 'origin' WHEN 'D' THEN 'DISABLED' WHEN 'R' THEN 'replica-only'
                   WHEN 'A' THEN 'always' END)
FROM pg_trigger t
WHERE NOT t.tgisinternal
  AND t.tgrelid IN (to_regclass('public.users'), to_regclass('staff_status_approval.approvals'),
                    to_regclass('owner_password_reset.issuances'))
UNION ALL
SELECT 'guard', 'boundary ' || p.oid::regprocedure::text,
  concat_ws(',', 'owner=' || pg_get_userbyid(p.proowner), 'definer=' || p.prosecdef,
    'config=' || COALESCE(array_to_string(p.proconfig, ';'), 'none'), 'md5=' || md5(pg_get_functiondef(p.oid)))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('staff_set_member_status', 'owner_password_reset_consume')
ORDER BY 1, 2;

-- definer
SELECT 'definer', p.oid::regprocedure::text,
  concat_ws(',', 'owner=' || pg_get_userbyid(p.proowner),
    'config=' || COALESCE(array_to_string(p.proconfig, ';'), 'NONE'),
    'execute=' || COALESCE((
      SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ';' ORDER BY 1)
      FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner), 'owner-only'))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
ORDER BY 1, 2;

-- grant: everything held by someone other than the object's owner.
WITH ns AS (
  SELECT oid, nspname, nspacl, nspowner FROM pg_namespace WHERE nspname IN ('public', 'staff_status_approval', 'owner_password_reset', 'economy_lock_restriction')),
acl AS (
  SELECT 'schema ' || ns.nspname AS obj, ns.nspowner AS owner,
         (aclexplode(COALESCE(ns.nspacl, acldefault('n', ns.nspowner)))).*
  FROM ns
  UNION ALL
  SELECT CASE WHEN c.relkind = 'S' THEN 'sequence ' ELSE 'table ' END || c.oid::regclass::text, c.relowner,
         (aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)))).*
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column ' || c.oid::regclass::text || '.' || a.attname, c.relowner, (aclexplode(a.attacl)).*
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
  WHERE a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'function ' || p.oid::regprocedure::text, p.proowner,
         (aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner)))).*
  FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
  WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
SELECT 'grant', CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END,
  obj || ' ' || privilege_type || CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
  || ' (grantor ' || pg_get_userbyid(grantor) || ')'
FROM acl WHERE grantee <> owner
ORDER BY 1, 2, 3;

-- default_acl
SELECT 'default_acl', pg_get_userbyid(d.defaclrole) || ' in ' || COALESCE(d.defaclnamespace::regnamespace::text, 'all schemas'),
  d.defaclobjtype::text || ' ' || array_to_string(d.defaclacl, ';')
FROM pg_default_acl d
ORDER BY 1, 2, 3;

-- extension
SELECT 'extension', e.extname, concat_ws(',', 'version=' || e.extversion, 'schema=' || n.nspname,
  'owner=' || pg_get_userbyid(e.extowner))
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY 1, 2;

-- key: which logins could read each key table (catalog only).
SELECT 'key', 'readable ' || k.tab, COALESCE((
  SELECT string_agg(r.rolname, ';' ORDER BY r.rolname) FROM pg_roles r
  WHERE r.rolcanlogin AND (r.rolsuper OR has_any_column_privilege(r.oid, k.reg, 'SELECT')
    OR pg_has_role(r.oid, 'pg_read_all_data', 'MEMBER'))), 'none')
FROM (SELECT t AS tab, to_regclass(t) AS reg
      FROM unnest(ARRAY['public.ledger_approval_keys', 'staff_status_approval.keys',
                        'owner_password_reset.issuances']) t) k
WHERE k.reg IS NOT NULL
ORDER BY 1, 2;
-- Key IDs and dates only (never the secret column); skipped when the table is absent.
SELECT CASE WHEN to_regclass('staff_status_approval.keys') IS NULL THEN 'SELECT 1 WHERE false'
  ELSE 'SELECT ''key'', ''staff_status_approval '' || key_id, concat_ws('','', ''installed='' || installed_at, ''retired='' || COALESCE(retired_at::text, ''no'')) FROM staff_status_approval.keys ORDER BY 2'
  END AS q \gset
:q;
SELECT 'key', 'staff_status_approval evidence rows', CASE WHEN to_regclass('staff_status_approval.approvals') IS NULL THEN 'absent'
  ELSE 'present' END
UNION ALL
SELECT 'key', 'owner_password_reset issuance records', CASE WHEN to_regclass('owner_password_reset.issuances') IS NULL THEN 'absent'
  ELSE 'present' END
UNION ALL
SELECT 'key', 'economy_lock_restriction captures', CASE WHEN to_regclass('economy_lock_restriction.acl_snapshots') IS NULL THEN 'absent'
  ELSE 'present' END;

-- migration
SELECT 'migration', 'applied', count(*)::text FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'migration', 'unfinished_or_failed', count(*)::text FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'migration', 'rolled_back', count(*)::text FROM public._prisma_migrations WHERE rolled_back_at IS NOT NULL
UNION ALL SELECT 'migration', 'latest', COALESCE(max(migration_name), 'none') FROM public._prisma_migrations WHERE finished_at IS NOT NULL
ORDER BY 1, 2;

-- session
SELECT 'session', COALESCE(a.usename::text, '<background>'), count(*)::text
FROM pg_stat_activity a WHERE a.datname = current_database()
GROUP BY a.usename
ORDER BY 1, 2;

ROLLBACK;
