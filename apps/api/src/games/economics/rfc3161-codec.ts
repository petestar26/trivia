import { createRequire } from 'node:module';

type Builder = {
  seq(): Builder;
  obj(...fields: Builder[]): Builder;
  key(name: string): Builder;
  int(): Builder;
  objid(): Builder;
  octstr(): Builder;
  bool(): Builder;
  any(): Builder;
  utf8str(): Builder;
  bitstr(): Builder;
  seqof(schema: Schema): Builder;
  optional(): Builder;
  explicit(tag: number): Builder;
  implicit(tag: number): Builder;
  def(value: unknown): Builder;
  use(schema: Schema): Builder;
  setof(schema: Schema): Builder;
};
type Schema = {
  decode(bytes: Buffer, format: 'der'): unknown;
  encode(value: unknown, format: 'der'): Buffer;
};
const asn1 = createRequire(import.meta.url)('asn1.js') as {
  define(name: string, body: (this: Builder) => void): Schema;
};
const SHA256 = '2.16.840.1.101.3.4.2.1';
const raw = asn1.define('PublicationRaw', function () {
  this.any();
});
const statusText = asn1.define('PublicationStatusText', function () {
  this.utf8str();
});
const response = asn1.define('PublicationTimestampResponse', function () {
  this.seq().obj(
    this.key('status')
      .seq()
      .obj(
        this.key('code').int(),
        this.key('text').optional().seqof(statusText),
        this.key('failure').optional().bitstr()
      ),
    this.key('token').use(raw)
  );
});
type Integer = { toString(radix: number): string };
type Algorithm = { oid: number[]; parameters?: Buffer };
const algorithm = asn1.define('PublicationAlgorithm', function () {
  this.seq().obj(this.key('oid').objid(), this.key('parameters').optional().any());
});
const imprint = asn1.define('PublicationImprint', function () {
  this.seq().obj(this.key('algorithm').use(algorithm), this.key('hash').octstr());
});
const request = asn1.define('PublicationTimestampRequest', function () {
  this.seq().obj(
    this.key('version').int(),
    this.key('imprint').use(imprint),
    this.key('policy').optional().objid(),
    this.key('nonce').optional().int(),
    this.key('certReq').def(false).bool(),
    this.key('extensions').optional().implicit(0).use(raw)
  );
});
const timestampInfo = asn1.define('PublicationTimestampInfo', function () {
  this.seq().obj(
    this.key('version').int(),
    this.key('policy').objid(),
    this.key('imprint').use(imprint),
    this.key('serial').int(),
    // Keep the exact GeneralizedTime TLV: asn1.js gentime drops fractions.
    this.key('time').any(),
    this.key('accuracy')
      .optional()
      .seq()
      .obj(
        this.key('seconds').optional().int(),
        this.key('millis').optional().implicit(0).int(),
        this.key('micros').optional().implicit(1).int()
      ),
    this.key('ordering').def(false).bool(),
    this.key('nonce').optional().int(),
    this.key('tsa').optional().explicit(0).use(raw),
    this.key('extensions').optional().implicit(1).use(raw)
  );
});
const signer = asn1.define('PublicationSigner', function () {
  this.seq().obj(
    this.key('version').int(),
    this.key('identity').any(),
    this.key('digest').use(algorithm),
    this.key('attributes').optional().implicit(0).use(raw),
    this.key('signatureAlgorithm').use(algorithm),
    this.key('signature').octstr(),
    this.key('unsigned').optional().implicit(1).use(raw)
  );
});
const signedData = asn1.define('PublicationSignedData', function () {
  this.seq().obj(
    this.key('version').int(),
    this.key('digests').setof(algorithm),
    this.key('content').seq().obj(this.key('type').objid(), this.key('value').explicit(0).octstr()),
    this.key('certificates').optional().implicit(0).use(raw),
    this.key('crls').optional().implicit(1).use(raw),
    this.key('signers').setof(signer)
  );
});
const token = asn1.define('PublicationTimestampToken', function () {
  this.seq().obj(this.key('type').objid(), this.key('signed').explicit(0).use(signedData));
});
function integer(value: Integer, maximum = BigInt(Number.MAX_SAFE_INTEGER)): bigint {
  const n = BigInt(value.toString(10));
  if (n < 0n || n > maximum) throw new Error('Timestamp integer is out of range');
  return n;
}
function requireSha256(value: Algorithm) {
  if (
    value.oid.join('.') !== SHA256 ||
    (value.parameters && !value.parameters.equals(Buffer.from([5, 0])))
  )
    throw new Error('Timestamp requires SHA-256');
}
function requireCanonical(schema: Schema, value: unknown, bytes: Buffer) {
  if (!schema.encode(value, 'der').equals(bytes))
    throw new Error('Timestamp requires canonical DER');
}

