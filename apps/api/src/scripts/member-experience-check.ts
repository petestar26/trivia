import { prisma } from '@socialplay/database';
import { assistantConfigured } from '../support/assistant.js';
try {
  const [row] = await prisma.$queryRaw<
    { tickets: boolean; messages: boolean; groupTables: boolean }[]
  >`SELECT (has_table_privilege(current_user,'support_tickets','SELECT') AND has_table_privilege(current_user,'support_tickets','INSERT') AND has_table_privilege(current_user,'support_tickets','UPDATE')) AS tickets,(has_table_privilege(current_user,'support_messages','SELECT') AND has_table_privilege(current_user,'support_messages','INSERT')) AS messages,to_regclass('group_pvp_rounds') IS NOT NULL AS "groupTables"`;
  if (!row?.tickets || !row.messages) throw new Error('SUPPORT_ACCESS_UNAVAILABLE');
  const [rewards] = await prisma.$queryRaw<{ ready: boolean }[]>`
    SELECT (has_table_privilege(current_user,'member_reward_config','SELECT')
      AND has_table_privilege(current_user,'member_reward_config','UPDATE')
      AND has_table_privilege(current_user,'member_reward_entitlements','SELECT')
      AND has_table_privilege(current_user,'member_reward_entitlements','INSERT')
      AND has_table_privilege(current_user,'member_reward_entitlements','UPDATE')
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='member_reward_entitlements'::regclass
        AND attname='next_attempt_at' AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM member_reward_config WHERE id='default')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='member_reward_entitlements'::regclass
        AND tgname='member_reward_entitlement_guard' AND tgenabled='O')) AS ready`;
  if (!rewards?.ready) throw new Error('MEMBER_REWARDS_ACCESS_UNAVAILABLE');
  console.log(
    JSON.stringify({
      event: 'MEMBER_EXPERIENCE_READY',
      support: true,
      rewards: true,
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
