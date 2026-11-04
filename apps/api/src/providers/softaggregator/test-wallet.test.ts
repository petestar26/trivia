import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTestWallet, verifyTestCallback, type TestMovement } from './test-wallet.js';
import { redactUrl } from '../../middleware/log-redaction.js';

const salt = 'isolated-fixture-salt-key',
  now = Date.now();
const username = 'st_' + 'a'.repeat(32);
export function signed(fields: Record<string, string> = {}, at = now) {
  const q = {
    username,
    currency: 'ETB',
    action: 'debit',
    amount: '100',
    call_id: 'call-1',
    timestamp: String(Math.floor(at / 1000)),
    ...fields,
  } as Record<string, string>;
  q.key = createHash('md5')
    .update(q.timestamp + salt)
    .digest('hex');
  const canonical = Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join('&');
  return {
    url: '/sg/callback?' + new URLSearchParams(q),
    signature: createHmac('sha256', salt).update(canonical).digest('hex'),
  };
}
it('requires full payload HMAC and accepts seconds or milliseconds and unknown informational types', () => {
  for (const fields of [
    { type: 'new_bonus_kind' },
    { timestamp: String(now) },
    { action: 'credit', type: 'bonus_fs', rb: '1' },
  ] as Record<string, string>[]) {
    const s = signed(fields);
    expect(verifyTestCallback(s.url, s.signature, salt, now)).not.toBeNull();
    expect(verifyTestCallback(s.url, undefined, salt, now)).toBeNull();
  }
});
it.each([
  'amount',
  'action',
  'username',
  'currency',
  'call_id',
  'round_id',
  'game_id',
  'rb',
  'type',
])('rejects a modified %s', (key) => {
  const s = signed();
  const q = new URLSearchParams(s.url.split('?')[1]);
  q.set(key, 'tampered');
  expect(verifyTestCallback('/sg/callback?' + q, s.signature, salt, now)).toBeNull();
});
it('rejects expired, future, duplicate and ambiguous query parameters', () => {
  for (const at of [now - 32000, now + 32000]) {
    const s = signed({}, at);
    expect(verifyTestCallback(s.url, s.signature, salt, now)).toBeNull();
  }
  const s = signed();
  expect(verifyTestCallback(s.url + '&amount=100', s.signature, salt, now)).toBeNull();
  const ambiguous = signed({ round_id: 'abc&game_id=x' });
  expect(verifyTestCallback(ambiguous.url, ambiguous.signature, salt, now)).toBeNull();
});
it.each(['-1', '1.5', '1e2', 'NaN', '1000000001'])(
  'rejects non-integer or excessive amount %s',
  (amount) => {
    const s = signed({ amount });
    expect(verifyTestCallback(s.url, s.signature, salt, now)).toBeNull();
  }
);
it('removes callback query secrets without regressing invite path redaction', () => {
  const s = signed();
  expect(redactUrl(s.url)).toBe('/sg/callback');
  expect(redactUrl('/api/v1/groups/invites/SECRET?key=private')).not.toContain('SECRET');
  expect(redactUrl('/sg/callback?%6bey=private&username=test')).toBe('/sg/callback');
});

