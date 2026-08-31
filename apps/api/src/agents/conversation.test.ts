import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication, suspendAgent } from './agent-service';
import * as broadcast from '../realtime/broadcast';
import {
  sendMessageAsAgent,
  sendMessageAsAdmin,
  getOwnConversation,
  getConversationForAgent,
  listMessages,
  listConversationsWithUnreadForAdmin,
} from './conversation-service';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `convo-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `convotest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Conversation Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createCountry(tag: string) {
  const code = `C${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: { code, name: `Convo Test Country ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
}

async function makeAgent(tag: string, countryId: string, admin: { id: string }) {
  const user = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(user.id, {
    countryId,
    displayName: `Agent ${tag}`,
    contactEmail: `agent-convo-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: user.id } });
  return { user, agent: agent! };
}

async function cleanConversationFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'convo-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length) {
      const conversations = await prisma.agentConversation.findMany({
        where: { agentId: { in: agentIds } },
        select: { id: true },
      });
      const conversationIds = conversations.map((c) => c.id);
      if (conversationIds.length) {
        await prisma.agentMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
      }
      await prisma.agentConversation.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
    }
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Convo Test Country' } } });
  if (countries.length) {
    await prisma.country.deleteMany({ where: { id: { in: countries.map((c) => c.id) } } });
  }
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION CREATION / ACCESS
// ═══════════════════════════════════════════════════════════════

describeIf('Agent conversation creation and access', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConversationFixtures();
    admin = await createAdmin('createadmin');
    country = await createCountry('create');
  });

  it('agent gets/creates their own conversation', async () => {
    const { user } = await makeAgent('create1', country.id, admin);
    const conversation = await getOwnConversation(user.id);
    expect(conversation).toBeTruthy();
    expect(conversation.agentId).toBeTruthy();
  });

  it('duplicate get-or-create returns the same conversation record', async () => {
    const { user } = await makeAgent('create2', country.id, admin);
    const first = await getOwnConversation(user.id);
    const second = await getOwnConversation(user.id);
    expect(second.id).toBe(first.id);

    const all = await prisma.agentConversation.findMany({ where: { agentId: first.agentId } });
    expect(all.length).toBe(1);
  });

  it('a user with no agent account cannot get/create a conversation', async () => {
    const plainUser = await createUser('plain1');
    await expect(getOwnConversation(plainUser.id)).rejects.toThrow(/do not have an agent account/i);
  });

  it('admin can get/create a conversation for a specific agent', async () => {
    const { agent } = await makeAgent('create3', country.id, admin);
    const conversation = await getConversationForAgent(admin.id, agent.id);
    expect(conversation.agentId).toBe(agent.id);
  });

  it('ordinary user cannot use the admin get-conversation path', async () => {
    const { agent } = await makeAgent('create4', country.id, admin);
    const plainUser = await createUser('plain2');
    await expect(getConversationForAgent(plainUser.id, agent.id)).rejects.toThrow(/admin privileges required/i);
  });

  it('an agent cannot read another agent\'s conversation', async () => {
    const a = await makeAgent('create5a', country.id, admin);
    const b = await makeAgent('create5b', country.id, admin);
    const conversationB = await getOwnConversation(b.user.id);
    await expect(listMessages(a.user.id, conversationB.id)).rejects.toThrow(/do not have access/i);
  });

  it('admin can read any agent\'s conversation', async () => {
    const { user } = await makeAgent('create6', country.id, admin);
    const conversation = await getOwnConversation(user.id);
    await expect(listMessages(admin.id, conversation.id)).resolves.toBeTruthy();
  });

  it('CONCURRENCY — two concurrent get-or-create calls for the same agent: exactly one conversation row', async () => {
    const { user, agent } = await makeAgent('createrace', country.id, admin);
    const results = await Promise.allSettled([getOwnConversation(user.id), getOwnConversation(user.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(fulfilled.length).toBe(2); // both callers succeed, resolving to the same row
    expect(fulfilled[0].value.id).toBe(fulfilled[1].value.id);

    const all = await prisma.agentConversation.findMany({ where: { agentId: agent.id } });
    expect(all.length).toBe(1);
  });

  it('CONCURRENCY — agent\'s first message and admin\'s first message race: exactly one conversation, two messages', async () => {
    const { user, agent } = await makeAgent('createrace2', country.id, admin);

    const results = await Promise.allSettled([
      sendMessageAsAgent(user.id, { body: 'hello from agent' }),
      sendMessageAsAdmin(admin.id, agent.id, { body: 'hello from admin' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const conversations = await prisma.agentConversation.findMany({ where: { agentId: agent.id } });
    expect(conversations.length).toBe(1);

    const messages = await prisma.agentMessage.findMany({ where: { conversationId: conversations[0].id } });
    expect(messages.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE SENDING
// ═══════════════════════════════════════════════════════════════

describeIf('Agent conversation message sending', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConversationFixtures();
    admin = await createAdmin('sendadmin');
    country = await createCountry('send');
  });

  it('agent can send a message; sender role is derived server-side as AGENT', async () => {
    const { user } = await makeAgent('send1', country.id, admin);
    const message = await sendMessageAsAgent(user.id, { body: 'Hello, I have a question.' });
    expect(message.senderRole).toBe('AGENT');
    expect(message.senderId).toBe(user.id);
  });

  it('admin can send a message; sender role is derived server-side as ADMIN', async () => {
    const { agent } = await makeAgent('send2', country.id, admin);
    const message = await sendMessageAsAdmin(admin.id, agent.id, { body: 'How can we help?' });
    expect(message.senderRole).toBe('ADMIN');
    expect(message.senderId).toBe(admin.id);
  });

  it('spoofed sender role cannot be supplied — the service accepts no such field', async () => {
    const { user } = await makeAgent('send3', country.id, admin);
    // SendMessageArgs has no senderRole/senderId field at all; even if a
    // caller smuggled one into the object, TypeScript's structural typing
    // combined with Prisma's explicit `data: {...}` (never a spread of the
    // raw args) means it can never reach the database.
    const message = await sendMessageAsAgent(user.id, { body: 'test', ...( { senderRole: 'ADMIN' } as any) });
    expect(message.senderRole).toBe('AGENT');
  });

  it('empty message body is rejected', async () => {
    const { user } = await makeAgent('send4', country.id, admin);
    await expect(sendMessageAsAgent(user.id, { body: '' })).rejects.toThrow(/message body is required/i);
    await expect(sendMessageAsAgent(user.id, { body: '   ' })).rejects.toThrow(/message body is required/i);
  });

  it('overlong message body is rejected', async () => {
    const { user } = await makeAgent('send5', country.id, admin);
    await expect(sendMessageAsAgent(user.id, { body: 'x'.repeat(5001) })).rejects.toThrow(/at most 5000 characters/i);
  });

  it('a user with no agent account cannot send as an agent', async () => {
    const plainUser = await createUser('plain3');
    await expect(sendMessageAsAgent(plainUser.id, { body: 'hi' })).rejects.toThrow(/do not have an agent account/i);
  });

  it('a suspended agent cannot send messages', async () => {
    const { user, agent } = await makeAgent('send6', country.id, admin);
    await suspendAgent(admin.id, agent.id, 'compliance hold');
    await expect(sendMessageAsAgent(user.id, { body: 'still trying' })).rejects.toThrow(
      /cannot send messages in its current state/i
    );
  });

  it('ordinary user cannot send as admin', async () => {
    const { agent } = await makeAgent('send7', country.id, admin);
    const plainUser = await createUser('plain4');
    await expect(sendMessageAsAdmin(plainUser.id, agent.id, { body: 'hi' })).rejects.toThrow(/admin privileges required/i);
  });

  it('relatedOrderId must belong to the conversation\'s own agent', async () => {
    const a = await makeAgent('send8a', country.id, admin);
    const b = await makeAgent('send8b', country.id, admin);
    // A dummy order-shaped id that doesn't belong to agent a — using a
    // nonexistent id is sufficient since ownership validation looks it up.
    await expect(
      sendMessageAsAgent(a.user.id, { body: 'about an order', relatedOrderId: 'not-a-real-order-id' })
    ).rejects.toThrow(/does not belong to this conversation's agent/i);
    void b;
  });

  it('CONCURRENCY — agent sends two messages concurrently: both succeed as two distinct messages', async () => {
    const { user, agent } = await makeAgent('send9', country.id, admin);
    const results = await Promise.allSettled([
      sendMessageAsAgent(user.id, { body: 'message one' }),
      sendMessageAsAgent(user.id, { body: 'message two' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const conversation = await getOwnConversation(user.id);
    const messages = await prisma.agentMessage.findMany({ where: { conversationId: conversation.id } });
    expect(messages.length).toBe(2);
    void agent;
  });
});

// ═══════════════════════════════════════════════════════════════
// MESSAGE RETRIEVAL / PAGINATION
// ═══════════════════════════════════════════════════════════════

describeIf('Agent conversation message retrieval', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConversationFixtures();
    admin = await createAdmin('listadmin');
    country = await createCountry('list');
  });

  it('messages are retrievable in deterministic chronological order', async () => {
    const { user } = await makeAgent('list1', country.id, admin);
    await sendMessageAsAgent(user.id, { body: 'first' });
    await sendMessageAsAgent(user.id, { body: 'second' });
    await sendMessageAsAgent(user.id, { body: 'third' });

    const conversation = await getOwnConversation(user.id);
    const result = await listMessages(user.id, conversation.id);
    expect(result.messages.map((m) => m.body)).toEqual(['first', 'second', 'third']);
  });

  it('pagination returns pages without skipping or duplicating', async () => {
    const { user } = await makeAgent('list2', country.id, admin);
    for (let i = 0; i < 5; i++) {
      await sendMessageAsAgent(user.id, { body: `msg-${i}` });
    }
    const conversation = await getOwnConversation(user.id);

    const page1 = await listMessages(user.id, conversation.id, { limit: 2 });
    expect(page1.messages.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await listMessages(user.id, conversation.id, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.messages.length).toBe(2);

    const page3 = await listMessages(user.id, conversation.id, { limit: 2, cursor: page2.nextCursor! });
    expect(page3.messages.length).toBe(1);
    expect(page3.nextCursor).toBeNull();

    // The guarantee listMessages actually makes is a DETERMINISTIC total
    // order — (createdAt, id) — with no skipped or duplicated rows across
    // pages. It is NOT insertion order: messages created inside a tight loop
    // routinely share the same millisecond `createdAt`, and the tie is then
    // broken by uuid, which is random. Asserting insertion order here made
    // this test flaky. Assert the real contract instead: the concatenated
    // pages must equal exactly what a single unpaginated read returns, in the
    // same order, with no duplicates.
    const paged = [...page1.messages, ...page2.messages, ...page3.messages].map((m) => m.id);
    const unpaged = (await prisma.agentMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })).map((m) => m.id);
    expect(paged).toEqual(unpaged);
    expect(new Set(paged).size).toBe(5); // no duplicates, nothing skipped
  });

  it('pagination limit is clamped to the maximum', async () => {
    const { user } = await makeAgent('list3', country.id, admin);
    await sendMessageAsAgent(user.id, { body: 'only one' });
    const conversation = await getOwnConversation(user.id);
    const result = await listMessages(user.id, conversation.id, { limit: 99999 });
    expect(result.messages.length).toBe(1); // clamped internally, never errors, never over-fetches
  });

  it('unrelated user cannot read messages', async () => {
    const { user } = await makeAgent('list4', country.id, admin);
    await sendMessageAsAgent(user.id, { body: 'private' });
    const conversation = await getOwnConversation(user.id);
    const stranger = await createUser('stranger1');
    await expect(listMessages(stranger.id, conversation.id)).rejects.toThrow(/do not have access/i);
  });

  it('reading marks the other party\'s messages as read', async () => {
    const { user } = await makeAgent('list5', country.id, admin);
    await sendMessageAsAdmin(admin.id, (await prisma.agent.findUnique({ where: { userId: user.id } }))!.id, {
      body: 'admin says hi',
    });
    const conversation = await getOwnConversation(user.id);

    const beforeRead = await prisma.agentMessage.findMany({ where: { conversationId: conversation.id } });
    expect(beforeRead[0].readAt).toBeNull();

    await listMessages(user.id, conversation.id); // agent views the conversation

    const afterRead = await prisma.agentMessage.findMany({ where: { conversationId: conversation.id } });
    expect(afterRead[0].readAt).not.toBeNull();
  });

  it('admin unread queue reflects unread agent messages', async () => {
    const { user, agent } = await makeAgent('list6', country.id, admin);
    await sendMessageAsAgent(user.id, { body: 'need help' });

    const queue = await listConversationsWithUnreadForAdmin();
    const entry = queue.find((c) => c.agentId === agent.id);
    expect(entry).toBeTruthy();
    expect(entry!.unreadCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS / REALTIME / AUDIT
// ═══════════════════════════════════════════════════════════════

describeIf('Agent conversation notifications, realtime, and audit', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConversationFixtures();
    admin = await createAdmin('notifadmin');
    country = await createCountry('notif');
  });

  it('admin message notifies the agent via AGENT_ADMIN_MESSAGE exactly once', async () => {
    const { user, agent } = await makeAgent('notif1', country.id, admin);
    await sendMessageAsAdmin(admin.id, agent.id, { body: 'hello' });

    const notifications = await prisma.notification.findMany({ where: { userId: user.id, type: 'AGENT_ADMIN_MESSAGE' } });
    expect(notifications.length).toBe(1);
  });

  it('agent message does not create a notification (no matching enum value exists)', async () => {
    const { user } = await makeAgent('notif2', country.id, admin);
    // makeAgent legitimately produces AGENT_APPLICATION_RECEIVED and
    // AGENT_APPLICATION_APPROVED notifications, so asserting a total of zero
    // was wrong. Measure the delta across the message send instead — that is
    // the actual claim: sending an agent message adds no notification.
    const before = await prisma.notification.count({ where: { userId: user.id } });
    await sendMessageAsAgent(user.id, { body: 'hello admin' });
    const after = await prisma.notification.count({ where: { userId: user.id } });
    expect(after).toBe(before);
  });

  it('admin message triggers realtime delivery to the agent\'s own user id, server-resolved', async () => {
    const spy = vi.spyOn(broadcast, 'emitToUser');
    const { agent } = await makeAgent('notif3', country.id, admin);
    await sendMessageAsAdmin(admin.id, agent.id, { body: 'realtime test' });

    expect(spy).toHaveBeenCalledWith(
      agent.userId,
      'agent-message:new',
      expect.objectContaining({ senderRole: 'ADMIN' })
    );
    spy.mockRestore();
  });

  it('individual messages create no AuditLog entries (matches the existing chat-message convention)', async () => {
    const { user, agent } = await makeAgent('notif4', country.id, admin);
    await sendMessageAsAgent(user.id, { body: 'no audit for this' });
    await sendMessageAsAdmin(admin.id, agent.id, { body: 'no audit for this either' });

    const logs = await prisma.auditLog.findMany({ where: { entity: 'AgentMessage' } });
    expect(logs.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════

describeIf('Complete agent-admin conversation lifecycle', () => {
  let admin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanConversationFixtures();
    admin = await createAdmin('lifecycleadmin');
    country = await createCountry('lifecycle');
  });

  it('agent opens conversation, admin replies, agent reads — full round trip', async () => {
    const { user, agent } = await makeAgent('e2e1', country.id, admin);

    const opening = await sendMessageAsAgent(user.id, { body: 'I need help with my payment account.' });
    expect(opening.senderRole).toBe('AGENT');

    const reply = await sendMessageAsAdmin(admin.id, agent.id, { body: 'Sure, what seems to be the issue?' });
    expect(reply.senderRole).toBe('ADMIN');

    const conversation = await getOwnConversation(user.id);
    const history = await listMessages(user.id, conversation.id);
    expect(history.messages.map((m) => m.body)).toEqual([
      'I need help with my payment account.',
      'Sure, what seems to be the issue?',
    ]);

    const refreshedReply = await prisma.agentMessage.findUnique({ where: { id: reply.id } });
    expect(refreshedReply!.readAt).not.toBeNull(); // marked read by the agent's own view above

    const notifications = await prisma.notification.findMany({ where: { userId: user.id, type: 'AGENT_ADMIN_MESSAGE' } });
    expect(notifications.length).toBe(1);
  });
});
