import type { Prisma } from '@prisma/client';

/** Match support/service.ts writes without requiring UPDATE of cascading keys. */
export async function checkSupportReadiness(db: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [row] = await db.$queryRaw<
    { tickets: boolean; messages: boolean; groupTables: boolean }[]
  >`SELECT (has_table_privilege(current_user,'support_tickets','SELECT')
    AND has_table_privilege(current_user,'support_tickets','INSERT')
    AND has_column_privilege(current_user,'support_tickets','status','UPDATE')
    AND has_column_privilege(current_user,'support_tickets','last_sender','UPDATE')
    AND has_column_privilege(current_user,'support_tickets','updated_at','UPDATE')) AS tickets,
    (has_table_privilege(current_user,'support_messages','SELECT')
    AND has_table_privilege(current_user,'support_messages','INSERT')) AS messages,
    to_regclass('group_pvp_rounds') IS NOT NULL AS "groupTables"`;
  if (!row?.tickets || !row.messages) throw new Error('SUPPORT_ACCESS_UNAVAILABLE');
  return row;
}
