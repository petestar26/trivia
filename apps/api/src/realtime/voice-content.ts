import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../middleware/api-error.js';

const MAX_BYTES = 5 * 1024 * 1024;
const SAMPLE_RATE = 8000;
const MAX_SAMPLES = 300 * SAMPLE_RATE;
let active = 0;

// Decode only local, bounded uploads. No playlists, URLs, external protocols or
// arbitrary demuxers. Output and elapsed work are bounded independently of tags.
function run(command: string, args: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0,
      failed = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
      else chunks.push(chunk);
    });
    // Do not retain decoder diagnostics containing paths or attacker metadata.
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Audio decoder unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('Invalid or unsupported audio'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function inspectVoiceContent(
  file: Buffer,
  claimedMime: string
): Promise<{ mimeType: string; duration: number; extension: string }> {
  if (!file.length || file.length > MAX_BYTES)
    throw ApiError.badRequest('Voice recording must be between 1 byte and 5 MiB');
  if (active >= 2) throw ApiError.rateLimited('Audio validation is busy; try again');
  active++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'playqube-voice-'));
    const input = join(directory, 'recording');
    await writeFile(input, file, { mode: 0o600 });
    const restrictions = [
      '-max_alloc',
      '33554432',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'ogg,matroska,webm,mov,mp3',
    ];
    const info = JSON.parse(
      (
        await run(
          'ffprobe',
          [
            '-v',
            'error',
            ...restrictions,
            '-show_entries',
            'format=format_name:stream=codec_name,codec_type,channels,sample_rate',
            '-of',
            'json',
            input,
          ],
          64 * 1024
        )
      ).toString()
    );
    if (
      !Array.isArray(info.streams) ||
      info.streams.length !== 1 ||
      info.streams[0].codec_type !== 'audio'
    )
      throw Error('Audio stream required');
    const stream = info.streams[0];
    if (
      !Number.isInteger(stream.channels) ||
      stream.channels < 1 ||
      stream.channels > 2 ||
      !Number.isFinite(Number(stream.sample_rate)) ||
      Number(stream.sample_rate) < 8000 ||
      Number(stream.sample_rate) > 192000
    )
      throw Error('Unsupported audio dimensions');
    const format: string = info.format?.format_name ?? '',
      codec: string = info.streams[0].codec_name;
    const kind =
      format === 'ogg' && ['opus', 'vorbis'].includes(codec)
        ? ['audio/ogg', 'ogg']
        : format.includes('webm') && ['opus', 'vorbis'].includes(codec)
          ? ['audio/webm', 'webm']
          : format.includes('mp4') && codec === 'aac'
            ? ['audio/mp4', 'mp4']
            : format === 'mp3' && codec === 'mp3'
              ? ['audio/mpeg', 'mp3']
              : null;
    if (!kind || claimedMime.split(';')[0].trim().toLowerCase() !== kind[0])
      throw Error('Audio format mismatch');
    const pcm = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-xerror',
        ...restrictions,
        '-threads',
        '1',
        '-err_detect',
        'explode',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-t',
        '301',
        '-threads',
        '1',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        's16le',
        'pipe:1',
      ],
      (MAX_SAMPLES + SAMPLE_RATE) * 2
    );
    const samples = pcm.length / 2;
    if (!Number.isInteger(samples) || samples <= 0 || samples > MAX_SAMPLES)
      throw Error('Audio duration outside limits');
    return { mimeType: kind[0], extension: kind[1], duration: samples / SAMPLE_RATE };
  } catch {
    throw ApiError.badRequest('Invalid recording: use supported audio of at most 300 seconds');
  } finally {
    active--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
