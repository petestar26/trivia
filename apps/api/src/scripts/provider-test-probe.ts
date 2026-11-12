import { PrismaClient } from '@prisma/client';
import { assertProviderProbeTarget } from '../providers/softaggregator/probe.js';
import {
  createProviderTest,
  TestProviderFailure,
  TestLaunchFailure,
} from '../providers/softaggregator/test-client.js';
import { testIds, testAccessMode, callbackSalt } from '../providers/softaggregator/test-wallet.js';

async function main() {
  assertProviderProbeTarget(process.env);
  if (process.argv.length !== 3 || !['--check', '--launch'].includes(process.argv[2]!))
    throw Error('ARGUMENTS_REFUSED');
  const db = new PrismaClient({ log: [] });
  try {
    const pilot = createProviderTest(db),
      ids = testIds(process.env),
      accessMode = testAccessMode(process.env);
    const actor = await db.user.findFirst({
      // A read-only readiness check may use any active member. The operator's
      // launch probe still targets an explicitly selected tester, not a customer.
      where: {
        ...(accessMode === 'all-active' && process.argv[2] === '--check'
          ? {}
          : { id: { in: ids } }),
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (process.argv[2] === '--check') {
      console.log(
        JSON.stringify({
          event: 'PROVIDER_TEST_PROBE',
          status: actor && pilot.enabledFor(actor.id) ? 'TEST_CONFIGURED' : 'TEST_NOT_CONFIGURED',
          accessMode,
          unavailableReason: actor ? pilot.unavailableReasonFor(actor.id) : 'no-active-account',
          testerResolved: !!actor,
          saltConfigured: callbackSalt(process.env).length >= 16,
          launchReady: pilot.launchReady(),
        })
      );
      return;
    }
    if (!actor || !pilot.enabledFor(actor.id)) throw Error('TEST_NOT_CONFIGURED');
    // Probe the same market enforced by member launches, never an operator's
    // earlier location setting that could hide country-specific failures.
    const country = 'ET';
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
        hostApproved: (process.env.SOFTAGGREGATOR_TEST_LAUNCH_HOSTS ?? '')
          .split(',')
          .some((host) => host.trim().toLowerCase() === result.host),
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
        : error instanceof TestLaunchFailure
          ? { reason: error.reason }
          : {}),
    })
  );
  process.exitCode = 1;
});
