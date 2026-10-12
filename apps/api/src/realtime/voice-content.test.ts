import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { it, expect, vi, beforeEach, afterAll } from 'vitest';
const m = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  voice: vi.fn(async ({ data }: any) => data),
  message: vi.fn(async ({ data }: any) => ({
    ...data,
    id: 'voice-probe',
    createdAt: new Date(),
    user: { id: 'member', username: 'member' },
    reactions: [],
  })),
}));
vi.mock('@socialplay/database', () => ({
  prisma: {
    $transaction: async (fn: any) =>
      fn({ message: { create: m.message }, voiceMessage: { create: m.voice } }),
  },
}));
vi.mock('../groups/lifecycle.js', () => ({ lockSocialGroup: vi.fn() }));
vi.mock('@socialplay/storage', () => ({
  storage: { upload: m.upload, delete: m.remove },
  generateStorageKey: () => 'probe.ogg',
}));
import { createVoiceMessage } from './chat-service.js';

const dir = mkdtempSync(join(tmpdir(), 'voice-regressions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  m.upload.mockResolvedValue(undefined);
});
function audio(seconds: number, format = 'ogg') {
  const path = join(dir, `voice-${seconds}.${format}`);
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono',
      '-t',
      String(seconds),
      '-c:a',
      ['ogg', 'webm'].includes(format)
        ? 'libopus'
        : format === 'mp3'
          ? 'libmp3lame'
          : format === 'wav'
            ? 'pcm_s16le'
            : 'aac',
      '-y',
      path,
    ],
    { timeout: 15000 }
  );
  return readFileSync(path);
}
const send = (file: Buffer, mimeType = 'audio/ogg', duration = 1) =>
  createVoiceMessage({
    userId: 'member',
    groupId: 'group',
    file,
    fileName: 'voice.ogg',
    mimeType,
    duration,
  });
function timestampedAudio(expression: string) {
  audio(2, 'webm');
  const path = join(dir, 'timestamped.webm');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      join(dir, 'voice-2.webm'),
      '-af',
      `asetpts=${expression}`,
      '-c:a',
      'libopus',
      '-avoid_negative_ts',
      'disabled',
      '-y',
      path,
    ],
    { timeout: 15000 }
  );
  return readFileSync(path);
}

function temporaryInputs() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('playqube-voice-'))
    .sort();
}

async function rejectsBeforeStorage(file: Buffer, mime = 'audio/webm') {
  const before = temporaryInputs();
  await expect(send(file, mime, 1)).rejects.toThrow('Invalid recording');
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.message).not.toHaveBeenCalled();
  expect(m.voice).not.toHaveBeenCalled();
  expect(temporaryInputs()).toEqual(before);
}
it('rejects non-audio before storage or message writes', async () => {
  await expect(send(Buffer.from('this is not audio'))).rejects.toThrow();
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.voice).not.toHaveBeenCalled();
});
it('rejects real 301-second audio under 5 MiB despite a one-second claim', async () => {
  const file = audio(301);
  expect(file.length).toBeLessThan(5 * 1024 * 1024);
  await expect(send(file)).rejects.toThrow();
  expect(m.upload).not.toHaveBeenCalled();
});
it.each([0.25, 299, 300])(
  'accepts valid %s-second audio and stores server-derived duration',
  async (seconds) => {
    await send(audio(seconds), 'audio/ogg', 999999);
    expect(m.upload).toHaveBeenCalledOnce();
    expect(m.voice.mock.calls[0][0].data.duration).toBeCloseTo(seconds, 1);
  }
);
it('rejects a supported MIME that mismatches content', async () => {
  await expect(send(audio(1), 'audio/mp4')).rejects.toThrow();
  expect(m.upload).not.toHaveBeenCalled();
});
it('rejects empty, truncated and oversized input before upload', async () => {
  for (const file of [Buffer.alloc(0), audio(1).subarray(0, 45), Buffer.alloc(5 * 1024 * 1024 + 1)])
    await expect(send(file)).rejects.toThrow();
  expect(m.upload).not.toHaveBeenCalled();
});
it('cleans up a successful upload when the message transaction fails', async () => {
  m.message.mockRejectedValueOnce(new Error('database failed'));
  await expect(send(audio(1))).rejects.toThrow('database failed');
  expect(m.remove).toHaveBeenCalledOnce();
});

it('fails closed before upload when the decoder cannot start and removes temporary input', async () => {
  const file = audio(1),
    oldPath = process.env.PATH;
  const before = readdirSync(tmpdir())
    .filter((name) => name.startsWith('playqube-voice-'))
    .sort();
  try {
    process.env.PATH = '/no-audio-programs-here';
    await expect(send(file)).rejects.toThrow('Invalid recording');
  } finally {
    process.env.PATH = oldPath;
  }
  expect(
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('playqube-voice-'))
      .sort()
  ).toEqual(before);
  expect(m.upload).not.toHaveBeenCalled();
  expect(m.voice).not.toHaveBeenCalled();
});

it.each([
  ['webm', 'audio/webm'],
  ['mp4', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
])('validates supported %s content and derives duration', async (format, mime) => {
  await send(audio(1, format), mime, 0);
  expect(m.upload).toHaveBeenCalledOnce();
  expect(m.voice.mock.calls[0][0].data.duration).toBeCloseTo(1, 1);
});
it.each([
  ['webm', 'audio/webm'],
  ['mp4', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
])('preserves the 300-second boundary for supported %s recordings', async (format, mime) => {
  await send(audio(300, format), mime, 1);
  expect(m.upload).toHaveBeenCalledOnce();
  expect(m.voice.mock.calls[0][0].data.duration).toBe(300);
});
it.each([300.001, 300.01])(
  'rejects %s-second AAC playback even when its excess is smaller than a codec frame',
  async (seconds) => {
    await rejectsBeforeStorage(audio(seconds, 'mp4'), 'audio/mp4');
  }
);
it('rejects a well-formed but unsupported WAV recording', async () => {
  await expect(send(audio(1, 'wav'), 'audio/wav')).rejects.toThrow();
  expect(m.upload).not.toHaveBeenCalled();
});

it('independent review: rejects a 602-second timestamp-gap recording', async () => {
  const file = timestampedAudio('PTS+600/TB*gte(T\\,1)');
  expect(file.length).toBeLessThan(5 * 1024 * 1024);
  await rejectsBeforeStorage(file);
});

it('rejects a long initial timestamp before storage rather than normalizing it away', async () => {
  await rejectsBeforeStorage(timestampedAudio('PTS+600/TB'));
});

it('rejects a shorter discontinuous playback timeline before storage', async () => {
  await rejectsBeforeStorage(timestampedAudio('PTS+0.5/TB*gte(T\\,1)'));
});

it('rejects an incomplete late audio packet despite a valid decoded prefix', async () => {
  const file = audio(2, 'webm');
  await rejectsBeforeStorage(file.subarray(0, file.length - 5));
});

it('rejects an abnormal negative initial timestamp before storage', async () => {
  await rejectsBeforeStorage(timestampedAudio('PTS-0.5/TB'));
});
