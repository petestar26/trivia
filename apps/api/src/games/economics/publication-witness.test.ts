import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  QUICKNET_CHAIN_HASH,
  QUICKNET_PROTOCOL,
  SPIN90_RULES_ID,
  quicknetTargetForCutoff,
  spinPublicCommitmentFrame,
  spinSeedCommitmentFrame,
} from '@socialplay/shared';
import type { SpinPublicProof } from '@socialplay/shared';
import type { PublicationAuthority } from './publication-authorities.js';
import {
  createPublicationRequest,
  verifyPublicationWitness,
  requireWitnessedAdmission,
  PublicationWitnessUnavailable,
  MAX_TIMESTAMP_RESPONSE_BYTES,
} from './publication-witness.js';
import type { PublicationRequest, VerifiedPublicationWitness } from './publication-witness.js';
import {
  inspectTimestampInfo,
  inspectTimestampRequest,
  inspectTimestampResponse,
  inspectTimestampToken,
} from './rfc3161-codec.js';

const run = promisify(execFile);
const policy = '1.3.6.1.4.1.57264.1.1';
let directory: string;
let trusted: PublicationAuthority;
let proof: SpinPublicProof;
let request: PublicationRequest;
let response: Buffer;
let witness: Readonly<VerifiedPublicationWitness>;
const file = (name: string) => path.join(directory, name);
async function ssl(args: string[]) {
  return run('openssl', args, {
    timeout: 5_000,
    maxBuffer: 262_144,
    env: { PATH: process.env.PATH, OPENSSL_CONF: '/dev/null' },
  });
}
function der(tag: number, content: Buffer): Buffer {
  const length = Buffer.from(content.length.toString(16).padStart(4, '0'), 'hex');
  return Buffer.concat([Buffer.from([tag, 0x82]), length, content]);
}
function hash(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}
function pendingProof(roundId = 'timestamp-test:1'): SpinPublicProof {
  const now = Date.now();
  const closesAtMs = now + 120_000;
  const target = quicknetTargetForCutoff(closesAtMs);
  const commitment: SpinPublicProof['commitment'] = {
    roundId,
    rulesId: SPIN90_RULES_ID,
    protocol: QUICKNET_PROTOCOL,
    chainHash: QUICKNET_CHAIN_HASH,
    opensAtMs: now - 40_000,
    closesAtMs,
    pinnedAtMs: now - 30_000,
    preparedAtMs: now - 20_000,
    seedCommitment: hash(spinSeedCommitmentFrame(roundId, SPIN90_RULES_ID, '00'.repeat(32))),
    beaconRound: target.beaconRound,
    beaconTimeMs: target.beaconTimeMs,
  };
  return {
    schema: 'playqube-spin-proof-v1',
    stage: 'PENDING',
    reveal: null,
    commitment,
    commitmentHash: hash(spinPublicCommitmentFrame(commitment)),
  };
}
function changed(edit: (p: SpinPublicProof) => void) {
  const p = structuredClone(proof);
  edit(p);
  p.commitmentHash = hash(spinPublicCommitmentFrame(p.commitment));
  return p;
}
async function issue(query: PublicationRequest, configuration = 'tsa.cnf') {
  await writeFile(file('query.der'), query.queryDer, { mode: 0o600 });
  await ssl([
    'ts',
    '-reply',
    '-config',
    file(configuration),
    '-queryfile',
    file('query.der'),
    '-out',
    file('response.der'),
  ]);
  return readFile(file('response.der'));
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'playqube-test-tsa-'));
  await ssl([
    'req',
    '-new',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=TEST ONLY timestamp root',
    '-keyout',
    file('root.key'),
    '-out',
    file('root.pem'),
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  await ssl([
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-subj',
    '/CN=TEST ONLY offline timestamp signer',
    '-keyout',
    file('signer.key'),
    '-out',
    file('signer.csr'),
  ]);
  await writeFile(
    file('signer.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=critical,timeStamping',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
    ].join('\n')
  );
  await ssl([
    'x509',
    '-req',
    '-in',
    file('signer.csr'),
    '-CA',
    file('root.pem'),
    '-CAkey',
    file('root.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    file('signer.ext'),
    '-out',
    file('signer.pem'),
  ]);
  await writeFile(
    file('other.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=critical,serverAuth',
    ].join('\n')
  );
  await ssl([
    'x509',
    '-req',
    '-in',
    file('signer.csr'),
    '-CA',
    file('root.pem'),
    '-CAkey',
    file('root.key'),
    '-set_serial',
    '2',
    '-days',
    '2',
    '-extfile',
    file('other.ext'),
    '-out',
    file('other.pem'),
  ]);
  await writeFile(file('serial'), '01\n');
  const config = [
    '[tsa]',
    'default_tsa=tsa_config',
    '[tsa_config]',
    `serial=${file('serial')}`,
    `signer_cert=${file('signer.pem')}`,
    `signer_key=${file('signer.key')}`,
    `certs=${file('root.pem')}`,
    'signer_digest=sha256',
    `default_policy=${policy}`,
    `other_policies=${policy}`,
    'digests=sha256',
    'accuracy=secs:1',
    'clock_precision_digits=3',
    'ordering=yes',
    'tsa_name=yes',
    'ess_cert_id_chain=no',
    'ess_cert_id_alg=sha256',
  ].join('\n');
  await writeFile(file('tsa.cnf'), config);
  await writeFile(file('inaccurate.cnf'), config.replace('accuracy=secs:1', 'accuracy=secs:6'));
  await writeFile(file('no-accuracy.cnf'), config.replace('accuracy=secs:1', ''));
  const signerCertificatePem = await readFile(file('signer.pem'), 'utf8');
  trusted = {
    id: 'test-offline-only',
    policyOid: policy,
    maxAccuracyMs: 1_000,
    rootCertificatePem: await readFile(file('root.pem'), 'utf8'),
    signerCertificatePem,
    signerCertificateSha256: hash(new X509Certificate(signerCertificatePem).raw),
  };
  proof = pendingProof();
  request = await createPublicationRequest(proof, trusted.id, [trusted]);
  response = await issue(request);
  witness = await verifyPublicationWitness(proof, request, response, [trusted]);
}, 20_000);
afterAll(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
});

