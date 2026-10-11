import type { PrismaClient } from '@prisma/client';
export async function grantNumberRuntimeTables(
  db: PrismaClient,
  api: string,
  worker: string,
  apply = true
) {
  if (api === worker || ![api, worker].every((r) => /^[a-z][a-z0-9_]{1,62}$/.test(r)))
    throw Error('NUMBER_ROLES_REFUSED');
  if (apply) {
    await db.$executeRawUnsafe(
      `GRANT SELECT ON number_practice_rounds,number_timed_rounds TO "${api}"`
    );
    await db.$executeRawUnsafe(`REVOKE INSERT ON number_practice_rounds FROM "${api}"`);
    await db.$executeRawUnsafe(`GRANT UPDATE(id) ON number_timed_rounds TO "${api}"`);
    await db.$executeRawUnsafe(`GRANT SELECT,INSERT ON number_timed_entries TO "${api}"`);
    await db.$executeRawUnsafe(`GRANT SELECT,INSERT ON number_timed_rounds TO "${worker}"`);
    await db.$executeRawUnsafe(`GRANT UPDATE(target) ON number_timed_rounds TO "${worker}"`);
  }
  const [a] = await db.$queryRaw<{ ok: boolean }[]>`SELECT
    has_table_privilege(${api},'number_practice_rounds','SELECT') AND NOT has_table_privilege(${api},'number_practice_rounds','INSERT')
    AND has_table_privilege(${api},'number_timed_rounds','SELECT') AND has_column_privilege(${api},'number_timed_rounds','id','UPDATE')
    AND NOT has_column_privilege(${api},'number_timed_rounds','target','UPDATE') AND NOT has_table_privilege(${api},'number_timed_rounds','INSERT') AND NOT has_table_privilege(${api},'number_timed_rounds','DELETE')
    AND has_table_privilege(${api},'number_timed_entries','SELECT') AND has_table_privilege(${api},'number_timed_entries','INSERT')
    AND NOT has_table_privilege(${api},'number_timed_entries','UPDATE') AND NOT has_table_privilege(${api},'number_timed_entries','DELETE') AS ok`;
  const [w] = await db.$queryRaw<{ ok: boolean }[]>`SELECT
    has_table_privilege(${worker},'number_timed_rounds','SELECT') AND has_table_privilege(${worker},'number_timed_rounds','INSERT') AND has_column_privilege(${worker},'number_timed_rounds','target','UPDATE')
    AND NOT has_table_privilege(${worker},'number_timed_rounds','DELETE') AND NOT has_column_privilege(${worker},'number_timed_rounds','closes_at','UPDATE')
    AND NOT has_table_privilege(${worker},'number_timed_entries','INSERT') AND NOT has_table_privilege(${worker},'number_timed_entries','UPDATE') AND NOT has_table_privilege(${worker},'number_timed_entries','DELETE') AS ok`;
  if (!a?.ok || !w?.ok) throw Error('NUMBER_RUNTIME_GRANTS_INVALID');
}
