import { prisma } from '@socialplay/database';
import { assistantConfigured } from '../support/assistant.js';
try {
  const [row] = await prisma.$queryRaw<
    { tickets: boolean; messages: boolean; groupTables: boolean }[]
  >`SELECT (has_table_privilege(current_user,'support_tickets','SELECT') AND has_table_privilege(current_user,'support_tickets','INSERT') AND has_table_privilege(current_user,'support_tickets','UPDATE')) AS tickets,(has_table_privilege(current_user,'support_messages','SELECT') AND has_table_privilege(current_user,'support_messages','INSERT')) AS messages,to_regclass('group_pvp_rounds') IS NOT NULL AS "groupTables"`;
  if (!row?.tickets || !row.messages) throw new Error('SUPPORT_ACCESS_UNAVAILABLE');
  console.log(
    JSON.stringify({
      event: 'MEMBER_EXPERIENCE_READY',
      support: true,
      groupTables: row.groupTables,
      groupEnabled: process.env.GROUP_PVP_GAME_POINTS_ENABLED === 'true',
      aiConfigured: assistantConfigured(),
    })
  );
} catch {
  console.error(JSON.stringify({ event: 'MEMBER_EXPERIENCE_REFUSED' }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
