import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createNumberService } from './service.js';
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
  service = createNumberService(db);
afterAll(() => db.$disconnect());
async function user() {
  const id = randomUUID();
  await db.user.create({
    data: { id, username: `nc_${id.replaceAll('-', '')}`, status: 'ACTIVE' },
  });
  return id;
}
const entry = (guess = 50) => ({
  guess,
  requestId: randomUUID(),
  rulesId: 'number-challenge-practice-v1',
});
it('concurrent identical requests return one immutable result, with no wallet activity', async () => {
  const id = await user(),
    request = entry();
  const responses = await Promise.all(Array.from({ length: 6 }, () => service.play(id, request)));
  expect(responses.filter((r) => !r.isReplay)).toHaveLength(1);
  expect(new Set(responses.map((r) => r.round.id)).size).toBe(1);
  expect(new Set(responses.map((r) => r.round.target)).size).toBe(1);
  expect((await service.snapshot(id)).rounds).toHaveLength(1);
  expect(await db.wallet.count({ where: { userId: id } })).toBe(0);
  expect(await db.gameSession.count({ where: { userId: id } })).toBe(0);
  await expect(
    db.$executeRaw`UPDATE number_practice_rounds SET target=1 WHERE user_id=${id}`
  ).rejects.toThrow('immutable');
  await expect(
    db.$executeRaw`DELETE FROM number_practice_rounds WHERE user_id=${id}`
  ).rejects.toThrow('immutable');
  await expect(service.play(id, { ...request, guess: 51 })).rejects.toMatchObject({
    statusCode: 409,
  });
});
it('isolates receipts by account, rejects suspended users and rejects forged fields', async () => {
  const a = await user(),
    b = await user(),
    request = entry(100);
  await service.play(a, request);
  expect((await service.snapshot(b)).rounds).toEqual([]);
  const other = await service.play(b, request);
  expect(other.isReplay).toBe(false);
  await db.user.update({ where: { id: a }, data: { status: 'SUSPENDED' } });
  await expect(service.play(a, request)).rejects.toMatchObject({ statusCode: 403 });
  await expect(service.snapshot(a)).rejects.toMatchObject({ statusCode: 403 });
  for (const bad of [
    { ...entry(), target: 50 },
    { ...entry(), score: 100 },
    { ...entry(), guess: 0 },
    { ...entry(), guess: 1.5 },
  ])
    await expect(service.play(b, bad)).rejects.toMatchObject({ statusCode: 400 });
});
it('bounds concurrent new requests across connections but permits replay at the limit', async () => {
  const id = await user(),
    request = entry(1);
  const original = await service.play(id, request);
  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, () => service.play(id, entry()))
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(14);
  expect((await service.snapshot(id)).rounds).toHaveLength(15);
  expect((await service.play(id, request)).round).toEqual(original.round);
});
it('enforces stored input bounds even for direct SQL', async () => {
  const id = await user();
  await expect(
    db.$executeRaw`INSERT INTO number_practice_rounds(id,user_id,request_id,guess,target,rules_id) VALUES(${randomUUID()},${id},${randomUUID()},0,101,'number-challenge-practice-v1')`
  ).rejects.toThrow();
});

it('runs under a role with receipt SELECT/INSERT only and no wallet access', async () => {
  const id = await user(),
    role = `nc_runtime_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  await db.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT SELECT, UPDATE(id) ON users TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT ON number_practice_rounds TO "${role}"`);
  const restrictedUrl = new URL(source!);
  restrictedUrl.username = role;
  restrictedUrl.password = password;
  const restricted = new PrismaClient({ datasourceUrl: restrictedUrl.toString() });
  try {
    const s = createNumberService(restricted),
      request = entry();
    const r = await s.play(id, request);
    expect((await s.play(id, request)).round).toEqual(r.round);
    expect((await s.snapshot(id)).rounds).toHaveLength(1);
    await expect(
      restricted.$executeRaw`UPDATE number_practice_rounds SET target=1 WHERE user_id=${id}`
    ).rejects.toThrow();
    await expect(restricted.wallet.findMany()).rejects.toThrow();
  } finally {
    await restricted.$disconnect();
    await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
});
