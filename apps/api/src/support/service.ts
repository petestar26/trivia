import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { ApiError } from '../middleware/api-error.js';
type Tx = Prisma.TransactionClient;
type Ticket = {
  id: string;
  user_id: string;
  subject: string;
  category: string;
  status: 'OPEN' | 'RESOLVED';
  last_sender: 'USER' | 'ADMIN';
  created_at: Date;
  updated_at: Date;
};
type Message = {
  id: string;
  ticket_id: string;
  sender_id: string;
  staff: boolean;
  body: string;
  created_at: Date;
};
export type NewTicket = {
  subject: string;
  category: 'GENERAL' | 'ACCOUNT' | 'PAYMENTS' | 'GAME';
  body: string;
  requestId: string;
};
export function createSupportService(db: PrismaClient) {
  async function actor(tx: Tx, id: string, admin = false) {
    const [user] = await tx.$queryRaw<
      { role: string; status: string }[]
    >`SELECT role,status FROM users WHERE id=${id} FOR SHARE`;
    if (!user || user.status !== 'ACTIVE')
      throw ApiError.forbidden('An active account is required');
    const staff = ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
    if (admin && !staff) throw ApiError.forbidden('Administrator access required');
    return staff;
  }
  async function ticket(tx: Tx, id: string, userId: string, admin: boolean, lock = false) {
    await actor(tx, userId, admin);
    const rows = lock
      ? await tx.$queryRaw<Ticket[]>`SELECT * FROM support_tickets WHERE id=${id} FOR UPDATE`
      : await tx.$queryRaw<Ticket[]>`SELECT * FROM support_tickets WHERE id=${id}`;
    if (!rows[0] || (!admin && rows[0].user_id !== userId))
      throw ApiError.notFound('Request not found');
    return rows[0];
  }
  return {
    list: (userId: string, admin = false, page = 0, status = 'ALL') =>
      db.$transaction(async (tx) => {
        await actor(tx, userId, admin);
        const rows = await tx.$queryRaw<
          (Ticket & { username: string })[]
        >`SELECT t.*,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE (${admin} OR t.user_id=${userId}) AND (${status}='ALL' OR t.status=${status}) ORDER BY t.updated_at DESC,t.id DESC LIMIT 26 OFFSET ${page * 25}`;
        return { tickets: rows.slice(0, 25), hasMore: rows.length > 25, page };
      }),
    create: (userId: string, input: NewTicket) =>
      db.$transaction(async (tx) => {
        if (
          input.subject.trim().length < 3 ||
          input.subject.trim().length > 120 ||
          !input.body.trim() ||
          input.body.length > 4000
        )
          throw ApiError.badRequest('Enter a subject of at least 3 characters and a message.');
        // Serialize retries and the per-user open-request limit, without locking wallets.
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        await actor(tx, userId);
        const [old] = await tx.$queryRaw<
          Ticket[]
        >`SELECT * FROM support_tickets WHERE user_id=${userId} AND request_id=${input.requestId}`;
        if (old) {
          const [first] = await tx.$queryRaw<
            Message[]
          >`SELECT * FROM support_messages WHERE ticket_id=${old.id} ORDER BY created_at,id LIMIT 1`;
          if (
            old.subject !== input.subject.trim() ||
            old.category !== input.category ||
            first?.body !== input.body.trim()
          )
            throw ApiError.conflict(
              'This request has already been submitted with different content'
            );
          return { id: old.id };
        }
        const [{ count }] = await tx.$queryRaw<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM support_tickets WHERE user_id=${userId} AND status='OPEN'`;
        if (count >= 10)
          throw ApiError.conflict(
            'You have 10 open requests. Please reply to an existing request.'
          );
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO support_tickets(id,user_id,request_id,subject,category) VALUES(${id},${userId},${input.requestId},${input.subject.trim()},${input.category})`;
        await tx.$executeRaw`INSERT INTO support_messages(id,ticket_id,sender_id,staff,body,request_id) VALUES(${randomUUID()},${id},${userId},false,${input.body.trim()},${input.requestId})`;
        return { id };
      }),
    read: (userId: string, id: string, admin = false, page = 0) =>
      db.$transaction(async (tx) => {
        const item = await ticket(tx, id, userId, admin);
        const rows = await tx.$queryRaw<
          Message[]
        >`SELECT * FROM support_messages WHERE ticket_id=${id} ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ${page * 50}`;
        return {
          ticket: item,
          messages: rows.slice(0, 50).reverse(),
          hasMore: rows.length > 50,
          page,
        };
      }),
    reply: (
      userId: string,
      id: string,
      input: { body: string; requestId: string },
      admin = false
    ) =>
      db.$transaction(async (tx) => {
        if (!input.body.trim() || input.body.length > 4000)
          throw ApiError.badRequest('Enter a message of up to 4,000 characters.');
        const item = await ticket(tx, id, userId, admin, true);
        const [old] = await tx.$queryRaw<
          Message[]
        >`SELECT * FROM support_messages WHERE ticket_id=${id} AND sender_id=${userId} AND request_id=${input.requestId}`;
        if (old) {
          if (old.body !== input.body.trim())
            throw ApiError.conflict('Message already sent with different content');
          return { id: old.id };
        }
        if (item.status !== 'OPEN') throw ApiError.conflict('Reopen this request before replying');
        const messageId = randomUUID();
        await tx.$executeRaw`INSERT INTO support_messages(id,ticket_id,sender_id,staff,body,request_id) VALUES(${messageId},${id},${userId},${admin},${input.body.trim()},${input.requestId})`;
        await tx.$executeRaw`UPDATE support_tickets SET last_sender=${admin ? 'ADMIN' : 'USER'},updated_at=now() WHERE id=${id}`;
        return { id: messageId };
      }),
    setStatus: (userId: string, id: string, status: 'OPEN' | 'RESOLVED', admin = false) =>
      db.$transaction(async (tx) => {
        await ticket(tx, id, userId, admin, true);
        await tx.$executeRaw`UPDATE support_tickets SET status=${status},last_sender=CASE WHEN ${status}='OPEN' THEN ${admin ? 'ADMIN' : 'USER'} ELSE last_sender END,updated_at=now() WHERE id=${id}`;
        return { status };
      }),
  };
}