// asn1.js ANY returns the decoded element AND the parent's remaining bytes
// (DecoderBuffer.raw(save)). Restrict every ANY to its actual definite-length
// TLV before re-encoding or inspecting it. Crypto still authenticates the exact
// original CMS content; this is never a signature normalization step.
function boundedAny(bytes: Buffer): Buffer {
  if (bytes.length < 2 || (bytes[0] & 31) === 31) throw new Error('Unsupported DER tag');
  let header = 2,
    length = bytes[1];
  if (length >= 128) {
    const count = length & 127;
    if (!count || count > 3 || bytes.length < 2 + count || bytes[2] === 0)
      throw new Error('Unsupported DER length');
    header += count;
    length = 0;
    for (let i = 2; i < header; i++) length = length * 256 + bytes[i];
    if (length < 128) throw new Error('Noncanonical DER length');
  }
  if (header + length > bytes.length) throw new Error('Truncated DER element');
  return bytes.subarray(0, header + length);
}

export function inspectTimestampRequest(bytes: Buffer) {
  const q = request.decode(bytes, 'der') as {
    version: Integer;
    imprint: { algorithm: Algorithm; hash: Buffer };
    policy?: number[];
    nonce?: Integer;
    certReq: boolean;
    extensions?: Buffer;
  };
  requireCanonical(request, q, bytes);
  requireSha256(q.imprint.algorithm);
  if (
    integer(q.version) !== 1n ||
    q.imprint.hash.length !== 32 ||
    !q.policy ||
    !q.certReq ||
    !q.nonce ||
    integer(q.nonce, (1n << 160n) - 1n) === 0n ||
    q.extensions
  )
    throw new Error('Unsupported timestamp request');
  return {
    hash: q.imprint.hash.toString('hex'),
    policy: q.policy.join('.'),
    nonce: q.nonce.toString(16),
  };
}

export function inspectTimestampResponse(bytes: Buffer): Buffer {
  const r = response.decode(bytes, 'der') as {
    status: { code: Integer; failure?: unknown };
    token: Buffer;
  };
  r.token = boundedAny(r.token);
  requireCanonical(response, r, bytes);
  // A deliberately narrow contract: no granted-with-modifications, rejection,
  // trailing objects or embedded failure data. The approved query is exact.
  if (integer(r.status.code) !== 0n || r.status.failure) throw new Error('Timestamp not granted');
  return r.token;
}

export function inspectTimestampToken(bytes: Buffer) {
  const t = token.decode(bytes, 'der') as {
    type: number[];
    signed: {
      digests: Algorithm[];
      content: { type: number[]; value: Buffer };
      certificates?: Buffer;
      crls?: Buffer;
      signers: Array<{
        identity: Buffer;
        attributes?: Buffer;
        unsigned?: Buffer;
        digest: Algorithm;
        signatureAlgorithm: Algorithm;
      }>;
    };
  };
  for (const key of ['certificates', 'crls'] as const) {
    if (t.signed[key]) t.signed[key] = boundedAny(t.signed[key]);
  }
  for (const s of t.signed.signers) {
    s.identity = boundedAny(s.identity);
    if (s.attributes) s.attributes = boundedAny(s.attributes);
    if (s.unsigned) s.unsigned = boundedAny(s.unsigned);
  }
  requireCanonical(token, t, bytes);
  if (
    t.type.join('.') !== '1.2.840.113549.1.7.2' ||
    t.signed.content.type.join('.') !== '1.2.840.113549.1.9.16.1.4' ||
    t.signed.digests.length !== 1 ||
    t.signed.signers.length !== 1
  )
    throw new Error('Unsupported timestamp CMS structure');
  requireSha256(t.signed.digests[0]);
  requireSha256(t.signed.signers[0].digest);
  if (
    !['1.2.840.10045.4.3.2', '1.2.840.113549.1.1.1', '1.2.840.113549.1.1.11'].includes(
      t.signed.signers[0].signatureAlgorithm.oid.join('.')
    )
  )
    throw new Error('Unsupported timestamp signature algorithm');
  return t.signed.content.value;
}

