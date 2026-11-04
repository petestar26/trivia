/** Scoped provisioning for Salem's existing practice tables. Never touches money. */
export const PRACTICE_PROJECT = '95bd9da5-59ea-4f49-b2b1-9114e8a1a0a2';
export const PRACTICE_ENVIRONMENT = 'e48c2274-6993-446e-8a54-c33e4d6f698e';
export const WORKER_ROLE = 'salem_practice_worker_20261104';
export const NUMBER_ROLE = 'salem_number_worker_20261104';
const ROLE_MARKER = 'salem-practice-activation-20261104';
export const PRACTICE_TABLES = [
  'system_dice_practice_accounts',
  'system_dice_practice_rounds',
  'system_dice_practice_tickets',
  'system_keno_practice_accounts',
  'system_keno_practice_rounds',
  'system_keno_practice_tickets',
  'sky_crash_accounts',
  'sky_crash_rounds',
  'sky_crash_tickets',
  'crash_point_accounts',
  'crash_point_rounds',
  'crash_point_tickets',
  'derby_accounts',
  'derby_rounds',
  'derby_tickets',
  'football_accounts',
  'football_matchweeks',
  'football_fixtures',
  'football_tickets',
  'football_ticket_lines',
  'football_ticket_legs',
] as const;
const SUPPORT_TABLES = [
  'users',
  'number_practice_rounds',
  'number_timed_rounds',
  'number_timed_entries',
  'scheduled_game_streams',
  'scheduled_game_rounds',
  'scheduled_practice_tickets',
];

export interface ActivationDb {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
  execute(sql: string): Promise<unknown>;
}
export function activationTarget(env: Record<string, string | undefined>, apply: boolean) {
  if (
    env.RAILWAY_PROJECT_ID !== PRACTICE_PROJECT ||
    env.RAILWAY_ENVIRONMENT_ID !== PRACTICE_ENVIRONMENT ||
    env.RAILWAY_SERVICE_ID !== 'ffe7dd49-e409-4a46-95a8-7614d2e96095'
  )
    throw Error('PRACTICE_TARGET_REFUSED');
  if (
    apply &&
    (env.PRACTICE_ACTIVATION_ACK !== ROLE_MARKER ||
      !/^[a-f0-9]{64}$/.test(env.PRACTICE_WORKER_PASSWORD ?? '') ||
      !/^[a-f0-9]{64}$/.test(env.NUMBER_WORKER_PASSWORD ?? '') ||
      env.PRACTICE_WORKER_PASSWORD === env.NUMBER_WORKER_PASSWORD)
  )
    throw Error('PRACTICE_CREDENTIAL_SETUP_REFUSED');
}

export async function practiceReadiness(db: ActivationDb) {
  const [identity] = await db.query<{ owns: boolean; can_create_role: boolean }>(
    `SELECT current_user::text=pg_get_userbyid(d.datdba) AS owns,
      (r.rolsuper OR r.rolcreaterole) AS can_create_role
     FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`
  );
  const tables: Record<string, boolean> = {};
  for (const table of [...PRACTICE_TABLES, ...SUPPORT_TABLES]) {
    const [row] = await db.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`public.${table}`]
    );
    tables[table] = row?.present === true;
  }
  if (!Object.values(tables).every(Boolean)) throw Error('PRACTICE_TABLES_MISSING');
  const [stream] = await db.query<{ present: boolean; enabled: boolean }>(
    `SELECT true AS present, enabled FROM scheduled_game_streams WHERE id='spin-win-practice-v1' AND mode='PRACTICE' AND game_key='spin_win'`
  );
  if (!stream?.present) throw Error('PRACTICE_SPIN_STREAM_MISSING');
  return {
    tablesReady: true,
    databaseOwner: identity?.owns === true,
    canCreateRole: identity?.can_create_role === true,
    spinEnabled: stream.enabled,
  };
}


