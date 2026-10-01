import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSpinPublicProof, spinPublicCommitmentFrame } from '@socialplay/shared';
import type { SpinPublicProof } from '@socialplay/shared';
import { PUBLICATION_AUTHORITIES } from './publication-authorities.js';
import type { PublicationAuthority } from './publication-authorities.js';
import {
  inspectTimestampInfo,
  inspectTimestampRequest,
  inspectTimestampResponse,
  inspectTimestampToken,
} from './rfc3161-codec.js';

const run = promisify(execFile);
const verified = new WeakSet<object>();
export const MAX_TIMESTAMP_RESPONSE_BYTES = 65_536;
export const MAX_TIMESTAMP_REQUEST_BYTES = 4_096;
export class PublicationWitnessUnavailable extends Error {
  constructor() {
    super('Independent publication witness is unavailable');
  }
}
export interface PublicationRequest {
  readonly authorityId: string;
  readonly commitmentHash: string;
  readonly queryDer: Buffer;
}
export interface VerifiedPublicationWitness {
  readonly authorityId: string;
  readonly commitmentHash: string;
  readonly responseSha256: string;
  readonly serial: string;
  readonly observedFromMs: number;
  readonly observedThroughMs: number;
}
function commitment(raw: unknown): SpinPublicProof {
  const proof = parseSpinPublicProof(raw);
  if (
    createHash('sha256').update(spinPublicCommitmentFrame(proof.commitment)).digest('hex') !==
    proof.commitmentHash
  )
    throw new Error('Receipt mismatch');
  return proof;
}
function authority(id: string, roots: readonly PublicationAuthority[]) {
  const matches = roots.filter((root) => root.id === id);
  if (matches.length !== 1) throw new PublicationWitnessUnavailable();
  const root = matches[0];
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(root.id) ||
    !/^[0-9a-f]{64}$/.test(root.signerCertificateSha256) ||
    !/^\d+(?:\.\d+)+$/.test(root.policyOid) ||
    !Number.isSafeInteger(root.maxAccuracyMs) ||
    root.maxAccuracyMs < 1 ||
    root.maxAccuracyMs > 5_000
  )
    throw new PublicationWitnessUnavailable();
  const signer = new X509Certificate(root.signerCertificatePem);
  if (createHash('sha256').update(signer.raw).digest('hex') !== root.signerCertificateSha256)
    throw new PublicationWitnessUnavailable();
  const ca = new X509Certificate(root.rootCertificatePem);
  if (!ca.ca || signer.ca) throw new PublicationWitnessUnavailable();
  // X509Certificate parses the first certificate. Pass only that canonical PEM
  // to OpenSSL so extra certificates in a configured bundle cannot add trust or
  // provide an alternative signer that escaped the exact fingerprint pin.
  return Object.freeze({
    ...root,
    rootCertificatePem: ca.toString(),
    signerCertificatePem: signer.toString(),
  });
}
async function openssl(args: string[]) {
  return run('openssl', args, {
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 262_144,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      OPENSSL_CONF: '/dev/null',
    },
    windowsHide: true,
  });
}
async function temporary<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'playqube-witness-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** Only produces public DER request bytes; no network, signing key or database. */
export async function createPublicationRequest(
  raw: unknown,
  authorityId: string,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
): Promise<PublicationRequest> {
  try {
    const proof = commitment(raw);
    if (proof.stage !== 'PENDING') throw new Error('Preparation requires a pending commitment');
    const trusted = authority(authorityId, roots);
    return await temporary(async (directory) => {
      const query = path.join(directory, 'request.der');
      await openssl([
        'ts',
        '-query',
        '-sha256',
        '-digest',
        proof.commitmentHash,
        '-cert',
        '-tspolicy',
        trusted.policyOid,
        '-out',
        query,
      ]);
      const queryDer = await readFile(query);
      if (queryDer.length > MAX_TIMESTAMP_REQUEST_BYTES) throw new Error('Request too large');
      const parsed = inspectTimestampRequest(queryDer);
      if (parsed.hash !== proof.commitmentHash || parsed.policy !== trusted.policyOid)
        throw new Error('Request mismatch');
      return Object.freeze({ authorityId, commitmentHash: proof.commitmentHash, queryDer });
    });
  } catch {
    throw new PublicationWitnessUnavailable();
  }
}

/** Offline verification with an explicitly pinned signer and CA. Embedded
 * certificates and ambient machine CA stores never select the trusted signer.
 * Production defaults contain no approved authority. Test roots are explicit.
 */
