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
import { validateOggOriginal } from './ogg-original.js';

const dir = mkdtempSync(join(tmpdir(), 'voice-regressions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  m.upload.mockResolvedValue(undefined);
});
function audio(seconds: number, format = 'ogg', oggCodec = 'libopus', metadata = '') {
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
      `anullsrc=r=48000:cl=${oggCodec === 'vorbis' ? 'stereo' : 'mono'}`,
      '-t',
      String(seconds),
      '-c:a',
      ['ogg', 'webm'].includes(format)
        ? oggCodec
        : format === 'mp3'
          ? 'libmp3lame'
          : format === 'wav'
            ? 'pcm_s16le'
            : 'aac',
      ...(oggCodec === 'vorbis' ? ['-strict', 'experimental'] : []),
      ...(metadata ? ['-metadata', `comment=${metadata}`] : []),
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

function oggPages(file: Buffer) {
  const pages: Array<{ offset: number; end: number }> = [];
  for (let offset = 0; offset < file.length;) {
    const segments = file[offset + 26];
    let end = offset + 27 + segments;
    for (let i = 0; i < segments; i++) end += file[offset + 27 + i];
    pages.push({ offset, end });
    offset = end;
  }
  return pages;
}

// Independent bit-at-a-time CRC implementation for fixture mutations. Rebuild
// integrity after semantic mutations so rejection cannot rely on checksum alone.
function setOggChecksum(file: Buffer, offset = 0, end = file.length) {
  file.writeUInt32LE(0, offset + 22);
  let checksum = 0;
  for (let byte = offset; byte < end; byte++) {
    checksum ^= file[byte] << 24;
    for (let bit = 0; bit < 8; bit++)
      checksum = (checksum << 1) ^ (checksum & 0x80000000 ? 0x04c11db7 : 0);
  }
  file.writeUInt32LE(checksum >>> 0, offset + 22);
  return file;
}

function syntheticOggPage(sequence: number, flags: number, segments: number[], serial = 1) {
  const file = Buffer.alloc(27 + segments.length + segments.reduce((sum, n) => sum + n, 0));
  file.write('OggS');
  file[5] = flags;
  file.writeUInt32LE(serial, 14);
  file.writeUInt32LE(sequence, 18);
  file[26] = segments.length;
  file.set(segments, 27);
  return setOggChecksum(file);
}

function mutateOggPage(
  original: Buffer,
  page: number,
  mutate: (file: Buffer, offset: number) => void
) {
  const copy = Buffer.from(original),
    { offset, end } = oggPages(copy)[page];
  mutate(copy, offset);
  return setOggChecksum(copy, offset, end);
}

it('independent re-review: truncated Ogg final packet is rejected before storage', async () => {
  const original = audio(4, 'ogg');
  const last = oggPages(original).at(-1)!.offset;
  expect(last).toBeGreaterThan(100);
  expect(original[last + 5] & 4).toBe(4);
  await rejectsBeforeStorage(original.subarray(0, original.length - 5), 'audio/ogg');
});

it.each(['libopus', 'vorbis'])('preserves valid Ogg %s originals', async (codec) => {
  const file = audio(1, 'ogg', codec);
  await send(file);
  expect(m.upload).toHaveBeenCalledOnce();
  expect(m.upload.mock.calls[0][0].file).toBe(file);
  expect(m.voice.mock.calls[0][0].data.duration).toBeCloseTo(1, 1);
});

it('preserves the 300-second boundary for a valid Vorbis original', async () => {
  await send(audio(300, 'ogg', 'vorbis'));
  expect(m.upload).toHaveBeenCalledOnce();
  expect(m.voice.mock.calls[0][0].data.duration).toBeCloseTo(300, 2);
});

it('rejects an over-300-second Vorbis original before any writes', async () => {
  const file = audio(301, 'ogg', 'vorbis');
  expect(file.length).toBeLessThan(5 * 1024 * 1024);
  await rejectsBeforeStorage(file, 'audio/ogg');
});

it('preserves a valid Vorbis header packet continued across pages', async () => {
  const file = audio(1, 'ogg', 'vorbis', 'x'.repeat(70000));
  expect(oggPages(file).some(({ offset }) => (file[offset + 5] & 1) !== 0)).toBe(true);
  await send(file);
  expect(m.upload).toHaveBeenCalledOnce();
});

it.each(['fixed header', 'segment table', 'page body'])(
  'rejects an Ogg truncated in its terminal %s before any writes',
  async (part) => {
    const file = audio(4),
      last = oggPages(file).at(-1)!.offset;
    const length =
      part === 'fixed header' ? last + 20 : part === 'segment table' ? last + 27 : file.length - 1;
    await rejectsBeforeStorage(file.subarray(0, length), 'audio/ogg');
  }
);

it.each([
  'missing EOS',
  'early EOS',
  'wrong sequence',
  'wrong serial',
  'unexpected continuation',
  'second BOS',
  'version',
  'reserved flag',
  'capture pattern',
])('rejects Ogg %s even with a recomputed valid checksum', async (mutation) => {
  const file = audio(4),
    page = mutation === 'missing EOS' ? oggPages(file).length - 1 : 1;
  const mutated = mutateOggPage(file, page, (copy, offset) => {
    if (mutation === 'missing EOS') copy[offset + 5] &= ~4;
    else if (mutation === 'early EOS') copy[offset + 5] |= 4;
    else if (mutation === 'wrong sequence') copy.writeUInt32LE(9, offset + 18);
    else if (mutation === 'wrong serial')
      copy.writeUInt32LE((copy.readUInt32LE(offset + 14) ^ 1) >>> 0, offset + 14);
    else if (mutation === 'unexpected continuation') copy[offset + 5] |= 1;
    else if (mutation === 'second BOS') copy[offset + 5] |= 2;
    else if (mutation === 'version') copy[offset + 4] = 1;
    else if (mutation === 'capture pattern') copy[offset] ^= 1;
    else copy[offset + 5] |= 8;
  });
  await rejectsBeforeStorage(mutated, 'audio/ogg');
});

it('rejects a real Vorbis packet with a missing continuation flag before any writes', async () => {
  const file = audio(1, 'ogg', 'vorbis', 'x'.repeat(70000));
  const continuedPage = oggPages(file).findIndex(({ offset }) => (file[offset + 5] & 1) !== 0);
  expect(continuedPage).toBeGreaterThan(0);
  await rejectsBeforeStorage(
    mutateOggPage(file, continuedPage, (copy, offset) => {
      copy[offset + 5] &= ~1;
    }),
    'audio/ogg'
  );
});

it.each(['checksum', 'body'])(
  'rejects Ogg malformed %s integrity before any writes',
  async (part) => {
    const file = Buffer.from(audio(4)),
      last = oggPages(file).at(-1)!.offset;
    file[part === 'checksum' ? last + 22 : file.length - 1] ^= 1;
    await rejectsBeforeStorage(file, 'audio/ogg');
  }
);

it('rejects an Ogg original with trailing bytes or a concatenated second stream', async () => {
  const file = audio(1);
  for (const tail of [Buffer.from('OggS'), audio(1)])
    await rejectsBeforeStorage(Buffer.concat([file, tail]), 'audio/ogg');
});

it('validates continuation termination, including zero-length final segments and empty EOS', () => {
  const first = syntheticOggPage(0, 2, [255]),
    continued = syntheticOggPage(1, 1, [0]),
    ending = syntheticOggPage(2, 4, []);
  expect(() => validateOggOriginal(Buffer.concat([first, continued, ending]))).not.toThrow();
  expect(() =>
    validateOggOriginal(
      Buffer.concat([first, syntheticOggPage(1, 0, []), syntheticOggPage(2, 5, [0])])
    )
  ).not.toThrow();
  expect(() => validateOggOriginal(Buffer.concat([first, syntheticOggPage(1, 4, [0])]))).toThrow(
    'continuation'
  );
  expect(() => validateOggOriginal(Buffer.concat([first, syntheticOggPage(1, 5, [255])]))).toThrow(
    'terminal'
  );
  expect(() => validateOggOriginal(syntheticOggPage(0, 3, [0]))).toThrow('beginning');
  expect(() => validateOggOriginal(syntheticOggPage(1, 6, [0]))).toThrow('sequence');
});

it('bounds Ogg scanning independently of decoder process limits', () => {
  expect(() => validateOggOriginal(Buffer.alloc(0))).toThrow('size');
  expect(() => validateOggOriginal(Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow('size');
  expect(() => validateOggOriginal(Buffer.from('OggS'))).toThrow('header');
  const page = syntheticOggPage(0, 6, [1]);
  page[27] = 255;
  expect(() => validateOggOriginal(page)).toThrow('body');
});
