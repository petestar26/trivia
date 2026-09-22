import { prisma } from '@socialplay/database';
import { storage, generateStorageKey } from '@socialplay/storage';
import { STORAGE_BUCKETS } from '@socialplay/shared';
import { createUser, uniqueSuffix } from './group-admission-fixtures.js';

/**
 * Fixtures for the chat message-deletion authority suite. Every group this file
 * creates is owned by an EMAIL_PREFIX-tagged user, so `cleanFixtures(prefix)`
 * (group-admission-fixtures.ts) sweeps it — and everything in it, messages and
 * voice attachments included, since `Message.group` cascades — without any
 * changes to that shared helper.
 */

export type ChatUser = Awaited<ReturnType<typeof createUser>>;

export interface ChatFixture {
  owner: ChatUser;
  /** ADMIN: the manager who can delete another member's message. */
  admin: ChatUser;
  /** A second ADMIN, for schedules that need a peer manager. */
  admin2: ChatUser;
  /** ACTIVE MEMBER: writes the message(s) under test. */
  author: ChatUser;
  /** ACTIVE MEMBER, not otherwise involved: the "plain member" refusal case. */
  bystander: ChatUser;
  groupId: string;
  groupName: string;
  ownerRowId: string;
  adminRowId: string;
  admin2RowId: string;
  authorRowId: string;
  bystanderRowId: string;
  /** A live TEXT message authored by `author`. */
  messageId: string;
}

export async function makeChatFixture(emailPrefix: string, groupNamePrefix: string, tag: string): Promise<ChatFixture> {
  const owner = await createUser(emailPrefix, `${tag}-own`);
  const admin = await createUser(emailPrefix, `${tag}-adm`);
  const admin2 = await createUser(emailPrefix, `${tag}-ad2`);
  const author = await createUser(emailPrefix, `${tag}-aut`);
  const bystander = await createUser(emailPrefix, `${tag}-bys`);
  const groupName = `${groupNamePrefix}${tag}-${uniqueSuffix().slice(0, 6)}`;
  const group = await prisma.group.create({ data: { ownerId: owner.id, name: groupName, isPrivate: true, status: 'ACTIVE' } });
  const [ownerRow, adminRow, admin2Row, authorRow, bystanderRow] = await Promise.all([
    prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } }),
    prisma.groupMember.create({ data: { groupId: group.id, userId: admin.id, role: 'ADMIN', status: 'ACTIVE' } }),
    prisma.groupMember.create({ data: { groupId: group.id, userId: admin2.id, role: 'ADMIN', status: 'ACTIVE' } }),
    prisma.groupMember.create({ data: { groupId: group.id, userId: author.id, role: 'MEMBER', status: 'ACTIVE' } }),
    prisma.groupMember.create({ data: { groupId: group.id, userId: bystander.id, role: 'MEMBER', status: 'ACTIVE' } }),
  ]);
  const message = await prisma.message.create({
    data: { groupId: group.id, userId: author.id, content: `${tag} hello`, type: 'TEXT' },
  });
  return {
    owner,
    admin,
    admin2,
    author,
    bystander,
    groupId: group.id,
    groupName,
    ownerRowId: ownerRow.id,
    adminRowId: adminRow.id,
    admin2RowId: admin2Row.id,
    authorRowId: authorRow.id,
    bystanderRowId: bystanderRow.id,
    messageId: message.id,
  };
}

/** Add a second TEXT message, authored by whoever is given, to an existing fixture's group. */
export async function addMessage(f: ChatFixture, author: ChatUser, content = 'another message'): Promise<string> {
  const message = await prisma.message.create({ data: { groupId: f.groupId, userId: author.id, content, type: 'TEXT' } });
  return message.id;
}

export interface VoiceFixture {
  messageId: string;
  storageKey: string;
}

/**
 * A REAL voice message: a small file actually written through the local storage
 * provider (matching what POST /voice-messages does), plus the Message and
 * VoiceMessage rows. Storage-failure tests spy on `storage.delete` rather than
 * corrupting this fixture, so cleanup always finds a real file to remove.
 */
export async function addVoiceMessage(f: ChatFixture, author: ChatUser, tag: string): Promise<VoiceFixture> {
  const storageKey = generateStorageKey(STORAGE_BUCKETS.VOICE_MESSAGES, `${tag}.ogg`, author.id);
  await storage.upload({
    bucket: STORAGE_BUCKETS.VOICE_MESSAGES,
    key: storageKey,
    file: Buffer.from(`fixture audio ${tag}`),
    mimeType: 'audio/ogg',
    originalName: `${tag}.ogg`,
  });
  const message = await prisma.message.create({
    data: { groupId: f.groupId, userId: author.id, content: '', type: 'VOICE' },
  });
  await prisma.voiceMessage.create({
    data: { messageId: message.id, storageKey, mimeType: 'audio/ogg', duration: 3, size: 20 },
  });
  return { messageId: message.id, storageKey };
}

export interface MessageSnapshot {
  id: string;
  groupId: string;
  userId: string;
  isDeleted: boolean;
  updatedAt: Date;
  xmin: string;
}

/** A message row exactly as stored, plus xmin — which changes on ANY write to the row. */
export async function messageSnapshot(messageId: string): Promise<MessageSnapshot | null> {
  const rows = await prisma.$queryRaw<MessageSnapshot[]>`
    SELECT id, "groupId", "userId", "isDeleted", "updatedAt", xmin::text AS xmin
    FROM messages
    WHERE id = ${messageId}
  `;
  return rows[0] ?? null;
}

/**
 * A scoped fail-closed BEFORE UPDATE trigger on `messages`: it raises only when a
 * write sets isDeleted=true on a message belonging to a group whose NAME starts
 * with `groupNamePrefix`, so it can force the ROUTE's own soft-delete UPDATE to
 * fail without touching any other suite's messages (or this suite's own
 * DELETE/cascade cleanup, which never sets isDeleted). Keyed on the GROUP, not
 * the message's own content: a VOICE message's content is always empty, so a
 * content-based marker could never select one.
 */
export async function installFailingMessageUpdateTrigger(name: string, groupNamePrefix: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON messages`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$
    BEGIN
      IF NEW."isDeleted" = true
         AND EXISTS (SELECT 1 FROM groups g WHERE g.id = NEW."groupId" AND g.name LIKE '${groupNamePrefix}%')
      THEN
        RAISE EXCEPTION 'forced message-update failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION ${name}()`);
}

export async function removeFailingMessageUpdateTrigger(name: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON messages`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
}