export async function verifyPublicationWitness(
  raw: unknown,
  request: PublicationRequest,
  response: Uint8Array,
  roots: readonly PublicationAuthority[] = PUBLICATION_AUTHORITIES
): Promise<Readonly<VerifiedPublicationWitness>> {
  try {
    const proof = commitment(raw);
    const trusted = authority(request.authorityId, roots);
    if (
      !(request.queryDer instanceof Uint8Array) ||
      !(response instanceof Uint8Array) ||
      !request.queryDer.byteLength ||
      request.queryDer.byteLength > MAX_TIMESTAMP_REQUEST_BYTES ||
      !response.byteLength ||
      response.byteLength > MAX_TIMESTAMP_RESPONSE_BYTES
    )
      throw new Error('Proof size');
    const queryBytes = Buffer.from(request.queryDer),
      responseBytes = Buffer.from(response);
    const query = inspectTimestampRequest(queryBytes);
    if (
      request.commitmentHash !== proof.commitmentHash ||
      query.hash !== proof.commitmentHash ||
      query.policy !== trusted.policyOid
    )
      throw new Error('Request mismatch');
    const tokenBytes = inspectTimestampResponse(responseBytes);
    const content = inspectTimestampToken(tokenBytes);
    const stamp = inspectTimestampInfo(content);
    if (
      stamp.hash !== proof.commitmentHash ||
      stamp.policy !== trusted.policyOid ||
      stamp.nonce !== query.nonce ||
      stamp.accuracyMs > trusted.maxAccuracyMs
    )
      throw new Error('Timestamp terms mismatch');
    const observedFromMs = stamp.lowerMs - stamp.accuracyMs;
    const observedThroughMs = stamp.upperMs + stamp.accuracyMs;
    if (
      observedFromMs < proof.commitment.preparedAtMs ||
      observedThroughMs >= proof.commitment.closesAtMs
    )
      throw new Error('Timestamp falls outside preparation and cutoff');
    return await temporary(async (directory) => {
      const file = (name: string) => path.join(directory, name);
      const writes = await Promise.allSettled([
        writeFile(file('query.der'), queryBytes, { mode: 0o600 }),
        writeFile(file('response.der'), responseBytes, { mode: 0o600 }),
        writeFile(file('token.der'), tokenBytes, { mode: 0o600 }),
        writeFile(file('root.pem'), trusted.rootCertificatePem, { mode: 0o600 }),
        writeFile(file('signer.pem'), trusted.signerCertificatePem, { mode: 0o600 }),
      ]);
      if (writes.some((write) => write.status === 'rejected'))
        throw new Error('Witness file unavailable');
      const attime = String(Math.floor(stamp.lowerMs / 1_000));
      await openssl([
        'cms',
        '-verify',
        '-binary',
        '-inform',
        'DER',
        '-in',
        file('token.der'),
        '-nointern',
        '-certfile',
        file('signer.pem'),
        '-CAfile',
        file('root.pem'),
        '-no-CAfile',
        '-no-CApath',
        '-no-CAstore',
        '-purpose',
        'timestampsign',
        '-auth_level',
        '2',
        '-attime',
        attime,
        '-out',
        file('verified-info.der'),
      ]);
      if (!(await readFile(file('verified-info.der'))).equals(content))
        throw new Error('Authenticated content mismatch');
      // This separately checks RFC 3161 nonce, imprint, policy, ESS signer binding
      // and timestamp-specific certificate usage against the original query.
      await openssl([
        'ts',
        '-verify',
        '-queryfile',
        file('query.der'),
        '-in',
        file('response.der'),
        '-CAfile',
        file('root.pem'),
        '-untrusted',
        file('signer.pem'),
        '-attime',
        attime,
        '-auth_level',
        '2',
      ]);
      const result = Object.freeze({
        authorityId: trusted.id,
        commitmentHash: proof.commitmentHash,
        responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
        serial: stamp.serial,
        observedFromMs,
        observedThroughMs,
      });
      verified.add(result);
      return result;
    });
  } catch {
    throw new PublicationWitnessUnavailable();
  }
}

/** Pure precondition for the next ledger phase; not wired to any Coin writer.
 * Caller must supply an independently enforced database-clock error bound.
 */
export function requireWitnessedAdmission(
  raw: unknown,
  witness: VerifiedPublicationWitness,
  nowMs: number,
  databaseClockErrorMs: number
): string {
  try {
    const proof = commitment(raw);
    if (
      !verified.has(witness) ||
      proof.stage !== 'PENDING' ||
      witness.commitmentHash !== proof.commitmentHash ||
      !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(databaseClockErrorMs) ||
      databaseClockErrorMs < 0 ||
      databaseClockErrorMs > 5_000 ||
      witness.observedThroughMs >= nowMs - databaseClockErrorMs ||
      nowMs - databaseClockErrorMs < proof.commitment.opensAtMs ||
      nowMs + databaseClockErrorMs >= proof.commitment.closesAtMs
    )
      throw new PublicationWitnessUnavailable();
    return proof.commitmentHash;
  } catch {
    throw new PublicationWitnessUnavailable();
  }
}