/** Outward rounding preserves sub-millisecond time and accuracy uncertainty. */
export function inspectTimestampInfo(bytes: Buffer) {
  const info = timestampInfo.decode(bytes, 'der') as {
    version: Integer;
    policy: number[];
    imprint: { algorithm: Algorithm; hash: Buffer };
    serial: Integer;
    time: Buffer;
    nonce?: Integer;
    extensions?: Buffer;
    tsa?: Buffer;
    accuracy?: { seconds?: Integer; millis?: Integer; micros?: Integer };
  };
  info.time = boundedAny(info.time);
  if (info.tsa) info.tsa = boundedAny(info.tsa);
  requireCanonical(timestampInfo, info, bytes);
  requireSha256(info.imprint.algorithm);
  if (
    integer(info.version) !== 1n ||
    info.imprint.hash.length !== 32 ||
    !info.nonce ||
    integer(info.nonce, (1n << 160n) - 1n) === 0n ||
    integer(info.serial, (1n << 160n) - 1n) === 0n ||
    !info.accuracy ||
    info.extensions
  )
    throw new Error('Unsupported timestamp information');
  const time = info.time;
  if (time[0] !== 0x18 || time[1] !== time.length - 2) throw new Error('Invalid GeneralizedTime');
  const text = time.subarray(2).toString('ascii');
  if (!Buffer.from(text, 'ascii').equals(time.subarray(2)))
    throw new Error('Non-ASCII GeneralizedTime');
  const match = /^(\d{14})(?:\.([0-9]{1,9}))?Z$/.exec(text);
  if (!match || match[2]?.endsWith('0')) throw new Error('Noncanonical GeneralizedTime');
  const parts = match[1];
  const base = Date.UTC(
    Number(parts.slice(0, 4)),
    Number(parts.slice(4, 6)) - 1,
    Number(parts.slice(6, 8)),
    Number(parts.slice(8, 10)),
    Number(parts.slice(10, 12)),
    Number(parts.slice(12, 14))
  );
  const expected = new Date(base).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  if (expected !== parts) throw new Error('Invalid GeneralizedTime calendar');
  const nanos = BigInt((match[2] ?? '').padEnd(9, '0'));
  const lowerMs = base + Number(nanos / 1_000_000n);
  const upperMs = lowerMs + (nanos % 1_000_000n ? 1 : 0);
  const seconds = info.accuracy.seconds ? integer(info.accuracy.seconds, 60n) : 0n;
  const millis = info.accuracy.millis ? integer(info.accuracy.millis, 999n) : 0n;
  const micros = info.accuracy.micros ? integer(info.accuracy.micros, 999n) : 0n;
  if ((info.accuracy.millis && millis === 0n) || (info.accuracy.micros && micros === 0n))
    throw new Error('Invalid timestamp accuracy');
  const accuracyMs = Number(seconds * 1_000n + millis + (micros ? 1n : 0n));
  if (accuracyMs === 0) throw new Error('Timestamp must declare nonzero accuracy');
  return {
    hash: info.imprint.hash.toString('hex'),
    policy: info.policy.join('.'),
    nonce: info.nonce.toString(16),
    serial: info.serial.toString(16),
    lowerMs,
    upperMs,
    accuracyMs,
  };
}
