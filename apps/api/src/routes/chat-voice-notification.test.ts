import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  create: vi.fn(),
  member: vi.fn(),
  users: vi.fn(),
  members: vi.fn(),
}));
vi.mock('@socialplay/database', () => ({
  prisma: { user: { findMany: m.users }, groupMember: { findMany: m.members } },
}));
vi.mock('@socialplay/storage', () => ({ storage: {} }));
vi.mock('../middleware/index.js', async () => {
  const { ApiError } = await import('../middleware/api-error.js');
  return {
    ApiError,
    authenticate: async (req: { user?: unknown }) => {
      req.user = { sub: 'sender' };
    },
  };
});
vi.mock('../realtime/chat-service.js', () => ({
  createVoiceMessage: m.create,
  assertActiveMember: m.member,
  getGroupOrThrow: vi.fn(),
  createMessage: vi.fn(),
  getMessageInGroup: vi.fn(),
  MESSAGE_SENDER_SELECT: {},
  serializeMessage: vi.fn(),
}));
vi.mock('../rewards/activity-service.js', () => ({ safeRecordActivity: vi.fn() }));
vi.mock('../gift-collection/service.js', () => ({ giftCardsForMessages: vi.fn() }));
vi.mock('../realtime/reaction-service.js', () => ({ setMessageReaction: vi.fn() }));
import { chatRoutes } from './chat.js';
import { setSocketServer } from '../realtime/broadcast.js';
import { ApiError } from '../middleware/api-error.js';

const groupId = '11111111-1111-4111-8111-111111111111';
const message = { id: 'voice-message', type: 'voice', groupId };
const payload = Buffer.from(
  '--voice\r\nContent-Disposition: form-data; name="duration"\r\n\r\n2\r\n--voice\r\nContent-Disposition: form-data; name="file"; filename="recording.ogg"\r\nContent-Type: audio/ogg\r\n\r\nfixture-audio\r\n--voice--\r\n'
);
let app: ReturnType<typeof Fastify>;
let receivers: { id: string; data: object; emit: ReturnType<typeof vi.fn> }[];
beforeEach(async () => {
  vi.resetAllMocks();
  receivers = ['sender', 'recipient'].map((id) => ({
    id,
    data: { user: { id }, expiresAt: Date.now() + 60000 },
    emit: vi.fn(),
  }));
  setSocketServer({
    in: (room: string) => ({
      fetchSockets: async () => {
        expect(room).toBe(`group:${groupId}`);
        return receivers;
      },
    }),
  } as unknown as Parameters<typeof setSocketServer>[0]);
  m.users.mockResolvedValue(receivers.map(({ id }) => ({ id })));
  m.members.mockResolvedValue(receivers.map(({ id }) => ({ userId: id })));
  m.create.mockResolvedValue(message);
  app = Fastify();
  await app.register(multipart);
  await app.register(chatRoutes, { prefix: '/groups' });
});
afterEach(() => app.close());
const upload = () =>
  app.inject({
    method: 'POST',
    url: `/groups/${groupId}/voice-messages`,
    headers: { 'content-type': 'multipart/form-data; boundary=voice' },
    payload,
  });

it('notifies both connected members only after the voice message commits', async () => {
  let commit!: (result: typeof message) => void;
  m.create.mockImplementation(
    () =>
      new Promise((resolve) => {
        commit = resolve;
      })
  );
  const pending = Promise.resolve(upload());
  await vi.waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
  for (const receiver of receivers) expect(receiver.emit).not.toHaveBeenCalled();
  commit(message);
  expect((await pending).statusCode).toBe(201);
  await vi.waitFor(() => {
    for (const receiver of receivers) {
      expect(receiver.emit).toHaveBeenCalledTimes(1);
      expect(receiver.emit).toHaveBeenCalledWith('message:created', message);
    }
  });
});
it('does not announce a failed storage or database commit', async () => {
  m.create.mockRejectedValue(new Error('Storage unavailable'));
  expect((await upload()).statusCode).toBe(500);
  for (const receiver of receivers) expect(receiver.emit).not.toHaveBeenCalled();
});
it('keeps membership checks ahead of persistence and notification', async () => {
  m.member.mockRejectedValue(ApiError.forbidden());
  expect((await upload()).statusCode).toBe(403);
  expect(m.create).not.toHaveBeenCalled();
  for (const receiver of receivers) expect(receiver.emit).not.toHaveBeenCalled();
});
