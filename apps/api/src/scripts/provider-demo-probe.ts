import { PrismaClient } from '@prisma/client';
import {
  assertProviderProbeTarget, providerProbeTesterName, runProviderDemoProbe, type ProviderProbeMode,
} from '../providers/softaggregator/probe.js';

async function tester() {
  const username = providerProbeTesterName(process.env);
  if (!username) return { status: 'TESTER_USERNAME_MISSING', active: false };
  const db = new PrismaClient({ log: [] });
  try {
    const user = await db.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return tx.user.findUnique({ where: { username }, select: { id: true, status: true } });
    }, { timeout: 5_000 });
    return user
      ? { status: 'TESTER_RESOLVED', testerId: user.id, active: user.status === 'ACTIVE' }
      : { status: 'TESTER_NOT_FOUND', active: false };
  } finally { await db.$disconnect(); }
}

async function main() {
  const mode = process.argv[2];
  assertProviderProbeTarget(process.env);
  if (process.argv.length !== 3 || !['--check', '--catalogue', '--launch', '--tester'].includes(mode ?? ''))
    throw new Error('PROVIDER_PROBE_ARGUMENTS_REFUSED');
  let resolvedTester: Awaited<ReturnType<typeof tester>> | undefined;
  if (mode === '--tester' || (mode === '--check' && process.env.SOFTAGGREGATOR_DEMO_TEST_USERNAME)) {
    try { resolvedTester = await tester(); }
    catch { resolvedTester = { status: 'TESTER_LOOKUP_UNAVAILABLE', active: false }; }
  }
  if (mode === '--tester') {
    console.log(JSON.stringify({ event: 'SOFTAGGREGATOR_DEMO_PROBE', mode, tester: resolvedTester }));
    if (resolvedTester?.status !== 'TESTER_RESOLVED' || !resolvedTester.active) process.exitCode = 1;
    return;
  }
  const result = await runProviderDemoProbe(mode as ProviderProbeMode);
  console.log(JSON.stringify({ event: 'SOFTAGGREGATOR_DEMO_PROBE', mode, ...result,
    ...(resolvedTester ? { tester: resolvedTester } : {}) }));
  // Optional provider configuration never blocks the ordinary API deployment.
  if (mode !== '--check' && !result.ok) process.exitCode = 1;
}
main().catch(() => {
  console.error(JSON.stringify({ event: 'SOFTAGGREGATOR_DEMO_PROBE_REFUSED', status: 'TARGET_OR_ARGUMENTS_REFUSED' }));
  process.exitCode = 1;
});
