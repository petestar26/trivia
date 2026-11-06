import { PrismaClient } from '@prisma/client';
import { assertProviderProbeTarget } from '../providers/softaggregator/probe.js';
import { createSportsbook } from '../providers/softaggregator/sports-client.js';

async function main() {
  assertProviderProbeTarget(process.env);
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--check', '--inspect-launch'].includes(mode ?? ''))
    throw Error('ARGUMENTS_REFUSED');
  const db = new PrismaClient({ log: [] });
  try {
    const sports = createSportsbook(db);
    const gates = await db.platformGate.findMany({
      where: { key: { in: ['SPORTSBOOK_PLAY', 'CASINO_PLAY'] } },
      select: { key: true, enabled: true },
    });
    const [access] = await db.$queryRaw<{ players: boolean; receipts: boolean }[]>`
      SELECT (has_table_privilege(current_user,'sg_sports_players','SELECT,INSERT')
        AND has_column_privilege(current_user,'sg_sports_players','live_started_at','UPDATE')
        AND has_column_privilege(current_user,'sg_sports_players','policy_id','UPDATE')
        AND has_column_privilege(current_user,'sg_sports_players','policy_version','UPDATE')) AS players,
        has_table_privilege(current_user,'sg_sports_movements','SELECT,INSERT') AS receipts`;
    const actor = await db.user.findFirst({
      where: { status: 'ACTIVE', role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!access.players || !access.receipts || !actor) throw Error('SPORTS_SETUP_INCOMPLETE');
    const wallet = await sports.wallet.snapshot(actor.id);
    if (mode === '--check') {
      console.log(
        JSON.stringify({
          event: 'SPORTS_READINESS',
          configured: sports.configured(),
          browseReady: sports.browseReady(),
          gates,
          wallet: {
            balanceMinor: wallet.balanceMinor,
            liveEnabled: wallet.liveEnabled,
            canBet: wallet.canBet,
          },
          currency: 'ETB',
        })
      );
      return;
    }
    // This diagnostic is only for the initial zero-balance, no-betting rollout.
    if (
      wallet.balanceMinor !== 0 ||
      wallet.canBet ||
      process.env.SOFTAGGREGATOR_SPORTS_LIVE_ENABLED === 'true' ||
      gates.some((g) => g.key === 'SPORTSBOOK_PLAY' && g.enabled)
    )
      throw Error('ZERO_BALANCE_PREVIEW_REQUIRED');
    const result = await sports.launch(actor.id, false, true);
    console.log(
      JSON.stringify({
        event: 'SPORTS_PREVIEW_VERIFIED',
        launchHost: result.host,
        balanceMinor: 0,
        currency: 'ETB',
        bettingEnabled: false,
      })
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(JSON.stringify({ event: 'SPORTS_READINESS_FAILED' }));
  process.exitCode = 1;
});
