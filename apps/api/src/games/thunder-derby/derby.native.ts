import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createDerbyService } from './service.js';
import { derbyCommitment, derbyOrder } from './math.js';
const source = process.env.DATABASE_URL,
  url = source ? new URL(source) : null;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged throwaway database required');
const db = new PrismaClient({ datasourceUrl: source, log: [] }),
  service = createDerbyService(db);
beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
async function fixture(startIn = 3000, userId = randomUUID(), field: 6 | 8 = 6) {
  const exists = await db.user.findUnique({ where: { id: userId } });
  if (!exists)
    await db.user.create({
      data: { id: userId, username: `derby_${userId.replaceAll('-', '')}`, isVerified: false },
    });
  const roundId = randomUUID(),
    seed = 'c'.repeat(64),
    starts = new Date(Date.now() + startIn);
  await db.$executeRaw`INSERT INTO derby_rounds(id,field,opens_at,starts_at,finishes_at,ends_at,finish_order,seed,commitment) VALUES(${roundId},${field},${new Date(starts.getTime() - (field * 30000 - 60000))},${starts},${new Date(starts.getTime() + 45000)},${new Date(starts.getTime() + 60000)},${derbyOrder(seed, field)}::integer[],${seed},${derbyCommitment(roundId, seed)})`;
  return { userId, roundId, starts, order: derbyOrder(seed, field) };
}
const balance = async (id: string) =>
  Number(
    (
      await db.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM derby_accounts WHERE user_id=${id}`
    )[0].balance
  );
const wait = async (at: number) => {
  const ms = at - Date.now() + 40;
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};
it('concurrent confirmations debit exactly once and reject altered retries', async () => {
  const f = await fixture();
  const results = await Promise.all(
    [1, 2, 3].map(() => service.enter(f.userId, f.roundId, 6, 'WIN', [1], 25))
  );
  expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
  expect(await balance(f.userId)).toBe(975);
  await expect(service.enter(f.userId, f.roundId, 6, 'WIN', [2], 25)).rejects.toThrow(
    'cannot be changed'
  );
  expect(await db.wallet.findUnique({ where: { userId: f.userId } })).toBeNull();
});
it('hides seed and outcome before the finish, including while racing', async () => {
  const f = await fixture(-1000);
  const snap = await service.snapshot(f.userId, 6),
    r = snap.rounds.find((r) => r.id === f.roundId)!;
  expect(r).toBeDefined();
  expect(r.seed).toBeNull();
  expect(r.order).toBeNull();
  expect(r.commitment).toHaveLength(64);
  expect(r.positions).toHaveLength(6);
  await expect(service.enter(f.userId, f.roundId, 6, 'WIN', [1], 25)).rejects.toThrow('closed');
});
it('locks the account across races to prevent overdrawing', async () => {
  const a = await fixture(),
    b = await fixture(3000, a.userId),
    c = await fixture(3000, a.userId);
  const results = await Promise.allSettled(
    [a, b, c].map((f) => service.enter(f.userId, f.roundId, 6, 'WIN', [1], 500))
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  expect(await balance(a.userId)).toBe(0);
});
it('checks the cutoff after waiting for an account lock', async () => {
  const f = await fixture(500);
  await service.snapshot(f.userId, 6);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (locked = r));
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT user_id FROM derby_accounts WHERE user_id=${f.userId} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const assertion = expect(service.enter(f.userId, f.roundId, 6, 'WIN', [1], 25)).rejects.toThrow(
    'closed'
  );
  await wait(f.starts.getTime());
  release();
  await holder;
  await assertion;
  expect(await balance(f.userId)).toBe(1000);
});
it('rejects suspended accounts and cross-field admissions', async () => {
  const f = await fixture();
  await expect(service.enter(f.userId, f.roundId, 8, 'WIN', [1], 25)).rejects.toThrow('not found');
  await db.user.update({ where: { id: f.userId }, data: { status: 'SUSPENDED' } });
  await expect(service.snapshot(f.userId, 6)).rejects.toThrow('active account');
  await expect(service.enter(f.userId, f.roundId, 6, 'WIN', [1], 25)).rejects.toThrow(
    'active account'
  );
});
it('guards credits, picks, early payouts and immutable race results at the database', async () => {
  const f = await fixture();
  await service.enter(f.userId, f.roundId, 6, 'WIN', [1], 25);
  await expect(
    db.$executeRaw`UPDATE derby_accounts SET balance=balance+1 WHERE user_id=${f.userId}`
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE derby_tickets SET picks=ARRAY[2] WHERE user_id=${f.userId}`
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE derby_tickets SET payout=135,settled_at=${new Date(f.starts.getTime() + 45000)} WHERE user_id=${f.userId}`
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE derby_rounds SET finish_order=ARRAY[1,2,3,4,5,6] WHERE id=${f.roundId}`
  ).rejects.toThrow();
});
it('settles a winning and losing ticket once after reconnect and concurrent worker recovery', async () => {
  const win = await fixture(900),
    loss = await fixture(900);
  await service.enter(win.userId, win.roundId, 6, 'WIN', [win.order[0]], 100);
  await service.enter(loss.userId, loss.roundId, 6, 'WIN', [loss.order[1]], 100);
  await wait(Math.max(win.starts.getTime(), loss.starts.getTime()) + 45000);
  const errors: unknown[] = [];
  await Promise.all([
    service.tick((_, e) => errors.push(e)),
    createDerbyService(db).tick((_, e) => errors.push(e)),
  ]);
  expect(errors).toEqual([]);
  expect(await balance(win.userId)).toBe(1440);
  expect(await balance(loss.userId)).toBe(900);
  expect(await service.enter(win.userId, win.roundId, 6, 'WIN', [win.order[0]], 100)).toEqual({
    accepted: true,
    isReplay: true,
  });
  await service.tick();
  expect(await balance(win.userId)).toBe(1440);
  const [receipt] = await db.$queryRaw<
    { payout: number }[]
  >`SELECT payout FROM derby_tickets WHERE round_id=${win.roundId}`;
  expect(receipt.payout).toBe(540);
}, 60000);

