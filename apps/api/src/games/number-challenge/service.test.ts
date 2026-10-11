import { expect, it, vi } from 'vitest';
import { createNumberService } from './service.js';
const input = { guess: 50, requestId: 'abcdefghijklmnop', rulesId: 'number-challenge-practice-v1' };
const row = {
  id: 'receipt',
  guess: 50,
  target: 52,
  rules_id: input.rulesId,
  created_at: new Date('2026-10-12T00:00:00Z'),
};
function db(prior: unknown[] = [], status = 'ACTIVE', count = 0) {
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join('?');
    if (sql.includes('FROM users')) return [{ status }];
    if (sql.includes('request_id=')) return prior;
    if (sql.includes('count(*)')) return [{ count: BigInt(count) }];
    if (sql.includes('INSERT INTO')) return [row];
    return [];
  });
  return {
    query,
    database: {
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: query }),
    } as never,
  };
}
it('rejects invalid input without touching the database', async () => {
  const x = db();
  await expect(
    createNumberService(x.database).play('u', { ...input, target: 50 })
  ).rejects.toThrow();
  expect(x.query).not.toHaveBeenCalled();
});
it('returns a stored receipt without drawing or inserting', async () => {
  const x = db([row]);
  const result = await createNumberService(x.database).play('u', input);
  expect(result).toMatchObject({
    isReplay: true,
    round: { guess: 50, target: 52, score: 40, away: 2 },
  });
  expect(x.query.mock.calls.some((c) => c[0].join('').includes('INSERT'))).toBe(false);
});
it('rejects changed payload on a replay key', async () => {
  const x = db([row]);
  await expect(
    createNumberService(x.database).play('u', { ...input, guess: 51 })
  ).rejects.toMatchObject({ statusCode: 409 });
});
it('locks and checks active membership before reads or writes', async () => {
  const x = db([], 'BANNED');
  await expect(createNumberService(x.database).play('u', input)).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(x.query).toHaveBeenCalledTimes(2);
});
it('bounds new rounds but lets an existing receipt be recovered', async () => {
  const x = db([], 'ACTIVE', 15);
  await expect(createNumberService(x.database).play('u', input)).rejects.toMatchObject({
    statusCode: 429,
  });
  const y = db([row], 'ACTIVE', 15);
  expect((await createNumberService(y.database).play('u', input)).isReplay).toBe(true);
});
