import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';

// All role/stream changes below are confined to this disposable CI database.
const source = process.env.DATABASE_URL;
const url = source ? new URL(source) : null;
if (
  !url ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
) {
  throw new Error('Worker rehearsal requires the acknowledged loopback throwaway database');
}
const owner = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
const role = `practice_worker_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(24).toString('hex');
const workerUrl = new URL(url);
workerUrl.username = role;
workerUrl.password = password;
workerUrl.searchParams.set('connection_limit', '1');
const runtime = new PrismaClient({ datasourceUrl: workerUrl.toString(), log: [] });
const cli = fileURLToPath(
  new URL('../../../dist/scripts/scheduled-practice-worker.js', import.meta.url)
);
let roleCreated = false;

beforeAll(async () => {
  await owner.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`
  );
  roleCreated = true;
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(
    `GRANT SELECT ON public.scheduled_game_streams, public.scheduled_game_rounds TO "${role}"`
  );
  await owner.$executeRawUnsafe(`GRANT INSERT ON public.scheduled_game_rounds TO "${role}"`);
  await owner.$executeRawUnsafe(
    `GRANT UPDATE (state,outcome,drawn_at) ON public.scheduled_game_rounds TO "${role}"`
  );
});

afterAll(async () => {
  await runtime.$disconnect();
  try {
    if (roleCreated) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  } finally {
    await owner.$disconnect();
  }
});

async function stream() {
  const id = `worker-${randomUUID()}`;
  await owner.$executeRawUnsafe(
    `INSERT INTO public.scheduled_game_streams
    (id,game_key,rules_id,enabled,anchor_ms,betting_ms,reveal_ms,result_ms)
    VALUES ($1,'spin_win',$2,true,pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT,5000,1000,1000)`,
    id,
    SPIN90_RULES_ID
  );
  return id;
}

async function startWorker(streamId: string, enabled = true) {
  const port = await availablePort();
  const child = spawn(process.execPath, [cli, '--loop', `--stream=${streamId}`], {
    env: {
      ...process.env,
      DATABASE_URL: workerUrl.toString(),
      SCHEDULED_PRACTICE_WORKER_ENABLED: String(enabled),
      SCHEDULED_PRACTICE_HEALTH_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  async function health() {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      return { status: response.status, body: await response.json() };
    } catch {
      return null;
    }
  }
  return {
    exited,
    health,
    privateDetailsHidden: () =>
      !output.includes(password) && !output.includes(workerUrl.toString()),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = new AbortController();
      try {
        return await Promise.race([
          exited,
          delay(8_000, undefined, { signal: timer.signal }).then(() => {
            throw new Error('Worker shutdown deadline missed');
          }),
        ]);
      } finally {
        timer.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  };
}

describe('compiled practice worker rehearsal', () => {
  it('uses a dedicated role with no ticket, user, wallet or signing-key reads', async () => {
    const [access] = await runtime.$queryRawUnsafe<
      {
        superuser: boolean;
        bypass: boolean;
        tickets: boolean;
        users: boolean;
        wallet: boolean;
        keys: boolean;
      }[]
    >(`
      SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass,
        pg_catalog.has_table_privilege(current_user,'public.scheduled_practice_tickets','SELECT') AS tickets,
        pg_catalog.has_table_privilege(current_user,'public.users','SELECT') AS users,
        pg_catalog.has_table_privilege(current_user,'public.wallets','SELECT') AS wallet,
        pg_catalog.has_table_privilege(current_user,'public.ledger_approval_keys','SELECT') AS keys
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    expect(access).toEqual({
      superuser: false,
      bypass: false,
      tickets: false,
      users: false,
      wallet: false,
      keys: false,
    });
  });

  it('still refuses to start when its environment switch is off', async () => {
    const worker = await startWorker('spin-win-practice-v1', false);
    try {
      expect(await worker.exited).toEqual({ code: 2, signal: null });
      expect(await worker.health()).toBeNull();
      expect(worker.privateDetailsHidden()).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it('finishes an opened round after pause and preserves it across a process restart', async () => {
    const id = await stream();
    const worker = await startWorker(id);
    let roundId: string;
    let outcome: number | null;
    try {
      await until(async () => (await worker.health())?.status === 200);
      const round = await owner.scheduledGameRound.findFirstOrThrow({ where: { streamId: id } });
      roundId = round.id;
      await owner.scheduledGameStream.update({ where: { id }, data: { enabled: false } });
      await until(
        async () =>
          (await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: roundId } })).state ===
          'DRAWN'
      );
      outcome = (await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: roundId } }))
        .outcome;
      expect(outcome).toBeGreaterThanOrEqual(0);
      expect(outcome).toBeLessThanOrEqual(36);
      expect(worker.privateDetailsHidden()).toBe(true);
    } finally {
      expect(await worker.stop()).toEqual({ code: 0, signal: null });
    }
    const restarted = await startWorker(id);
    try {
      await until(async () => (await restarted.health())?.status === 200);
      const rounds = await owner.scheduledGameRound.findMany({ where: { streamId: id } });
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ id: roundId, state: 'DRAWN', outcome });
      expect(restarted.privateDetailsHidden()).toBe(true);
    } finally {
      expect(await restarted.stop()).toEqual({ code: 0, signal: null });
    }
  });

  it('reports a failed tick as unhealthy, recovers after access is restored, and shuts down', async () => {
    const worker = await startWorker('spin-win-practice-v1');
    try {
      await until(async () => (await worker.health())?.status === 200);
      await owner.$executeRawUnsafe(
        `REVOKE SELECT ON public.scheduled_game_streams FROM "${role}"`
      );
      await until(async () => (await worker.health())?.status === 503);
      expect((await worker.health())?.body).toMatchObject({
        status: 'TICK_FAILED',
        mode: 'PRACTICE',
        coinsAccepted: false,
        ready: false,
      });
      await owner.$executeRawUnsafe(`GRANT SELECT ON public.scheduled_game_streams TO "${role}"`);
      await until(async () => (await worker.health())?.status === 200);
      expect(worker.privateDetailsHidden()).toBe(true);
    } finally {
      await owner.$executeRawUnsafe(`GRANT SELECT ON public.scheduled_game_streams TO "${role}"`);
      expect(await worker.stop()).toEqual({ code: 0, signal: null });
    }
  });
});

async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 12_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Practice worker rehearsal did not reach the expected state');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing rehearsal port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}