it('restricted runtime can admit and recover a race but cannot edit outcomes or delete history', async () => {
  const { grantDerbyRuntimeTables } = await import('../../scripts/derby-runtime-grants.js');
  const role = `derby_probe_${randomUUID().replaceAll('-', '')}`;
  await db.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${decodeURIComponent(url!.password).replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
  );
  const runtimeUrl = new URL(source!);
  runtimeUrl.username = role;
  const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
  try {
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(id) ON users TO "${role}"`);
    await grantDerbyRuntimeTables(db, role);
    const f = await fixture(5000),
      restricted = createDerbyService(runtime);
    expect((await restricted.snapshot(f.userId, 6)).balance).toBe(1000);
    await restricted.enter(f.userId, f.roundId, 6, 'TOP3', [f.order[0]], 100);
    await expect(
      runtime.$executeRaw`UPDATE derby_rounds SET finish_order=ARRAY[1,2,3,4,5,6] WHERE id=${f.roundId}`
    ).rejects.toThrow('permission denied');
    await expect(
      runtime.$executeRaw`DELETE FROM derby_rounds WHERE id=${f.roundId}`
    ).rejects.toThrow('permission denied');
    await expect(
      runtime.$executeRaw`UPDATE derby_rounds SET id=id WHERE id=${f.roundId}`
    ).rejects.toThrow('immutable');
    await wait(f.starts.getTime() + 45000);
    const errors: unknown[] = [];
    await restricted.tick((_, e) => errors.push(e));
    expect(errors).toEqual([]);
    expect((await restricted.snapshot(f.userId, 6)).balance).toBe(1080);
  } finally {
    await runtime.$disconnect();
    await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
}, 70000);

it('admits an eight-runner selection with the correct fixed odds', async () => {
  const f = await fixture(3000, randomUUID(), 8);
  await service.enter(f.userId, f.roundId, 8, 'WIN', [8], 25);
  const snap = await service.snapshot(f.userId, 8);
  const r = snap.rounds.find((r) => r.id === f.roundId)!;
  expect(r.field).toBe(8);
  expect(r.positions).toHaveLength(8);
  expect(r.ticket?.oddsCents).toBe(720);
  expect(snap.balance).toBe(975);
});