describe('offline RFC 3161 witness, with a real test-only authority', () => {
  it('generates a nonce-bearing SHA-256 query and verifies real CMS, TSA usage, ESS and signed accuracy', () => {
    expect(inspectTimestampRequest(request.queryDer)).toMatchObject({
      hash: proof.commitmentHash,
      policy,
    });
    expect(witness).toMatchObject({
      authorityId: trusted.id,
      commitmentHash: proof.commitmentHash,
      responseSha256: hash(response),
    });
    expect(witness.observedFromMs).toBeGreaterThanOrEqual(proof.commitment.preparedAtMs);
    expect(witness.observedThroughMs).toBeLessThan(proof.commitment.closesAtMs);
    expect(witness.observedThroughMs - witness.observedFromMs).toBe(2_000);
    expect(Object.isFrozen(witness)).toBe(true);
  });
  it('defaults to no approved production authority', async () => {
    await expect(createPublicationRequest(proof, trusted.id)).rejects.toThrow(
      PublicationWitnessUnavailable
    );
    await expect(verifyPublicationWitness(proof, request, response)).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it('rejects a signed response to another valid query nonce', async () => {
    const another = await createPublicationRequest(proof, trusted.id, [trusted]);
    expect(inspectTimestampRequest(another.queryDer).nonce).not.toBe(
      inspectTimestampRequest(request.queryDer).nonce
    );
    await expect(verifyPublicationWitness(proof, another, response, [trusted])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it('rejects substitution of the commitment and metadata, even with a valid timestamp signature', async () => {
    const p = changed((p) => {
      p.commitment.seedCommitment = 'ff'.repeat(32);
    });
    await expect(
      verifyPublicationWitness(p, { ...request, commitmentHash: p.commitmentHash }, response, [
        trusted,
      ])
    ).rejects.toThrow(PublicationWitnessUnavailable);
    await expect(
      verifyPublicationWitness({ ...proof, commitmentHash: 'ff'.repeat(32) }, request, response, [
        trusted,
      ])
    ).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it.each(['policy', 'fingerprint', 'root', 'signer', 'duplicate'] as const)(
    'rejects an untrusted %s configuration',
    async (which) => {
      const other = { ...trusted };
      if (which === 'policy') other.policyOid = '1.3.6.1.4.1.57264.2';
      if (which === 'fingerprint') other.signerCertificateSha256 = '00'.repeat(32);
      if (which === 'root') other.rootCertificatePem = trusted.signerCertificatePem;
      if (which === 'signer') {
        other.signerCertificatePem = trusted.rootCertificatePem;
        other.signerCertificateSha256 = hash(new X509Certificate(other.signerCertificatePem).raw);
      }
      await expect(
        verifyPublicationWitness(
          proof,
          request,
          response,
          which === 'duplicate' ? [other, other] : [other]
        )
      ).rejects.toThrow(PublicationWitnessUnavailable);
    }
  );
  it('rejects tampered CMS signature bytes with matching signed metadata', async () => {
    const corrupted = Buffer.from(response);
    corrupted[corrupted.length - 1] ^= 1;
    await expect(verifyPublicationWitness(proof, request, corrupted, [trusted])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it('does not let an additional PEM certificate bypass the exact leaf pin', async () => {
    const other = await readFile(file('other.pem'), 'utf8');
    const badPin = {
      ...trusted,
      signerCertificatePem: other + trusted.signerCertificatePem,
      signerCertificateSha256: hash(new X509Certificate(other).raw),
    };
    await expect(verifyPublicationWitness(proof, request, response, [badPin])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it('rejects a cryptographically valid signer without exclusive TSA certificate usage', async () => {
    const info = inspectTimestampToken(inspectTimestampResponse(response));
    await writeFile(file('other-info.der'), info);
    await ssl([
      'cms',
      '-sign',
      '-binary',
      '-nodetach',
      '-cades',
      '-md',
      'sha256',
      '-in',
      file('other-info.der'),
      '-signer',
      file('other.pem'),
      '-inkey',
      file('signer.key'),
      '-outform',
      'DER',
      '-econtent_type',
      '1.2.840.113549.1.9.16.1.4',
      '-out',
      file('other-token.der'),
    ]);
    await ssl([
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      file('other-token.der'),
      '-CAfile',
      file('root.pem'),
      '-purpose',
      'any',
      '-out',
      file('other-verified.der'),
    ]);
    expect(await readFile(file('other-verified.der'))).toEqual(info);
    const cert = await readFile(file('other.pem'), 'utf8');
    const badUsage = {
      ...trusted,
      signerCertificatePem: cert,
      signerCertificateSha256: hash(new X509Certificate(cert).raw),
    };
    const timestamp = der(
      0x30,
      Buffer.concat([Buffer.from('3003020100', 'hex'), await readFile(file('other-token.der'))])
    );
    await expect(verifyPublicationWitness(proof, request, timestamp, [badUsage])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it('rejects trailing response bytes instead of letting OpenSSL ignore them', async () => {
    await expect(
      verifyPublicationWitness(proof, request, Buffer.concat([response, Buffer.from([0])]), [
        trusted,
      ])
    ).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it('rejects an otherwise correctly signed CMS token without RFC 3161 ESS binding', async () => {
    await writeFile(file('good-response.der'), response);
    await ssl([
      'ts',
      '-reply',
      '-in',
      file('good-response.der'),
      '-token_out',
      '-out',
      file('token.der'),
    ]);
    const info = inspectTimestampToken(await readFile(file('token.der')));
    await writeFile(file('info.der'), info);
    await ssl([
      'cms',
      '-sign',
      '-binary',
      '-nodetach',
      '-md',
      'sha256',
      '-in',
      file('info.der'),
      '-signer',
      file('signer.pem'),
      '-inkey',
      file('signer.key'),
      '-outform',
      'DER',
      '-econtent_type',
      '1.2.840.113549.1.9.16.1.4',
      '-out',
      file('no-ess-token.der'),
    ]);
    const token = await readFile(file('no-ess-token.der'));
    // Actual CMS verification passes. Timestamp-specific verification must
    // additionally reject the absent ESS signing-certificate attribute.
    await ssl([
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      file('no-ess-token.der'),
      '-CAfile',
      file('root.pem'),
      '-purpose',
      'timestampsign',
      '-out',
      file('cms-content.der'),
    ]);
    expect(await readFile(file('cms-content.der'))).toEqual(info);
    const forgedResponse = der(0x30, Buffer.concat([Buffer.from('3003020100', 'hex'), token]));
    await expect(
      verifyPublicationWitness(proof, request, forgedResponse, [trusted])
    ).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it.each(['inaccurate.cnf', 'no-accuracy.cnf'])(
    'rejects signed insufficient accuracy: %s',
    async (configuration) => {
      await expect(
        verifyPublicationWitness(proof, request, await issue(request, configuration), [trusted])
      ).rejects.toThrow(PublicationWitnessUnavailable);
    }
  );
  it('rejects signed observations outside the round window', async () => {
    const tooEarly = pendingProof('timestamp-test:early');
    tooEarly.commitment.preparedAtMs = Date.now() + 30_000;
    tooEarly.commitmentHash = hash(spinPublicCommitmentFrame(tooEarly.commitment));
    const q = await createPublicationRequest(tooEarly, trusted.id, [trusted]);
    await expect(verifyPublicationWitness(tooEarly, q, await issue(q), [trusted])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
    const closed = pendingProof('timestamp-test:closed');
    closed.commitment.closesAtMs = Date.now() - 1_000;
    const target = quicknetTargetForCutoff(closed.commitment.closesAtMs);
    closed.commitment.beaconRound = target.beaconRound;
    closed.commitment.beaconTimeMs = target.beaconTimeMs;
    closed.commitmentHash = hash(spinPublicCommitmentFrame(closed.commitment));
    const q2 = await createPublicationRequest(closed, trusted.id, [trusted]);
    await expect(verifyPublicationWitness(closed, q2, await issue(q2), [trusted])).rejects.toThrow(
      PublicationWitnessUnavailable
    );
  });
  it.each([
    Buffer.alloc(0),
    Buffer.alloc(MAX_TIMESTAMP_RESPONSE_BYTES + 1),
    Buffer.from('not DER'),
  ])('rejects invalid response sizes or formats without leaking subprocess errors', async (bad) => {
    await expect(verifyPublicationWitness(proof, request, bad, [trusted])).rejects.toThrow(
      /^Independent publication witness is unavailable$/
    );
  });
  it('authenticates the same TSTInfo bytes the metadata decoder uses', async () => {
    await writeFile(file('good-response.der'), response);
    await ssl([
      'ts',
      '-reply',
      '-in',
      file('good-response.der'),
      '-token_out',
      '-out',
      file('token.der'),
    ]);
    const info = inspectTimestampInfo(inspectTimestampToken(await readFile(file('token.der'))));
    expect(info.hash).toBe(proof.commitmentHash);
    expect(info.policy).toBe(policy);
    expect(info.nonce).toBe(inspectTimestampRequest(request.queryDer).nonce);
    expect(info.accuracyMs).toBe(1_000);
  });
});

describe('pure, dormant admission precondition', () => {
  it('accepts only an actual verified witness for the same receipt strictly before admission and closing', () => {
    const now = witness.observedThroughMs + 1_001;
    expect(requireWitnessedAdmission(proof, witness, now, 1_000)).toBe(proof.commitmentHash);
    expect(() => requireWitnessedAdmission(proof, { ...witness }, now, 1_000)).toThrow(
      PublicationWitnessUnavailable
    );
    expect(() =>
      requireWitnessedAdmission(
        changed((p) => {
          p.commitment.roundId = 'other';
        }),
        witness,
        now,
        1_000
      )
    ).toThrow(PublicationWitnessUnavailable);
  });
  it('rejects the accuracy and clock boundaries at equality', () => {
    expect(() =>
      requireWitnessedAdmission(proof, witness, witness.observedThroughMs + 1_000, 1_000)
    ).toThrow(PublicationWitnessUnavailable);
    expect(() =>
      requireWitnessedAdmission(proof, witness, proof.commitment.closesAtMs - 1_000, 1_000)
    ).toThrow(PublicationWitnessUnavailable);
  });
  it.each([-1, 5_001, 0.1, NaN])('rejects an invalid database-clock error budget %s', (bound) => {
    expect(() =>
      requireWitnessedAdmission(proof, witness, witness.observedThroughMs + 10_000, bound)
    ).toThrow(PublicationWitnessUnavailable);
  });
});
