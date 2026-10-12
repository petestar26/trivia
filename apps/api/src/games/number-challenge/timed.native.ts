import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { NUMBER_TIMED_RULES_ID } from '@socialplay/shared';
import { createNumberTimedService } from './timed-service.js';
import { grantNumberRuntimeTables } from '../../scripts/number-runtime-grants.js';
const source = process.env.DATABASE_URL,
  url = source ? new URL(source) : null;
if (
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged throwaway database required');
const db = new PrismaClient({ datasourceUrl: source }),
  service = createNumberTimedService(db);
afterAll(() => db.$disconnect());
async function user() {
  const id = randomUUID();
  await db.user.create({
    data: { id, username: `nt_${id.replaceAll('-', '')}`, status: 'ACTIVE' },
  });
  return id;
}
const entry = (roundId: string, guess = 50) => ({
  roundId,
  guess,
  requestId: randomUUID(),
  rulesId: NUMBER_TIMED_RULES_ID,
});
async function openRound() {
  const [{ ms }] = await db.$queryRaw<
    { ms: number }[]
  >`SELECT (extract(epoch FROM clock_timestamp())*1000)::double precision AS ms`;
  const phase = ms % 60000;
  if (phase > 20000) await new Promise((r) => setTimeout(r, 60000 - phase + 100));
  await service.tick();
}
it('enforces shared deadlines, isolated runtime roles, concurrent admission and immutable result recovery', async () => {
  const a = await user(),
    b = await user(),
    late = await user();
  const suffix = randomUUID().replaceAll('-', ''),
    apiRole = `nt_api_${suffix}`,
    workerRole = `nt_worker_${suffix}`,
    password = randomUUID();
  const clients: PrismaClient[] = [];
  try {
    for (const role of [apiRole, workerRole]) {
      await db.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    }
    await db.$executeRawUnsafe(`GRANT SELECT,UPDATE(id) ON users TO "${apiRole}"`);
    await db.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await grantNumberRuntimeTables(db, apiRole, workerRole);
    for (const role of [apiRole, workerRole]) {
      const u = new URL(source!);
      u.username = role;
      u.password = password;
      clients.push(new PrismaClient({ datasourceUrl: u.toString() }));
    }
    const [api, worker] = clients,
      s = createNumberTimedService(api),
      w = createNumberTimedService(worker);
    await openRound();
    const snap = await s.snapshot(a),
      r = snap.round!;
    expect(r.target).toBeNull();
    expect(new Date(r.closesAt).getTime() - new Date(r.opensAt).getTime()).toBe(30000);
    expect(new Date(r.endsAt).getTime() - new Date(r.opensAt).getTime()).toBe(60000);
    const input = entry(r.id),
      inputB = entry(r.id, 75);
    const responses = await Promise.all(Array.from({ length: 6 }, () => s.play(a, input)));
    expect(responses.filter((r) => !r.isReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.receipt.id)).size).toBe(1);
    expect(responses[0].receipt).toMatchObject({ target: null, away: null, score: null });
    await s.play(b, inputB);
    await expect(s.play(a, entry(r.id))).rejects.toMatchObject({ statusCode: 409 });
    await expect(s.play(a, { ...input, guess: 51 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await s.snapshot(late)).history).toEqual([]);
    await expect(
      api.$executeRaw`UPDATE number_timed_rounds SET target=50 WHERE id=${r.id}`
    ).rejects.toThrow();
    await expect(
      worker.$executeRaw`UPDATE number_timed_rounds SET target=50 WHERE id=${r.id}`
    ).rejects.toThrow('transition refused');
    await expect(
      api.$executeRaw`UPDATE number_timed_entries SET guess=1 WHERE user_id=${a}`
    ).rejects.toThrow();
    await expect(api.wallet.findMany()).rejects.toThrow();
    await expect(
      worker.$executeRaw`INSERT INTO number_timed_entries(id,user_id,round_id,request_id,guess) VALUES(${randomUUID()},${late},${r.id},${randomUUID()},50)`
    ).rejects.toThrow();
    expect(await db.wallet.count({ where: { userId: a } })).toBe(0);
    expect(await db.gameSession.count({ where: { userId: a } })).toBe(0);
    // No worker runs during the closing boundary: never synthesize a target on reads.
    const remaining = Date.parse(r.closesAt) - Date.parse((await s.snapshot(a)).serverNow);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, remaining) + 50));
    expect((await s.snapshot(a)).round?.target).toBeNull();
    await expect(s.play(late, entry(r.id))).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      db.$executeRaw`INSERT INTO number_timed_entries(id,user_id,round_id,request_id,guess) VALUES(${randomUUID()},${late},${r.id},${randomUUID()},50)`
    ).rejects.toThrow('Number entry window closed');
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    const aa = await s.snapshot(a),
      bb = await s.snapshot(b);
    expect(aa.round!.target).toBeGreaterThanOrEqual(1);
    expect(aa.round!.target).toBeLessThanOrEqual(100);
    expect(aa.round!.target).toBe(bb.round!.target);
    expect(aa.receipt!.target).toBe(bb.receipt!.target);
    expect((await s.play(a, input)).receipt).toEqual(aa.receipt);
    await expect(
      worker.$executeRaw`UPDATE number_timed_rounds SET target=1 WHERE id=${r.id}`
    ).rejects.toThrow('transition refused');
    await expect(
      db.$executeRaw`DELETE FROM number_timed_entries WHERE user_id=${a}`
    ).rejects.toThrow('immutable');
    await expect(
      db.$executeRaw`UPDATE number_timed_rounds SET closes_at=ends_at WHERE id=${r.id}`
    ).rejects.toThrow('transition refused');
    await db.user.update({ where: { id: a }, data: { status: 'SUSPENDED' } });
    await expect(s.snapshot(a)).rejects.toMatchObject({ statusCode: 403 });
    await expect(s.play(a, input)).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    for (const c of clients) await c.$disconnect();
    for (const role of [apiRole, workerRole]) {
      await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  }
});
it('rejects v1 or forged input and future/unknown rounds while retaining old history', async () => {
  const id = await user();
  const request = entry('number-v2:99999999999');
  for (const bad of [
    { ...request, roundId: undefined },
    { ...request, target: 50 },
    { ...request, guess: 1.5 },
    { ...request, rulesId: 'number-challenge-practice-v1' },
  ])
    await expect(service.play(id, bad)).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.play(id, request)).rejects.toMatchObject({ statusCode: 409 });
  await db.$executeRaw`INSERT INTO number_practice_rounds(id,user_id,request_id,guess,target,rules_id) VALUES(${randomUUID()},${id},${randomUUID()},50,52,'number-challenge-practice-v1')`;
  expect((await service.snapshot(id)).history[0]).toMatchObject({
    guess: 50,
    target: 52,
    score: 40,
  });
});
