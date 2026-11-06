import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { createSupportService } from './service.js';
let pg: PGlite, service: ReturnType<typeof createSupportService>;
const user = 'member',
  other = 'other',
  admin = 'admin';
const sql = (parts: TemplateStringsArray) =>
  parts.reduce((s, p, i) => s + (i ? `$${i}` : '') + p, '');
const adapter = (c: any): any => ({
  $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s), v)).rows,
  $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) =>
    (await c.query(sql(s), v)).affectedRows,
});
const input = () => ({
  subject: 'Game did not load',
  category: 'GAME' as const,
  body: 'A game would not open.',
  requestId: randomUUID(),
});
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(
    "CREATE TABLE users(id text PRIMARY KEY,username text,role text,status text);INSERT INTO users VALUES('member','member','USER','ACTIVE'),('other','other','USER','ACTIVE'),('admin','staff','ADMIN','ACTIVE');CREATE TABLE wallets(balance int);INSERT INTO wallets VALUES(71829);"
  );
  await pg.exec(
    readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261105013000_member_support/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  service = createSupportService({
    ...adapter(pg),
    $transaction: (fn: any) => pg.transaction((tx) => fn(adapter(tx))),
  } as any);
});
afterEach(async () => {
  expect((await pg.query('SELECT balance FROM wallets')).rows).toEqual([{ balance: 71829 }]);
  await pg.close();
});
it('creates one private request and replays the same submission without a duplicate', async () => {
  const body = input();
  const a = await service.create(user, body);
  expect(await service.create(user, body)).toEqual(a);
  expect((await service.list(user)).tickets).toHaveLength(1);
  expect((await service.list(other)).tickets).toHaveLength(0);
  expect((await service.read(user, a.id)).messages).toHaveLength(1);
  await expect(service.create(user, { ...body, body: 'Changed' })).rejects.toThrow(
    'different content'
  );
});
it('blocks cross-member reads, replies and state changes', async () => {
  const { id } = await service.create(user, input());
  await expect(service.read(other, id)).rejects.toThrow('not found');
  await expect(
    service.reply(other, id, { body: 'steal', requestId: randomUUID() })
  ).rejects.toThrow('not found');
  await expect(service.setStatus(other, id, 'RESOLVED')).rejects.toThrow('not found');
});
it('supports an admin reply, idempotent retry and member follow-up', async () => {
  const { id } = await service.create(user, input());
  const message = { body: 'Please try the game again.', requestId: randomUUID() };
  const first = await service.reply(admin, id, message, true);
  expect(await service.reply(admin, id, message, true)).toEqual(first);
  const thread = await service.read(user, id);
  expect(thread.ticket.last_sender).toBe('ADMIN');
  expect(thread.messages[1]).toMatchObject({ staff: true, body: message.body });
  await service.reply(user, id, { body: 'It works now.', requestId: randomUUID() });
  expect((await service.read(admin, id, true)).messages).toHaveLength(3);
});
it('closes and reopens a request, but never accepts a new reply while resolved', async () => {
  const { id } = await service.create(user, input());
  await service.setStatus(admin, id, 'RESOLVED', true);
  await expect(service.reply(user, id, { body: 'Hello', requestId: randomUUID() })).rejects.toThrow(
    'Reopen'
  );
  await service.setStatus(user, id, 'OPEN');
  await service.reply(user, id, { body: 'Another issue', requestId: randomUUID() });
  expect((await service.list(admin, true, 0, 'OPEN')).tickets).toHaveLength(1);
});
it('rechecks staff authority after demotion and rejects inactive members', async () => {
  const { id } = await service.create(user, input());
  await expect(service.read(user, id, true)).rejects.toThrow('Administrator');
  await pg.query("UPDATE users SET role='USER' WHERE id=$1", [admin]);
  await expect(service.list(admin, true)).rejects.toThrow('Administrator');
  await pg.query("UPDATE users SET status='SUSPENDED' WHERE id=$1", [user]);
  await expect(service.read(user, id)).rejects.toThrow('active account');
});
it('bounds open tickets but still permits an idempotent retry at the limit', async () => {
  const first = input();
  await service.create(user, first);
  for (let i = 0; i < 9; i++) await service.create(user, input());
  await expect(service.create(user, input())).rejects.toThrow('10 open');
  expect(await service.create(user, first)).toHaveProperty('id');
});
it.each([false, true])(
  'applies the owner cap when reopening, including staff actions (staff=%s)',
  async (staff) => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const { id } = await service.create(user, input());
      await service.setStatus(user, id, 'RESOLVED');
      ids.push(id);
    }
    const actor = staff ? admin : user;
    for (const id of ids.slice(0, 10)) await service.setStatus(actor, id, 'OPEN', staff);
    await expect(service.setStatus(actor, ids[10], 'OPEN', staff)).rejects.toThrow('10 open');
    expect((await service.list(user, false, 0, 'OPEN')).tickets).toHaveLength(10);
    const before = (await service.read(user, ids[0])).ticket;
    expect(await service.setStatus(actor, ids[0], 'OPEN', staff)).toEqual({ status: 'OPEN' });
    expect((await service.read(user, ids[0])).ticket).toEqual(before);
    await service.setStatus(actor, ids[0], 'RESOLVED', staff);
    await service.setStatus(actor, ids[10], 'OPEN', staff);
    expect((await service.list(user, false, 0, 'OPEN')).tickets).toHaveLength(10);
    expect((await service.list(admin, false, 0, 'OPEN')).tickets).toHaveLength(0);
  }
);
it('paginates long conversations and rejects changed message retries', async () => {
  const { id } = await service.create(user, input());
  const message = { body: 'Reply', requestId: randomUUID() };
  await service.reply(admin, id, message, true);
  await expect(service.reply(admin, id, { ...message, body: 'Changed' }, true)).rejects.toThrow(
    'different content'
  );
  for (let i = 0; i < 49; i++)
    await service.reply(user, id, { body: `Message ${i}`, requestId: randomUUID() });
  const latest = await service.read(user, id);
  const earlier = await service.read(user, id, false, 1);
  expect(latest.messages).toHaveLength(50);
  expect(latest.hasMore).toBe(true);
  expect(earlier.messages).toHaveLength(1);
  expect(earlier.hasMore).toBe(false);
  expect(new Set([...latest.messages, ...earlier.messages].map((m) => m.id)).size).toBe(51);
});
