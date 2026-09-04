import { fileURLToPath } from 'node:url';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { sweepWithdrawalTimeouts } from './withdrawals/timeout-service';

// W-1D3: thin worker entrypoint for the withdrawal timeout sweep.
//
// Runs sweepWithdrawalTimeouts() once and exits — no setInterval, no
// in-process scheduling. An external scheduler (cron, a k8s CronJob, a
// systemd timer) is expected to invoke this on a cadence; this file does
// not assume or configure one. See timeout-service.ts for the sweep's own
// idempotency/concurrency guarantees, which make repeated and overlapping
// invocations of this script safe — including two copies running at once.

async function runWorker(): Promise<number> {
  // Imported the same way server.ts imports it — the import itself runs
  // getConfig() and throws immediately on a missing/invalid required env
  // var (DATABASE_URL, JWT secrets, ...), so this worker fails exactly as
  // clearly as the API server would, rather than surfacing as a confusing
  // raw Prisma connection error later.
  console.log(JSON.stringify({ level: 'info', msg: 'withdrawal timeout sweep starting', nodeEnv: config.NODE_ENV }));

  try {
    const summary = await sweepWithdrawalTimeouts();
    console.log(JSON.stringify({ level: 'info', msg: 'withdrawal timeout sweep completed', summary }));
    return 0;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'withdrawal timeout sweep failed',
        error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      })
    );
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Same cross-platform guard as server.ts: file://${process.argv[1]} builds a
// malformed URL on Windows (argv[1] is a native backslash path), so compare
// native-to-native via fileURLToPath instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runWorker().then((code) => process.exit(code));
}

export { runWorker };
