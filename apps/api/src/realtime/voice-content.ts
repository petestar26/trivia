import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../middleware/api-error.js';
import { validateOggOriginal } from './ogg-original.js';

const MAX_BYTES = 5 * 1024 * 1024;
const SAMPLE_RATE = 8000;
const MAX_SAMPLES = 300 * SAMPLE_RATE;
// WebM's millisecond timestamps can round a decoded frame boundary by one
// millisecond. This is not a duration allowance: the complete span still must
// fit within 300 seconds.
const TIMESTAMP_ROUNDING = SAMPLE_RATE / 1000;
let active = 0;

// Decode only local, bounded uploads. No playlists, URLs, external protocols or
// arbitrary demuxers. Output and elapsed work are bounded independently of tags.
function run(command: string, args: string[], maxBytes: number, deadline: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const milliseconds = Math.min(15_000, deadline - Date.now());
    if (milliseconds <= 0) return reject(new Error('Audio validation timed out'));
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0,
      failed = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, milliseconds);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop();
      else chunks.push(chunk);
    });
    // A demuxer may report premature EOF as a warning while exiting zero.
    // Any diagnostic prevents approval of the original upload. Do not retain
    // paths or attacker metadata, and independently bound diagnostic output.
    let diagnosticBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 64 * 1024) stop();
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Audio decoder unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0 || diagnosticBytes !== 0)
        reject(new Error('Invalid or unsupported audio'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

type AacTimeline = { duration: number; finalPadding: number };

// AAC-LC codecs decode whole 1024-sample frames. Older FFmpeg versions retain
// the unplayed padding of the last MP4 packet, whereas newer versions trim it.
// Scan every demuxed packet to verify the actual presentation end before
// permitting this specific final-frame padding in the complete decode.
function aacTimeline(report: Buffer, sampleRate: number, profile: string): AacTimeline {
  let end: number | undefined,
    lastDuration = 0,
    standardFrames = true;
  for (const line of report.toString('utf8').split('\n')) {
    if (!line) continue;
    const fields = line.split(',');
    // ffprobe CSV appends an empty side-data field to priming/padding packets.
    if (fields.length === 4 && fields[3] === '') fields.pop();
    if (fields.length !== 3) throw Error('Invalid AAC packet');
    const [pts, dts, count] = fields.map(Number);
    if (![pts, dts, count].every(Number.isSafeInteger) || pts !== dts || count <= 0)
      throw Error('Invalid AAC packet dimensions');
    if (end === undefined) {
      if (pts > 0 || pts < -1024) throw Error('Invalid AAC priming');
    } else {
      if (pts !== end) throw Error('Discontinuous AAC packet timeline');
      if (lastDuration !== 1024) standardFrames = false;
    }
    end = pts + count;
    if (!Number.isSafeInteger(end) || end > 300 * sampleRate)
      throw Error('AAC playback duration outside limits');
    lastDuration = count;
  }
  if (end === undefined || end <= 0) throw Error('AAC packets required');
  const padding =
    profile === 'LC' && standardFrames && lastDuration <= 1024 ? 1024 - lastDuration : 0;
  return {
    duration: end / sampleRate,
    finalPadding: Math.ceil((padding * SAMPLE_RATE) / sampleRate),
  };
}

// framecrc is produced from decoded mono PCM, rather than container duration
// tags or a bounded prefix. Each output frame carries its original playback
// timestamp and actual decoded sample count. An accepted report is returned
// only after the decoder has read the complete local input and exited cleanly.
function decodedDuration(report: Buffer, codec: string, aac?: AacTimeline): number {
  const lines = report.toString('utf8').split('\n');
  if (!lines.includes(`#tb 0: 1/${SAMPLE_RATE}`)) throw Error('Invalid audio timebase');
  let first: number | undefined,
    end: number | undefined,
    samples = 0;
  // MP3 decoding trims encoder priming, commonly leaving a 23–25 ms initial
  // timestamp. Other supported browser formats begin within WebM's 1 ms
  // rounding. Never normalize an arbitrary late start out of the timeline.
  const initialPriming = codec === 'mp3' ? SAMPLE_RATE / 20 : TIMESTAMP_ROUNDING;
  const maximumSamples = aac
    ? Math.ceil(aac.duration * SAMPLE_RATE) + aac.finalPadding
    : MAX_SAMPLES;
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length !== 6 || fields[0] !== '0') throw Error('Invalid decoded audio frame');
    const dts = Number(fields[1]),
      pts = Number(fields[2]),
      count = Number(fields[3]),
      bytes = Number(fields[4]);
    if (
      ![dts, pts, count, bytes].every(Number.isSafeInteger) ||
      dts !== pts ||
      count <= 0 ||
      bytes !== count * 2
    )
      throw Error('Invalid decoded audio dimensions');
    if (first === undefined) {
      if (pts < -TIMESTAMP_ROUNDING || pts > initialPriming)
        throw Error('Invalid audio start timestamp');
      first = pts;
    }
    if (end !== undefined && Math.abs(pts - end) > TIMESTAMP_ROUNDING)
      throw Error('Discontinuous audio timeline');
    end = pts + count;
    samples += count;
    if (
      !Number.isSafeInteger(end) ||
      samples > maximumSamples ||
      end - first > maximumSamples ||
      end > maximumSamples + initialPriming
    )
      throw Error('Audio duration outside limits');
  }
  if (first === undefined || end === undefined || samples <= 0 || end <= first)
    throw Error('Audio samples required');
  if (aac) {
    const minimumSamples = Math.floor(aac.duration * SAMPLE_RATE) - 1;
    if (samples < minimumSamples || end - first < minimumSamples)
      throw Error('Incomplete AAC decode');
    return aac.duration;
  }
  return Math.max(samples, end - first) / SAMPLE_RATE;
}

