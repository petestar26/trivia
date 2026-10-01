import { describe, expect, it } from 'vitest';
import {
  inspectTimestampInfo,
  inspectTimestampRequest,
  inspectTimestampToken,
} from './rfc3161-codec.js';

// Independently framed DER fixtures, rather than using the decoder's encoder.
function der(tag: number, content: Buffer): Buffer {
  if (content.length < 128) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  const hex = content.length.toString(16).padStart(content.length <= 255 ? 2 : 4, '0');
  const length = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([tag, 128 + length.length]), length, content]);
}
const seq = (...fields: Buffer[]) => der(0x30, Buffer.concat(fields));
const int = (n: number) => der(2, Buffer.from([n]));
const oid = der(6, Buffer.from([42, 3, 4]));
const sha256 = Buffer.from('300d06096086480165030402010500', 'hex');
const imprint = seq(sha256, der(4, Buffer.alloc(32, 1)));
function info(
  time = '20261001010203.123456789Z',
  accuracy = seq(int(1)),
  nonce = int(1),
  serial = int(1)
): Buffer {
  return seq(int(1), oid, imprint, serial, der(24, Buffer.from(time, 'ascii')), accuracy, nonce);
}
describe('bounded RFC 3161 metadata decoding', () => {
  it('preserves fractional nanoseconds and rounds time and accuracy outwards', () => {
    const parsed = inspectTimestampInfo(
      info(undefined, seq(int(1), der(0x80, Buffer.from([2])), der(0x81, Buffer.from([1]))))
    );
    expect(parsed.lowerMs).toBe(Date.UTC(2026, 9, 1, 1, 2, 3, 123));
    expect(parsed.upperMs).toBe(parsed.lowerMs + 1);
    expect(parsed.accuracyMs).toBe(1_003);
    expect(parsed.nonce).toBe('1');
    expect(parsed.serial).toBe('1');
  });
  it('does not expand exact millisecond values or whole seconds', () => {
    for (const time of ['20261001010203Z', '20261001010203.123Z']) {
      const parsed = inspectTimestampInfo(info(time));
      expect(parsed.upperMs).toBe(parsed.lowerMs);
    }
  });
  it.each([
    '20260230010203Z',
    '20261001010260Z',
    '20261001010203.120Z',
    '20261001010203.1234567891Z',
    '20261001010203+0000',
    '202610010102Z',
    '20261001010203.0Z',
  ])('rejects unsupported or noncanonical time %s', (time) => {
    expect(() => inspectTimestampInfo(info(time))).toThrow();
  });
  it('rejects high-bit bytes that ascii decoding would otherwise silently mask', () => {
    const bytes = info();
    bytes[bytes.indexOf(Buffer.from('202610'))] |= 128;
    expect(() => inspectTimestampInfo(bytes)).toThrow('Non-ASCII');
  });
  it.each([
    seq(),
    seq(int(0)),
    seq(der(0x80, Buffer.from([0]))),
    seq(der(0x81, Buffer.from([0]))),
    seq(int(61)),
  ])('rejects absent, zero or oversized declared accuracy', (accuracy) => {
    expect(() => inspectTimestampInfo(info(undefined, accuracy))).toThrow();
  });
  it('rejects missing accuracy, trailing content and nonminimal integers', () => {
    expect(() => inspectTimestampInfo(info(undefined, Buffer.alloc(0)))).toThrow();
    expect(() => inspectTimestampInfo(Buffer.concat([info(), int(2)]))).toThrow();
    expect(() =>
      inspectTimestampInfo(info(undefined, undefined, der(2, Buffer.from([0, 1]))))
    ).toThrow();
  });
  it.each([int(0), int(128), der(2, Buffer.concat([Buffer.from([1]), Buffer.alloc(20)]))])(
    'rejects zero, negative or oversized nonce/serial',
    (integer) => {
      expect(() => inspectTimestampInfo(info(undefined, undefined, integer))).toThrow();
      expect(() => inspectTimestampInfo(info(undefined, undefined, undefined, integer))).toThrow();
    }
  );
  it('requires SHA-256, certReq, a policy and a positive nonce in a query', () => {
    const valid = seq(int(1), imprint, oid, int(1), der(1, Buffer.from([255])));
    expect(inspectTimestampRequest(valid).hash).toBe('01'.repeat(32));
    for (const malformed of [
      seq(int(1), imprint, oid, int(1)),
      seq(int(1), imprint, int(1), der(1, Buffer.from([255]))),
      seq(int(1), imprint, oid, int(0), der(1, Buffer.from([255]))),
      Buffer.concat([valid, int(2)]),
    ])
      expect(() => inspectTimestampRequest(malformed)).toThrow();
    const sha1 = Buffer.from('300906052b0e03021a0500', 'hex');
    expect(() =>
      inspectTimestampRequest(
        seq(int(1), seq(sha1, der(4, Buffer.alloc(32))), oid, int(1), der(1, Buffer.from([255])))
      )
    ).toThrow('SHA-256');
  });
  it('rejects indefinite-length, truncated and non-CMS inputs', () => {
    for (const bytes of [Buffer.from('3080', 'hex'), info().subarray(0, 40), Buffer.alloc(0)]) {
      expect(() => inspectTimestampInfo(bytes)).toThrow();
      expect(() => inspectTimestampToken(bytes)).toThrow();
    }
  });
});
