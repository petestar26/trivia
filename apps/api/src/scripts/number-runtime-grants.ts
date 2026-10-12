import type { PrismaClient, Prisma } from '@prisma/client';
import { runtimeRoleSubjectsReadOnly } from './ledger-runtime-access.js';
export async function grantNumberRuntimeTables(
  db: PrismaClient,
  api: string,
  worker: string,
  apply = true
) {
  if (api === worker || ![api, worker].every((r) => /^[a-z][a-z0-9_]{1,62}$/.test(r)))
    throw Error('NUMBER_ROLES_REFUSED');
  if (apply) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `GRANT SELECT ON number_practice_rounds,number_timed_rounds TO "${api}"`
        );
        await tx.$executeRawUnsafe(`REVOKE INSERT ON number_practice_rounds FROM "${api}"`);
        await tx.$executeRawUnsafe(`GRANT UPDATE(id) ON number_timed_rounds TO "${api}"`);
        await tx.$executeRawUnsafe(`GRANT SELECT,INSERT ON number_timed_entries TO "${api}"`);
        await tx.$executeRawUnsafe(`GRANT SELECT,INSERT ON number_timed_rounds TO "${worker}"`);
        await tx.$executeRawUnsafe(`GRANT UPDATE(target) ON number_timed_rounds TO "${worker}"`);
        await verifyNumberAccessReadOnly(tx, api, 'api');
        await verifyNumberAccessReadOnly(tx, worker, 'worker');
      },
      { isolationLevel: 'RepeatableRead', timeout: 60000 }
    );
  } else {
    await verifyNumberAccessReadOnly(db, api, 'api');
    await verifyNumberAccessReadOnly(db, worker, 'worker');
  }
}

