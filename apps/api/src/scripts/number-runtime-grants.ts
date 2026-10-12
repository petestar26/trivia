import type { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { runtimeRoleSubjectsReadOnly } from './ledger-runtime-access.js';

// These are the six owner guards audited in the forward search-path migrations.
// An attachment is trusted only on its original table, with the original event,
// columns, body and execution settings. Merely reusing a guard's name or attaching
// it to another table must not create a new privileged entrypoint. A future
// migration changing one of these guards must update its audited fingerprint.
const auditedTriggers: Record<
  string,
  { function: string; type: number; columns: string[]; body: string }
> = {
  'coin_allocations.coin_allocations_guard': {
    function: 'coin_allocations_guard',
    type: 23,
    columns: [],
    body: '9ff704764f228cc5acb2058f34b8aed87e7af3fcbb6d06770ac8b05baf83f996',
  },
  'coin_provenance.coin_provenance_guard': {
    function: 'coin_provenance_guard',
    type: 23,
    columns: [],
    body: 'cc9525946c68b806f0377e2ccb195a4639eea5c30c4a615c495a683781f1f428',
  },
  'game_definitions.game_definitions_prevent_metadata_drift': {
    function: 'game_definitions_prevent_metadata_drift',
    type: 19,
    columns: ['currentRulesVersion', 'family', 'mode', 'rewardCurrency', 'wagerCurrency'],
    body: '0210a0820c372b38c7eb9659abef26ed10d6b4d1276c8452b6441af75a6829d6',
  },
  'game_rules.game_rules_immutable': {
    function: 'game_rules_immutable',
    type: 27,
    columns: [],
    body: 'cd325b8247a2afa7552a6fef1b42ebb65a8c04832c64ccd6c22a67157b3e1477',
  },
  'game_rules.game_rules_insert_validate': {
    function: 'game_rules_validate_parent',
    type: 7,
    columns: [],
    body: 'e14a189d2f12795d5f5314df88815e847dd48f85e4ca66b1e9bd385d72e19891',
  },
  'game_sessions.game_sessions_insert_validate': {
    function: 'game_sessions_validate_rules_snapshot',
    type: 7,
    columns: [],
    body: '5273ceee40280c7fd0f4a4131c189d9489170c88aea9e877d7f49b9f3991906b',
  },
};

async function unreviewedAttachedTriggers(db: Prisma.TransactionClient, subjects: string[]) {
  const triggers = await db.$queryRaw<
    {
      schema: string;
      table: string;
      trigger: string;
      functionSchema: string;
      function: string;
      type: number;
      columns: string[];
      body: string;
      config: string[] | null;
      language: string;
      ordinary: boolean;
      sameOwner: boolean;
    }[]
  >`
    WITH RECURSIVE writable(subject,relation,event,column_name) AS (
      SELECT s.subject,c.oid,e.event,a.attname::text
      FROM pg_class c CROSS JOIN unnest(${subjects}::text[]) s(subject)
        CROSS JOIN unnest(ARRAY[4,8,16,32]) e(event)
        LEFT JOIN pg_attribute a ON e.event=16 AND a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p','v','f') AND CASE e.event
        WHEN 4 THEN has_any_column_privilege(s.subject,c.oid,'INSERT')
        WHEN 8 THEN has_table_privilege(s.subject,c.oid,'DELETE')
        WHEN 16 THEN has_column_privilege(s.subject,c.oid,a.attnum,'UPDATE')
        WHEN 32 THEN has_table_privilege(s.subject,c.oid,'TRUNCATE') END
      UNION
      SELECT w.subject,next.relation,next.event,next.column_name FROM writable w
      CROSS JOIN LATERAL (
        -- Parent DML also reaches partitions/inherited children without child
        -- ACLs. INSERT routing is limited to declaratively partitioned parents.
        SELECT i.inhrelid AS relation,w.event,w.column_name
          FROM pg_inherits i JOIN pg_class parent ON parent.oid=i.inhparent
          WHERE i.inhparent=w.relation AND (w.event<>4 OR parent.relkind='p')
        UNION
        -- Referential actions run the referencing table's writes as its owner;
        -- the original caller need not hold any permission on that table.
        SELECT fk.conrelid,CASE WHEN w.event=8 AND fk.confdeltype='c' THEN 8 ELSE 16 END,
          CASE WHEN w.event=8 AND fk.confdeltype='c' THEN NULL ELSE child.attname::text END
          FROM pg_constraint fk JOIN pg_attribute child ON child.attrelid=fk.conrelid
            AND child.attnum=ANY(fk.conkey)
          WHERE fk.contype='f' AND fk.confrelid=w.relation AND (
            (w.event=8 AND fk.confdeltype IN ('c','n','d'))
            OR (w.event=16 AND fk.confupdtype IN ('c','n','d') AND EXISTS (
              SELECT 1 FROM pg_attribute parent WHERE parent.attrelid=fk.confrelid
                AND parent.attnum=ANY(fk.confkey) AND parent.attname=w.column_name)))
      ) next
    )
    SELECT DISTINCT n.nspname::text AS schema,c.relname::text AS table,t.tgname::text AS trigger,
      pn.nspname::text AS "functionSchema",p.proname::text AS function,t.tgtype::int AS type,
      ARRAY(SELECT a.attname::text FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum=ANY(t.tgattr::smallint[]) ORDER BY a.attname) AS columns,
      p.prosrc AS body,p.proconfig AS config,l.lanname::text AS language,p.proowner=c.relowner AS "sameOwner",
      (t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred
        AND t.tgconstraint=0 AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL
        AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND p.pronargs=0) AS ordinary
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      JOIN pg_language l ON l.oid=p.prolang JOIN writable w ON w.relation=c.oid
    WHERE p.prosecdef AND t.tgenabled<>'D' AND (t.tgtype::int & w.event)<>0
      AND (w.event<>16 OR cardinality(t.tgattr::smallint[])=0 OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=ANY(t.tgattr::smallint[])
          -- UPDATE OF generated columns also fires when a dependency changes.
          AND (a.attname=w.column_name OR a.attgenerated<>'')))`;
  return triggers.filter((trigger) => {
    const audited = auditedTriggers[`${trigger.table}.${trigger.trigger}`];
    return (
      !audited ||
      trigger.schema !== 'public' ||
      trigger.functionSchema !== 'public' ||
      trigger.function !== audited.function ||
      trigger.type !== audited.type ||
      !trigger.ordinary ||
      !trigger.sameOwner ||
      trigger.language !== 'plpgsql' ||
      trigger.config?.length !== 1 ||
      trigger.config[0] !== 'search_path=pg_catalog, pg_temp' ||
      trigger.columns.join(',') !== audited.columns.join(',') ||
      createHash('sha256').update(trigger.body).digest('hex') !== audited.body
    );
  });
}
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
  // PostgreSQL checks EXECUTE/schema access when a trigger is installed, not
  // when it fires. Inspect every writable relation, including public relations
  // outside Number: the API legitimately writes those under separate grants.
  for (const trigger of await unreviewedAttachedTriggers(db, subjects))
    failures.push(
      `runtime can fire unreviewed privileged trigger ${trigger.schema}.${trigger.table}.${trigger.trigger}`
    );
  // Known audited SECURITY DEFINER entrypoints cannot draw Number results.
  // Trigger functions can be attached to runtime-owned temporary tables and
  // even validation-only guards can leak private data through their errors.
  // They are not exempt. Extension functions have no application-table authority.
  // A newly executable definer function
  // must be reviewed explicitly instead of silently expanding this boundary.
  const safeFunctions = [
    'public.house_beacon_audit_page(text)',
    'public.house_public_spin_proof(text)',
    'public.house_round_randomness_failures()',
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
