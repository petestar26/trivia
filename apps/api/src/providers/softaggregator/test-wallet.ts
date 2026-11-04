import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type Env = Record<string, string | undefined>;
export type WalletReply = { error: 0 | 1 | 2; balance: number };
export type TestMovement = {
  username: string;
  currency: 'ETB';
  action: 'balance' | 'debit' | 'credit';
  callId: string;
  amount: number;
  roundId: string;
  gameId: string;
  rollback: string;
};
export const TEST_OPENING_CENTS = 100_000;
const MAX_CENTS = 1_000_000_000;
export const testIds = (env: Env) =>
  (env.SOFTAGGREGATOR_TEST_USER_IDS ?? env.SOFTAGGREGATOR_DEMO_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export const callbackSalt = (env: Env) => (env.SOFTAGGREGATOR_SALT_KEY ?? '').trim();
export const testAccess = (env: Env, id: string) =>
  env.SOFTAGGREGATOR_TEST_ENABLED === 'true' && testIds(env).includes(id);
const matches = (actual: string | undefined, expected: Buffer, size: number) =>
  typeof actual === 'string' &&
  new RegExp(`^[a-fA-F0-9]{${size}}$`).test(actual) &&
  timingSafeEqual(Buffer.from(actual, 'hex'), expected);

/** Validate the raw decoded query before any framework coercion. All fields are signed. */
export function verifyTestCallback(
  rawUrl: string,
  signature: string | undefined,
  salt: string,
  now = Date.now()
): TestMovement | null {
  if (salt.length < 16 || rawUrl.length > 8192) return null;
  const raw = rawUrl.split('?')[1] ?? '';
  if (/%(?![a-fA-F0-9]{2})/.test(raw)) return null;
  const pairs = [...new URLSearchParams(raw)];
  if (
    pairs.length > 32 ||
    new Set(pairs.map(([k]) => k)).size !== pairs.length ||
    pairs.some(
      ([k, v]) => !/^[a-zA-Z0-9_]+$/.test(k) || v.length > 1024 || /[&=\u0000-\u001f\ufffd]/.test(v)
    )
  )
    return null;
  const q = Object.fromEntries(pairs);
  if (
    !/^(\d{10}|\d{13})$/.test(q.timestamp ?? '') ||
    Math.abs(now - Number(q.timestamp) * (q.timestamp.length === 10 ? 1000 : 1)) > 30_000
  )
    return null;
  if (
    !matches(
      q.key,
      createHash('md5')
        .update(q.timestamp + salt)
        .digest(),
      32
    )
  )
    return null;
  const canonical = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  if (!matches(signature, createHmac('sha256', salt).update(canonical).digest(), 64)) return null;
  if (
    !/^st_[a-f0-9]{32}$/.test(q.username ?? '') ||
    q.currency !== 'ETB' ||
    !['balance', 'debit', 'credit'].includes(q.action) ||
    !q.call_id ||
    q.call_id.length > 256
  )
    return null;
  if (
    q.action !== 'balance' &&
    (!/^\d{1,10}$/.test(q.amount ?? '') || Number(q.amount) > MAX_CENTS)
  )
    return null;
  if (
    (q.round_id?.length ?? 0) > 256 ||
    (q.game_id?.length ?? 0) > 256 ||
    !['0', '1'].includes(q.rb ?? '0')
  )
    return null;
  return {
    username: q.username,
    currency: 'ETB',
    action: q.action as TestMovement['action'],
    callId: q.call_id,
    amount: q.action === 'balance' ? 0 : Number(q.amount),
    roundId: q.round_id ?? '',
    gameId: q.game_id ?? '',
    rollback: q.rb ?? '0',
  };
}

type Player = { user_id: string; username: string; balance_cents: bigint; status?: string };
type Receipt = { request_hash: string; error: 0 | 1 | 2; balance_cents: bigint };
export function createTestWallet(db: PrismaClient, env: Env = process.env) {
  async function ensurePlayer(userId: string) {
    if (!testAccess(env, userId)) throw new Error('TEST_ACCESS_REFUSED');
    return db.$transaction(async (tx) => {
      const users = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM users WHERE id=${userId} FOR SHARE`;
      if (users[0]?.status !== 'ACTIVE') throw new Error('TEST_ACCESS_REFUSED');
      const username = `st_${randomBytes(16).toString('hex')}`;
      await tx.$executeRaw`INSERT INTO sg_test_players(user_id,username) VALUES(${userId},${username}) ON CONFLICT(user_id) DO NOTHING`;
      const rows = await tx.$queryRaw<
        Player[]
      >`SELECT user_id,username,balance_cents FROM sg_test_players WHERE user_id=${userId}`;
      return rows[0]!;
    });
  }
  async function snapshot(userId: string) {
    if (!testAccess(env, userId)) throw new Error('TEST_ACCESS_REFUSED');
    return db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Player[]
      >`SELECT user_id,username,balance_cents FROM sg_test_players WHERE user_id=${userId} FOR SHARE`;
      if (!rows[0]) return { balanceCents: TEST_OPENING_CENTS, created: false, movements: [] };
      const events = await tx.$queryRaw<
        { action: string; amount_cents: bigint; error: number; created_at: Date }[]
      >`
        SELECT action,amount_cents,error,created_at FROM sg_test_movements WHERE username=${rows[0].username} ORDER BY created_at DESC,call_id DESC LIMIT 20`;
      return {
        balanceCents: Number(rows[0].balance_cents),
        created: true,
        movements: events.map((e) => ({
          action: e.action,
          amountCents: Number(e.amount_cents),
          error: e.error,
          at: e.created_at.toISOString(),
        })),
      };
    });
  }
  async function apply(m: TestMovement): Promise<WalletReply> {
    if (env.SOFTAGGREGATOR_TEST_CALLBACK_ENABLED !== 'true') return { error: 2, balance: 0 };
    return db.$transaction(
      async (tx) => {
        // Serialize a player's movements; global call_id uniqueness also stops reuse across players.
        const players = await tx.$queryRaw<
          Player[]
        >`SELECT p.user_id,p.username,p.balance_cents,u.status FROM sg_test_players p JOIN users u ON u.id=p.user_id WHERE p.username=${m.username} FOR UPDATE OF p`;
        const p = players[0];
        if (!p || m.currency !== 'ETB') return { error: 2, balance: 0 };
        const balance = Number(p.balance_cents);
        if (m.action === 'balance') return { error: 0, balance };
        if (!Number.isSafeInteger(m.amount) || m.amount < 0 || m.amount > MAX_CENTS)
          return { error: 2, balance: 0 };
        const fingerprint = createHash('sha256').update(JSON.stringify(m)).digest('hex');
        const replay = (r: Receipt): WalletReply =>
          r.request_hash === fingerprint
            ? { error: r.error, balance: Number(r.balance_cents) }
            : { error: 2, balance: 0 };
        const previous = await tx.$queryRaw<
          Receipt[]
        >`SELECT request_hash,error,balance_cents FROM sg_test_movements WHERE call_id=${m.callId}`;
        if (previous[0]) return replay(previous[0]);
        let error: WalletReply['error'] = 0;
        let after = balance;
        if (m.action === 'debit' && (!testAccess(env, p.user_id) || p.status !== 'ACTIVE'))
          error = 2;
        else if (m.action === 'debit' && m.amount > balance) error = 1;
        else after += m.action === 'debit' ? -m.amount : m.amount;
        if (after > 9_000_000_000_000) return { error: 2, balance: 0 };
        const inserted = await tx.$queryRaw<
          { call_id: string }[]
        >`INSERT INTO sg_test_movements(call_id,username,request_hash,action,amount_cents,error,balance_cents,round_id,game_id,rollback)
        VALUES(${m.callId},${m.username},${fingerprint},${m.action},${m.amount},${error},${after},${m.roundId},${m.gameId},${m.rollback === '1'}) ON CONFLICT(call_id) DO NOTHING RETURNING call_id`;
        if (!inserted.length) {
          const raced = await tx.$queryRaw<
            Receipt[]
          >`SELECT request_hash,error,balance_cents FROM sg_test_movements WHERE call_id=${m.callId}`;
          return raced[0] ? replay(raced[0]) : { error: 2, balance: 0 };
        }
        if (!error)
          await tx.$executeRaw`UPDATE sg_test_players SET balance_cents=${after} WHERE username=${m.username}`;
        return { error, balance: after };
      },
      { timeout: 10_000 }
    );
  }
  return { ensurePlayer, snapshot, apply };
}
