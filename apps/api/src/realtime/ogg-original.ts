const MAX_BYTES = 5 * 1024 * 1024;
const HEADER_BYTES = 27;
const CRC_POLYNOMIAL = 0x04c11db7;

// Ogg uses the non-reflected CRC-32 defined in RFC 3533, with an initial
// remainder of zero and the page's checksum field treated as zero.
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let remainder = byte << 24;
  for (let bit = 0; bit < 8; bit++)
    remainder = (remainder << 1) ^ (remainder & 0x80000000 ? CRC_POLYNOMIAL : 0);
  return remainder >>> 0;
});

/**
 * Validate every byte of a complete, single logical Ogg recording. Decoders
 * can silently discard an incomplete last page, so successful decoding alone
 * does not establish that the original being stored is intact. This scan is
 * linear in the bounded upload size and retains no packet bodies or page list.
 * Chained/multiplexed streams are outside the single-audio-stream upload
 * policy; never let a decoder approve only one of their constituent streams.
 */
export function validateOggOriginal(file: Buffer): void {
  if (!file.length || file.length > MAX_BYTES) throw Error('Invalid Ogg size');
  let offset = 0,
    serial: number | undefined,
    nextSequence = 0,
    unfinishedPacket = false,
    ended = false;

  while (offset < file.length) {
    if (ended || file.length - offset < HEADER_BYTES) throw Error('Incomplete Ogg page header');
    if (
      file.readUInt32BE(offset) !== 0x4f676753 ||
      file[offset + 4] !== 0 ||
      (file[offset + 5] & ~7) !== 0
    )
      throw Error('Invalid Ogg page header');

    const flags = file[offset + 5],
      pageSerial = file.readUInt32LE(offset + 14),
      sequence = file.readUInt32LE(offset + 18),
      segments = file[offset + 26],
      bodyStart = offset + HEADER_BYTES + segments;
    if (bodyStart > file.length) throw Error('Incomplete Ogg segment table');
    if (serial === undefined) {
      if ((flags & 2) === 0 || (flags & 1) !== 0) throw Error('Ogg beginning required');
      serial = pageSerial;
    } else if (pageSerial !== serial || (flags & 2) !== 0) {
      throw Error('Multiple Ogg streams are unsupported');
    }
    if (sequence !== nextSequence) throw Error('Discontinuous Ogg page sequence');
    nextSequence = (nextSequence + 1) >>> 0;

    // Empty pages can mark EOS. They contain no continued packet; an unfinished
    // packet remains pending until a subsequent non-empty continuation page.
    const continued = (flags & 1) !== 0;
    if (segments ? continued !== unfinishedPacket : continued)
      throw Error('Invalid Ogg packet continuation');
    let bodyBytes = 0;
    for (let segment = 0; segment < segments; segment++)
      bodyBytes += file[offset + HEADER_BYTES + segment];
    const pageEnd = bodyStart + bodyBytes;
    if (pageEnd > file.length) throw Error('Incomplete Ogg page body');

    let checksum = 0;
    for (let byte = offset; byte < pageEnd; byte++) {
      const value = byte >= offset + 22 && byte < offset + 26 ? 0 : file[byte];
      checksum = ((checksum << 8) ^ crcTable[((checksum >>> 24) ^ value) & 255]) >>> 0;
    }
    if (checksum !== file.readUInt32LE(offset + 22)) throw Error('Invalid Ogg page checksum');

    if (segments) unfinishedPacket = file[bodyStart - 1] === 255;
    ended = (flags & 4) !== 0;
    if (ended && unfinishedPacket) throw Error('Incomplete terminal Ogg packet');
    offset = pageEnd;
  }
  if (!ended || unfinishedPacket) throw Error('Complete Ogg ending required');
}
