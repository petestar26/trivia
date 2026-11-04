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