/** Catalog metadata only: no relation data, function bodies, passwords or connection details. */
export async function practiceDiagnostics(db: Pick<ActivationDb, 'query'>) {
  const [identity] = await db.query(
    `SELECT current_user::text AS role, pg_get_userbyid(d.datdba) AS database_owner,
      current_user::text=pg_get_userbyid(d.datdba) AS owns_database,
      r.rolsuper AS superuser, r.rolcreaterole AS can_create_role
     FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`
  );
  const roles = await db.query(
    `SELECT rolname AS role, rolcanlogin AS login, rolsuper AS superuser,
      rolcreaterole AS create_role, rolcreatedb AS create_database,
      rolreplication AS replication, rolinherit AS inherit, rolbypassrls AS bypass_rls
     FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname`
  );
  const memberships = await db.query(
    `SELECT parent.rolname AS role, member.rolname AS member, m.admin_option
     FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
     JOIN pg_roles member ON member.oid=m.member
     WHERE parent.rolname !~ '^pg_' OR member.rolname !~ '^pg_'
     ORDER BY parent.rolname,member.rolname`
  );
  const functions = await db.query(
    `SELECT n.nspname AS schema, p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_userbyid(p.proowner) AS owner,
      (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) AS acl
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
      AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype)
      AND EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
     ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`
  );
  const relations = await db.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
      pg_get_userbyid(c.relowner) AS owner, col.attname AS column,
      CASE WHEN n.nspname='public' AND c.relname=ANY($1::text[]) THEN true ELSE false END AS practice_table,
      (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
       FROM aclexplode(CASE WHEN col.attnum IS NULL THEN COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner)) ELSE col.attacl END) a) AS acl
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN LATERAL (SELECT NULL::smallint AS attnum,NULL::name AS attname,NULL::aclitem[] AS attacl
       UNION ALL SELECT attnum,attname,attacl FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL) col ON true
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
      AND EXISTS(SELECT 1 FROM aclexplode(CASE WHEN col.attnum IS NULL THEN COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner)) ELSE col.attacl END) a WHERE a.grantee=0)
     ORDER BY n.nspname,c.relname,col.attname NULLS FIRST`,
    [[...PRACTICE_TABLES]]
  );
  const schemas = await db.query(
    `SELECT n.nspname AS schema,pg_get_userbyid(n.nspowner) AS owner,
      (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type)
       FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a) AS acl
     FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
        WHERE a.grantee=0 AND a.privilege_type='CREATE') ORDER BY n.nspname`
  );
  return { identity, roles, memberships, publicSecurityDefinerFunctions: functions,
    publicRelationPrivileges: relations, publicSchemaCreate: schemas };
}

async function provisionRole(db: ActivationDb, role: string, password: string) {
  const [existing] = await db.query<{ unsafe: boolean; marked: boolean }>(
    `SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
      OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) AS unsafe,
      shobj_description(r.oid,'pg_authid')=$2 AS marked FROM pg_roles r WHERE r.rolname=$1`,
    [role, ROLE_MARKER]
  );
  if (existing && (existing.unsafe || !existing.marked))
    throw Error('PRACTICE_EXISTING_ROLE_REFUSED');
  if (!existing) {
    // Identifiers are constants; passwords must pass activationTarget's hex validation.
    await db.execute(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS`
    );
    await db.execute(`COMMENT ON ROLE "${role}" IS '${ROLE_MARKER}'`);
  }
  await db.execute(`GRANT USAGE ON SCHEMA public TO "${role}"`);
}

export async function verifyPracticeRoles(db: ActivationDb) {
  for (const role of [WORKER_ROLE, NUMBER_ROLE]) {
    const general = role === WORKER_ROLE;
    const [row] = await db.query<{ safe: boolean }>(
      `SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
       OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
       OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
       OR EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o')
       OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
        AND p.prorettype NOT IN ('trigger'::regtype,'event_trigger'::regtype) AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
       OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
       OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES')
         OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) op(privilege)
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(r.oid,c.oid,a.attname,op.privilege)
          AND NOT (n.nspname='public' AND (
           (c.relname=ANY($2::text[]) AND op.privilege IN ('SELECT','INSERT','UPDATE'))
           OR ($3::boolean AND c.relname='users' AND op.privilege='SELECT' AND a.attname IN ('id','status'))
           OR ($3::boolean AND c.relname='scheduled_game_streams' AND op.privilege='SELECT')
           OR ($3::boolean AND c.relname='scheduled_game_rounds' AND (op.privilege IN ('SELECT','INSERT') OR (op.privilege='UPDATE' AND a.attname IN ('state','outcome','drawn_at'))))
           OR (NOT $3::boolean AND c.relname='number_timed_rounds' AND (op.privilege IN ('SELECT','INSERT') OR (op.privilege='UPDATE' AND a.attname='target')))
          )))))
      ) AS safe FROM pg_roles r WHERE r.rolname=$1`,
      [role, general ? [...PRACTICE_TABLES] : [], general]
    );
    if (!row?.safe) throw Error('PRACTICE_WORKER_PRIVILEGES_REFUSED');
  }
}

/** Call in a transaction: any missing capability rolls back all grants and stream activation. */
export async function provisionPractice(db: ActivationDb, env: Record<string, string | undefined>) {
  activationTarget(env, true);
  const ready = await practiceReadiness(db);
  if (!ready.databaseOwner || !ready.canCreateRole) throw Error('PRACTICE_OWNER_REQUIRED');
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('salem-practice-activation-20261104',0))::text`
  );
  await provisionRole(db, WORKER_ROLE, env.PRACTICE_WORKER_PASSWORD!);
  await provisionRole(db, NUMBER_ROLE, env.NUMBER_WORKER_PASSWORD!);
  await db.execute(
    `GRANT SELECT,INSERT,UPDATE ON ${PRACTICE_TABLES.map((t) => `public.${t}`).join(',')} TO "${WORKER_ROLE}"`
  );
  await db.execute(`GRANT SELECT(id,status) ON public.users TO "${WORKER_ROLE}"`);
  await db.execute(`GRANT SELECT ON public.scheduled_game_streams TO "${WORKER_ROLE}"`);
  await db.execute(`GRANT SELECT,INSERT ON public.scheduled_game_rounds TO "${WORKER_ROLE}"`);
  await db.execute(
    `GRANT UPDATE(state,outcome,drawn_at) ON public.scheduled_game_rounds TO "${WORKER_ROLE}"`
  );
  await db.execute(`GRANT SELECT,INSERT ON public.number_timed_rounds TO "${NUMBER_ROLE}"`);
  await db.execute(`GRANT UPDATE(target) ON public.number_timed_rounds TO "${NUMBER_ROLE}"`);
  await verifyPracticeRoles(db);
  await db.execute(
    `UPDATE public.scheduled_game_streams SET enabled=true WHERE id='spin-win-practice-v1' AND mode='PRACTICE'`
  );
  return { ...ready, spinEnabled: true, restrictedWorkersReady: true };
}
