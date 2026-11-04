import { PrismaClient } from '@prisma/client';
import { assertProviderProbeTarget } from '../providers/softaggregator/probe.js';
import {
  createProviderTest,
  TestProviderFailure,
} from '../providers/softaggregator/test-client.js';
import { testIds, callbackSalt } from '../providers/softaggregator/test-wallet.js';

async function main() {
  assertProviderProbeTarget(process.env);
  if (process.argv.length !== 3 || !['--check', '--launch'].includes(process.argv[2]!))
    throw Error('ARGUMENTS_REFUSED');
  const db = new PrismaClient({ log: [] });
  try {
    const pilot = createProviderTest(db),
      ids = testIds(process.env);
    const actor = await db.user.findFirst({
      where: { id: { in: ids }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (process.argv[2] === '--check') {
      console.log(
        JSON.stringify({
          event: 'PROVIDER_TEST_PROBE',
          status: actor && pilot.enabledFor(actor.id) ? 'TEST_CONFIGURED' : 'TEST_NOT_CONFIGURED',
          testerResolved: !!actor,
          saltConfigured: callbackSalt(process.env).length >= 16,
          launchReady: pilot.launchReady(),
        })
      );
      return;
    }
    if (!actor || !pilot.enabledFor(actor.id)) throw Error('TEST_NOT_CONFIGURED');
    const country = process.env.SOFTAGGREGATOR_TEST_COUNTRY ?? '';
    if (!/^[A-Z]{2}$/.test(country)) throw Error('TEST_COUNTRY_REQUIRED');
    const games = await pilot.games(actor.id),
      requested = process.env.SOFTAGGREGATOR_TEST_GAME_ID;
    const game = requested
      ? games.find((g) => g.id === requested)
      : games.find((g) => g.category === 'slots');
    if (!game) throw Error('TEST_GAME_MISSING');
    const result = await pilot.launch(actor.id, game.id, country, false, true);
    console.log(
      JSON.stringify({
        event: 'PROVIDER_TEST_PROBE',
        status: 'TEST_SESSION_CREATED',
        launchHost: result.host,
        gameId: game.id,
        currency: 'ETB',
        country,
        virtualOnly: true,
      })
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'PROVIDER_TEST_PROBE',
      status: 'TEST_PROBE_FAILED',
      ...(error instanceof TestProviderFailure
        ? {
            method: error.method,
            reason: error.reason,
            httpStatus: error.httpStatus,
            providerCode: error.providerCode,
          }
        : {}),
    })
  );
  process.exitCode = 1;
});