let db: PGlite, wallet: ReturnType<typeof createTestWallet>;
const env = {
  SOFTAGGREGATOR_TEST_ENABLED: 'true',
  SOFTAGGREGATOR_TEST_CALLBACK_ENABLED: 'true',
  SOFTAGGREGATOR_TEST_USER_IDS: '',
};
const sql = (s: TemplateStringsArray) => s.reduce((q, p, i) => q + (i ? `$${i}` : '') + p, '');
const adapter = (c: any): any => ({
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s), v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await c.query(sql(s), v)).affectedRows,
});
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    'CREATE TABLE users(id text PRIMARY KEY,status text); CREATE TABLE wallets(balance bigint); INSERT INTO wallets VALUES(456789); CREATE TABLE ledger_entries(amount bigint); INSERT INTO ledger_entries VALUES(98765);'
  );
  await db.exec(
    readFileSync(
      new URL(
        '../../../../../packages/database/prisma/migrations/20261105200000_softaggregator_test_wallet/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  wallet = createTestWallet(
    { ...adapter(db), $transaction: (f: any) => db.transaction((tx) => f(adapter(tx))) } as any,
    env
  );
});
afterAll(async () => {
  expect((await db.query('SELECT * FROM wallets')).rows).toEqual([{ balance: 456789 }]);
  expect((await db.query('SELECT * FROM ledger_entries')).rows).toEqual([{ amount: 98765 }]);
  await db.close();
});
async function player() {
  const id = randomUUID();
  await db.query("INSERT INTO users VALUES($1,'ACTIVE')", [id]);
  env.SOFTAGGREGATOR_TEST_USER_IDS += ',' + id;
  return { id, ...(await wallet.ensurePlayer(id)) };
}
const movement = (p: { username: string }, fields: Partial<TestMovement> = {}): TestMovement => ({
  username: p.username,
  currency: 'ETB',
  action: 'debit',
  amount: 125,
  callId: randomUUID(),
  roundId: '',
  gameId: 'unknown/retired-title',
  rollback: '0',
  ...fields,
});
it('creates the same isolated test player once and never provisions non-testers', async () => {
  const p = await player();
  expect((await wallet.ensurePlayer(p.id)).username).toBe(p.username);
  expect((await wallet.snapshot(p.id)).balanceCents).toBe(100000);
  await expect(wallet.ensurePlayer('customer')).rejects.toThrow('TEST_ACCESS_REFUSED');
});
it('debits cents exactly once and replays the original receipt after later credits', async () => {
  const p = await player(),
    m = movement(p);
  expect(await wallet.apply(m)).toEqual({ error: 0, balance: 99875 });
  await wallet.apply(movement(p, { action: 'credit', amount: 300 }));
  expect(await wallet.apply(m)).toEqual({ error: 0, balance: 99875 });
  expect((await wallet.snapshot(p.id)).balanceCents).toBe(100175);
});
it('credits a bonus without a debit and treats rollback as the specified action', async () => {
  const p = await player();
  expect(await wallet.apply(movement(p, { action: 'credit', amount: 777, rollback: '1' }))).toEqual(
    { error: 0, balance: 100777 }
  );
  expect(await wallet.apply(movement(p, { amount: 7, rollback: '1' }))).toEqual({
    error: 0,
    balance: 100770,
  });
});
it('rejects insufficient funds without moving balance and preserves retry outcomes', async () => {
  const p = await player(),
    m = movement(p, { amount: 100001 });
  expect(await wallet.apply(m)).toEqual({ error: 1, balance: 100000 });
  expect(await wallet.apply(m)).toEqual({ error: 1, balance: 100000 });
  expect((await wallet.snapshot(p.id)).balanceCents).toBe(100000);
});
it('rejects call-id reuse with changed financial fields or another player', async () => {
  const a = await player(),
    b = await player(),
    m = movement(a);
  await wallet.apply(m);
  expect(await wallet.apply({ ...m, amount: 126 })).toEqual({ error: 2, balance: 0 });
  expect(await wallet.apply({ ...m, username: b.username })).toEqual({ error: 2, balance: 0 });
  expect((await wallet.snapshot(b.id)).balanceCents).toBe(100000);
});
it('serializes duplicate requests and concurrent spending without overdrawing', async () => {
  const p = await player(),
    m = movement(p, { amount: 60000 });
  const results = await Promise.all([
    wallet.apply(m),
    wallet.apply(m),
    wallet.apply(movement(p, { amount: 60000 })),
  ]);
  expect(results.map((r) => r.error)).toEqual([0, 0, 1]);
  expect((await wallet.snapshot(p.id)).balanceCents).toBe(40000);
});
it('blocks new debits on disabled test access but still settles credits and exact retries', async () => {
  const p = await player(),
    m = movement(p);
  await wallet.apply(m);
  env.SOFTAGGREGATOR_TEST_ENABLED = 'false';
  try {
    expect((await wallet.apply(m)).error).toBe(0);
    expect((await wallet.apply(movement(p))).error).toBe(2);
    expect((await wallet.apply(movement(p, { action: 'credit', amount: 200 }))).error).toBe(0);
  } finally {
    env.SOFTAGGREGATOR_TEST_ENABLED = 'true';
  }
});
it('refuses unknown players, currency mismatches and suspended test debits', async () => {
  expect(await wallet.apply(movement({ username }))).toEqual({ error: 2, balance: 0 });
  const p = await player();
  expect(await wallet.apply({ ...movement(p), currency: 'USD' } as any)).toEqual({
    error: 2,
    balance: 0,
  });
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [p.id]);
  expect((await wallet.apply(movement(p))).error).toBe(2);
});
it('database refuses unbacked balance edits and receipt changes', async () => {
  const p = await player(),
    m = movement(p);
  await wallet.apply(m);
  await expect(
    db.query('UPDATE sg_test_players SET balance_cents=999999 WHERE user_id=$1', [p.id])
  ).rejects.toThrow('reconcile');
  await expect(
    db.query('UPDATE sg_test_movements SET amount_cents=1 WHERE call_id=$1', [m.callId])
  ).rejects.toThrow('immutable');
  await expect(db.query('DELETE FROM sg_test_players WHERE user_id=$1', [p.id])).rejects.toThrow(
    'immutable'
  );
});
