/** Isolated rehearsal worker. Refuses production before connecting or running a sweep. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { assertUsdStagingTarget } from './staging-payment-target.js';

export function paymentWorkerTarget(env: NodeJS.ProcessEnv): string {
  try {
    const url = new URL(env.DATABASE_URL ?? 'https://invalid');
    const role = decodeURIComponent(url.username);
    assertUsdStagingTarget({ ...env, PRACTICE_API_ROLE: role });
    if (env.LEDGER_OWNER_DATABASE_URL || url.hash || (url.port && url.port !== '5432')) throw Error();
    for (const [key, value] of url.searchParams) {
      const permitted = (key === 'schema' && value === 'public')
        || (['connection_limit', 'pool_timeout', 'connect_timeout'].includes(key) && /^\d+$/.test(value))
        || (key === 'sslmode' && ['disable', 'prefer', 'require'].includes(value));
      if (!permitted) throw Error();
    }
    return role;
  } catch {
    throw Error('PAYMENT_WORKER_TARGET_REFUSED');
  }
}

export async function startVerifiedPaymentWorker(
  env: NodeJS.ProcessEnv,
  verify: (role: string) => Promise<void>,
  run: () => Promise<number>,
): Promise<number> {
  const role = paymentWorkerTarget(env);
  await verify(role);
  return run();
}

async function runChild(file: URL, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(file), ...args], { env, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    const cleanup = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    child.once('error', () => { cleanup(); reject(Error('PAYMENT_WORKER_CHILD_FAILED')); });
    child.once('close', (code) => { cleanup(); done(code ?? 1); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--run', '--once'].includes(arg)) || (args.includes('--once') && !args.includes('--run'))) {
    throw Error('PAYMENT_WORKER_ARGUMENTS_REFUSED');
  }
  return startVerifiedPaymentWorker(process.env, async (role) => {
    const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
    try {
      await db.$transaction(async (tx) => {
        const [identity] = await tx.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
        if (identity?.database !== 'playqube_spin_rehearsal_20261002') throw Error('PAYMENT_WORKER_TARGET_REFUSED');

      }, { isolationLevel: 'RepeatableRead', timeout: 60_000 });
    } finally {
      await db.$disconnect();
    }
    const checked = await runChild(new URL('./ledger-runtime-identity-check.js', import.meta.url), [], { ...process.env, LEDGER_RUNTIME_ROLE: role });
    if (checked !== 0) throw Error('PAYMENT_WORKER_IDENTITY_REFUSED');
    console.log(JSON.stringify({ event: 'STAGING_PAYMENT_WORKER_VERIFIED', mode: args.includes('--run') ? 'RUN' : 'VERIFY_ONLY' }));
  }, async () => {
    if (!args.includes('--run')) return 0;
    // This worker exposes no HTTP/auth endpoints. Satisfy the shared config
    // with ephemeral local keys rather than sharing the API's JWT secrets.
    return runChild(new URL('../worker.js', import.meta.url), args.includes('--once') ? ['--once'] : [], {
      ...process.env,
      JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
      JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error(JSON.stringify({ event: 'STAGING_PAYMENT_WORKER_REFUSED' }));
    process.exitCode = 1;
  });
}
