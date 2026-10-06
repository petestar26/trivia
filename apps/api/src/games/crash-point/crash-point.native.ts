import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createCrashPointService } from './service.js';
import { crashCommitment } from './math.js';
const source = process.env.DATABASE_URL;
const url = source ? new URL(source) : null;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged throwaway database required');
const db = new PrismaClient({ datasourceUrl: source, log: [] }),
  service = createCrashPointService(db);
beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
async function fixture(startIn = 1000, crash = 300) {
  const userId = randomUUID(),
    roundId = randomUUID(),
    starts = new Date(Date.now() + startIn),
    seed = 'a'.repeat(64);
  await db.user.create({
    data: { id: userId, username: `crash_${userId.replaceAll('-', '')}`, isVerified: false },
  });
  await service.snapshot(userId);
  await db.$executeRaw`INSERT INTO crash_point_rounds(id,opens_at,starts_at,ends_at,crash_cents,seed,commitment) VALUES(${roundId},${new Date(starts.getTime() - 15000)},${starts},${new Date(starts.getTime() + 45000)},${crash},${seed},${crashCommitment(roundId, seed)})`;
  return { userId, roundId, starts };
}
const balance = async (id: string) =>
  Number(
    (
      await db.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM crash_point_accounts WHERE user_id=${id}`
    )[0].balance
  );
const wait = async (at: number) => {
  const ms = at - Date.now() + 30;
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
};
it('hides crash and seed before the crash while exposing its commitment', async () => {
  const f = await fixture(2000);
  const s = await service.snapshot(f.userId),
    r = s.rounds.find((r) => r.id === f.roundId)!;
  expect(r).toBeDefined();
  expect(r.crashCents).toBeNull();
  expect(r.seed).toBeNull();
  expect(r.commitment).toHaveLength(64);
});
it('concurrent entry replays debit once; changing a target is denied', async () => {
  const f = await fixture(3000);
  const results = await Promise.all(
    [1, 2, 3].map(() => service.enter(f.userId, f.roundId, 25, 200))
  );
  expect(results.filter((r) => !r.isReplay)).toHaveLength(1);
  expect(await balance(f.userId)).toBe(975);
  await expect(service.enter(f.userId, f.roundId, 25, 201)).rejects.toThrow('cannot be changed');
  expect(await db.wallet.findUnique({ where: { userId: f.userId } })).toBeNull();
});
it('manual concurrent cashouts credit once and replay the immutable receipt', async () => {
  const f = await fixture(500);
  await service.enter(f.userId, f.roundId, 100, null);
  await wait(f.starts.getTime() + 250);
  const responses = await Promise.all([1, 2, 3].map(() => service.cashout(f.userId, f.roundId)));
  expect(responses[0]).toEqual(responses[1]);
  expect(responses[1]).toEqual(responses[2]);
  expect(responses[0]!.payout).toBeGreaterThanOrEqual(100);
  expect(await balance(f.userId)).toBe(900 + responses[0]!.payout);
});
it('auto cashout survives disconnect and restart; the cutoff tie loses', async () => {
  const win = await fixture(400, 300);
  await service.enter(win.userId, win.roundId, 100, 101);
  await wait(win.starts.getTime() + 150);
  const restart = createCrashPointService(db);
  const errors: unknown[] = [];
  await Promise.all([
    restart.tick((_id, e) => errors.push(e)),
    service.tick((_id, e) => errors.push(e)),
  ]);
  expect(errors).toEqual([]);
  const [timing] = await db.$queryRaw<
    { ready: boolean }[]
  >`SELECT clock_timestamp()>=starts_at+interval '100 milliseconds' AS ready FROM crash_point_rounds WHERE id=${win.roundId}`;
  expect(timing.ready).toBe(true);
  expect(await balance(win.userId)).toBe(1001);
  expect(await restart.cashout(win.userId, win.roundId)).toEqual({ payout: 101, paidCents: 101 });
  const loss = await fixture(400, 101);
  await service.enter(loss.userId, loss.roundId, 100, 101);
  await wait(loss.starts.getTime() + 160);
  expect(await restart.cashout(loss.userId, loss.roundId)).toEqual({ payout: 0, paidCents: 0 });
  expect(await balance(loss.userId)).toBe(900);
});
it('a crash is enforced by database time even when the worker has not run', async () => {
  const f = await fixture(350, 100);
  await service.enter(f.userId, f.roundId, 50, null);
  await expect(service.cashout(f.userId, f.roundId)).rejects.toThrow('opens');
  await wait(f.starts.getTime());
  expect(await service.cashout(f.userId, f.roundId)).toEqual({ payout: 0, paidCents: 0 });
  await expect(service.enter(f.userId, f.roundId, 100, null)).rejects.toThrow('cannot be changed');
  const other = await fixture(1500);
  await expect(service.cashout(other.userId, f.roundId)).rejects.toThrow('not found');
});
it('checks cutoff after acquiring the wallet lock and rolls back a late admission', async () => {
  const f = await fixture(500);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (locked = r));
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT user_id FROM crash_point_accounts WHERE user_id=${f.userId} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const entry = service.enter(f.userId, f.roundId, 25, null),
    checked = expect(entry).rejects.toThrow('closed');
  await wait(f.starts.getTime());
  release();
  await holder;
  await checked;
  expect(await balance(f.userId)).toBe(1000);
});
it('database guards prevent fake credits and changed results', async () => {
  const f = await fixture(1000);
  await expect(
    db.$executeRaw`UPDATE crash_point_accounts SET balance=balance+10 WHERE user_id=${f.userId}`
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE crash_point_rounds SET crash_cents=2000 WHERE id=${f.roundId}`
  ).rejects.toThrow();
});
it('concurrent dual-slot entry and settlement debit and credit each slot exactly once', async () => {
  const f = await fixture(2000);
  const entries = await Promise.all(
    [1, 2, 1, 2].map((slot) =>
      service.enter(f.userId, f.roundId, 100, slot === 1 ? 101 : 102, slot)
    )
  );
  expect(entries.filter((e) => !e.isReplay)).toHaveLength(2);
  expect(await balance(f.userId)).toBe(800);
  await wait(f.starts.getTime() + 250);
  const payouts = await Promise.all(
    [1, 2, 1, 2].map((slot) => service.cashout(f.userId, f.roundId, slot))
  );
  expect(payouts.map((p) => p?.payout)).toEqual([101, 102, 101, 102]);
  expect(await balance(f.userId)).toBe(1003);
});
