import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSupportService } from './service.js';

// Explicitly opt in with a dedicated local scratch DB. This never uses DATABASE_URL.
const url = process.env.SUPPORT_TEST_DATABASE_URL;
describe.skipIf(!url)('support concurrency on native PostgreSQL', () => {
  let db: PrismaClient;
  let service: ReturnType<typeof createSupportService>;
  beforeAll(async () => {
    const target = new URL(url!);
    if (target.hostname !== '127.0.0.1' || target.pathname !== '/salem_support_review')
      throw new Error(
        'SUPPORT_TEST_DATABASE_URL must name the dedicated local salem_support_review database'
      );
    db = new PrismaClient({ datasources: { db: { url } } });
    // A pre-existing schema is an error: never clear an unknown database.
    await db.$executeRawUnsafe(
      'CREATE TABLE users(id text PRIMARY KEY, username text, role text, status text)'
    );
    const migration = readFileSync(
      new URL(
        '../../../../packages/database/prisma/migrations/20261105013000_member_support/migration.sql',
        import.meta.url
      ),
      'utf8'
    );
    for (const statement of migration
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((s) => s.trim()))
      await db.$executeRawUnsafe(statement);
    service = createSupportService(db);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const input = () => ({
    subject: 'Disposable test request',
    category: 'GENERAL' as const,
    body: 'Only for the isolated concurrency test',
    requestId: randomUUID(),
  });
  let user: string, admin: string;
  beforeEach(async () => {
    user = randomUUID();
    admin = randomUUID();
    await db.$executeRaw`INSERT INTO users VALUES (${user},'member','USER','ACTIVE'),(${admin},'staff','ADMIN','ACTIVE')`;
  });
  it('admits only one of two reopen requests competing for the last slot', async () => {
    const closed = [];
    for (let i = 0; i < 2; i++) {
      const ticket = await service.create(user, input());
      await service.setStatus(user, ticket.id, 'RESOLVED');
      closed.push(ticket.id);
    }
    for (let i = 0; i < 9; i++) await service.create(user, input());
    const results = await Promise.allSettled([
      service.setStatus(user, closed[0], 'OPEN'),
      service.setStatus(admin, closed[1], 'OPEN', true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message
    ).toContain('10 open');
    expect((await service.list(user, false, 0, 'OPEN')).tickets).toHaveLength(10);
  });
  it('serializes creation against reopening for the same owner', async () => {
    const closed = await service.create(user, input());
    await service.setStatus(user, closed.id, 'RESOLVED');
    for (let i = 0; i < 9; i++) await service.create(user, input());
    const results = await Promise.allSettled([
      service.create(user, input()),
      service.setStatus(admin, closed.id, 'OPEN', true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message
    ).toContain('10 open');
    expect((await service.list(user, false, 0, 'OPEN')).tickets).toHaveLength(10);
  });
  it('keeps opposing staff/owner status changes free from lock-order deadlocks', async () => {
    await db.$executeRaw`UPDATE users SET role='ADMIN' WHERE id=${user}`;
    const first = await service.create(user, input());
    const second = await service.create(admin, input());
    for (let i = 0; i < 5; i++) {
      const status = i % 2 ? 'OPEN' : 'RESOLVED';
      await Promise.all([
        service.setStatus(user, second.id, status, true),
        service.setStatus(admin, first.id, status, true),
      ]);
    }
    expect((await service.read(user, first.id)).ticket.status).toBe('RESOLVED');
  });
});