export async function inspectVoiceContent(
  file: Buffer,
  claimedMime: string
): Promise<{ mimeType: string; duration: number; extension: string }> {
  if (!file.length || file.length > MAX_BYTES)
    throw ApiError.badRequest('Voice recording must be between 1 byte and 5 MiB');
  if (active >= 2) throw ApiError.rateLimited('Audio validation is busy; try again');
  active++;
  // The optional AAC packet scan shares the original two-process 30-second
  // total budget; it does not add another unbounded validation stage.
  const deadline = Date.now() + 30_000;
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
            'format=format_name:stream=codec_name,codec_type,channels,sample_rate,time_base,profile',
            '-of',
            'json',
            input,
          ],
          64 * 1024,
          deadline
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
    if (format === 'ogg') validateOggOriginal(file);
    let aac: AacTimeline | undefined;
    if (codec === 'aac') {
      const sampleRate = Number(stream.sample_rate);
      if (stream.time_base !== `1/${sampleRate}`) throw Error('Unsupported AAC timebase');
      aac = aacTimeline(
        await run(
          'ffprobe',
          [
            '-v',
            'error',
            ...restrictions,
            '-show_entries',
            'packet=pts,dts,duration',
            '-of',
            'csv=p=0',
            input,
          ],
          (MAX_SAMPLES + SAMPLE_RATE) * 2,
          deadline
        ),
        sampleRate,
        stream.profile
      );
    }
    const decoded = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-nostdin',
        '-xerror',
        ...restrictions,
        '-threads',
        '1',
        '-err_detect',
        'explode',
        '-copyts',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-threads',
        '1',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        '-f',
        'framecrc',
        'pipe:1',
      ],
      (MAX_SAMPLES + SAMPLE_RATE) * 2,
      deadline
    );
    return {
      mimeType: kind[0],
      extension: kind[1],
      duration: decodedDuration(decoded, codec, aac),
    };
  } catch {
    throw ApiError.badRequest('Invalid recording: use supported audio of at most 300 seconds');
  } finally {
    active--;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