// Read-only, also used by API/worker startup. No GRANT/REVOKE/SET ROLE occurs.
export async function verifyNumberAccessReadOnly(
  db: Prisma.TransactionClient,
  role: string,
  kind: 'api' | 'worker'
) {
  const { subjects, failures } = await runtimeRoleSubjectsReadOnly(db, role);
  const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'];
  const rows = await db.$queryRaw<
    {
      subject: string;
      schema: string;
      kind: string;
      table: string;
      privilege: string;
      column: string | null;
    }[]
  >`
    SELECT s.subject,n.nspname::text AS schema,c.relkind::text AS kind,c.relname::text AS table,p.privilege,a.attname::text AS column
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(${subjects}::text[]) s(subject)
    CROSS JOIN unnest(${privileges}::text[]) p(privilege)
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      AND p.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND c.relkind IN ('r','p','v','m','f')
      AND (${kind}='worker' OR n.nspname<>'public' OR c.relkind IN ('v','m','f') OR c.relname IN ('number_practice_rounds','number_timed_rounds','number_timed_entries'))
      AND CASE WHEN a.attname IS NULL THEN has_table_privilege(s.subject,c.oid,p.privilege)
        ELSE has_column_privilege(s.subject,c.oid,a.attnum,p.privilege) END`;
  for (const row of rows) {
    const publicProof =
      [
        'house_round_beacon_pins',
        'house_publication_requests',
        'house_publication_receipts',
      ].includes(row.table) && row.privilege === 'SELECT';
    // Unreviewed views can expose their owner's table authority, even when the
    // runtime role has no rights on the underlying public table.
    const allowed =
      row.schema === 'public' &&
      !['v', 'm', 'f'].includes(row.kind) &&
      (publicProof ||
        (row.subject !== 'public' &&
          (kind === 'worker'
            ? row.table === 'number_timed_rounds' &&
              (['SELECT', 'INSERT'].includes(row.privilege) ||
                (row.privilege === 'UPDATE' && row.column === 'target'))
            : row.privilege === 'SELECT' ||
              (row.table === 'number_timed_entries' && row.privilege === 'INSERT') ||
              (row.table === 'number_timed_rounds' &&
                row.privilege === 'UPDATE' &&
                row.column === 'id'))));
    if (!allowed)
      failures.push(
        `${row.subject}: ${row.privilege} ${row.schema}.${row.table}.${row.column ?? '*'}`
      );
  }
  const unsafeSchemas = await db.$queryRaw<{ name: string }[]>`
    SELECT n.nspname::text AS name FROM pg_namespace n CROSS JOIN unnest(${subjects}::text[]) s(subject)
    WHERE (n.nspname IN ('public','pg_catalog') OR n.oid IN (SELECT extnamespace FROM pg_extension WHERE extname='pgcrypto'))
      AND has_schema_privilege(s.subject,n.oid,'CREATE')`;
  if (unsafeSchemas.length) failures.push('runtime can create trusted-schema objects');
  // Known audited SECURITY DEFINER entrypoints cannot draw Number results.
  // Trigger functions can be attached to runtime-owned temporary tables. Only
  // the audited guards below are safe: they validate rows without mutating
  // owner tables. Extension functions have no application-table authority.
  // A newly executable definer function
  // must be reviewed explicitly instead of silently expanding this boundary.
  const safeFunctions = [
    'public.house_beacon_audit_page(text)',
    'public.house_public_spin_proof(text)',
    'public.house_round_randomness_failures()',
    'public.game_rules_validate_parent()',
    'public.game_rules_immutable()',
    'public.game_sessions_validate_rules_snapshot()',
    'public.game_definitions_prevent_metadata_drift()',
    'public.coin_allocations_guard()',
    'public.coin_provenance_guard()',
  ];
  const allowedApiFunctions = [
    'public.ledger_lock_economy_for_invariant_check()',
    'public.ledger_approval_signature_valid(text,text,text,boolean)',
    'public.ledger_adjustment_request(text,text,numeric,text,jsonb,text,text,text,text)',
    'public.ledger_adjustment_first_approval(text,text,text,text,text)',
    'public.ledger_adjustment_execute(text,text,text,text,text,text,text)',
    'public.ledger_adjustment_close(text,text,text,text,text,text,text)',
    'public.ledger_review_first_approval(text,text,jsonb,text,text,text)',
    'public.ledger_review_reopen(text,text,text,integer,text,text,text)',
    'public.ledger_review_resolve(text,text,text,text,text,text)',
    'public.activate_provisioned_agent(text,text,text)',
  ];
  const routines = await db.$queryRaw<{ name: string }[]>`
    SELECT p.oid::regprocedure::text AS name FROM pg_proc p
    CROSS JOIN unnest(${subjects}::text[]) s(subject)
    WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)
      AND p.prosecdef AND has_schema_privilege(s.subject,p.pronamespace,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      AND has_function_privilege(s.subject,p.oid,'EXECUTE')
      AND NOT (p.oid=ANY(ARRAY(SELECT to_regprocedure(signature)::oid FROM unnest(${safeFunctions}::text[]) f(signature) WHERE to_regprocedure(signature) IS NOT NULL)))
      AND NOT (${kind}='api' AND p.oid=ANY(ARRAY(SELECT to_regprocedure(signature)::oid FROM unnest(${allowedApiFunctions}::text[]) f(signature) WHERE to_regprocedure(signature) IS NOT NULL)))`;
  if (routines.length) failures.push('runtime can execute unreviewed privileged functions');
  const [required] = await db.$queryRaw<
    { ok: boolean }[]
  >`SELECT has_schema_privilege(${role},'public','USAGE')
    AND has_table_privilege(${role},'number_timed_rounds','SELECT')
    AND CASE WHEN ${kind}='worker' THEN has_table_privilege(${role},'number_timed_rounds','INSERT') AND has_column_privilege(${role},'number_timed_rounds','target','UPDATE')
      ELSE has_table_privilege(${role},'number_practice_rounds','SELECT') AND has_column_privilege(${role},'number_timed_rounds','id','UPDATE')
        AND has_table_privilege(${role},'number_timed_entries','SELECT') AND has_table_privilege(${role},'number_timed_entries','INSERT') END AS ok`;
  if (!required?.ok || failures.length)
    throw Object.assign(Error('NUMBER_RUNTIME_GRANTS_INVALID'), { failures });
}

export async function verifyNumberRuntimeIdentity(db: PrismaClient, kind: 'api' | 'worker') {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const [identity] = await tx.$queryRaw<
        { role: string; session: string }[]
      >`SELECT current_user AS role,session_user AS session`;
      if (!identity || identity.role !== identity.session)
        throw Error('NUMBER_RUNTIME_IDENTITY_INVALID');
      await verifyNumberAccessReadOnly(tx, identity.role, kind);
    },
    { isolationLevel: 'RepeatableRead', timeout: 60000 }
  );
}
