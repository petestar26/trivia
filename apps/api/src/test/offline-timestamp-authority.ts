// Test-only issuer. Never imported by an API, worker, CLI or trust registry.
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PublicationAuthority } from '../games/economics/publication-authorities.js';

export async function offlineTimestampAuthority() {
  const directory = await mkdtemp(path.join(tmpdir(), 'playqube-storage-test-tsa-'));
  const file = (name: string) => path.join(directory, name);
  const run = promisify(execFile);
  const ssl = (args: string[]) =>
    run('openssl', args, {
      timeout: 5_000,
      maxBuffer: 262_144,
      env: { PATH: process.env.PATH, OPENSSL_CONF: '/dev/null' },
    });
  try {
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
      '/CN=TEST ONLY storage root',
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
      '/CN=TEST ONLY storage timestamp signer',
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
    await writeFile(file('serial'), '01\n');
    const policyOid = '1.3.6.1.4.1.57264.1.2';
    await writeFile(
      file('tsa.cnf'),
      [
        '[tsa]',
        'default_tsa=tsa_config',
        '[tsa_config]',
        `serial=${file('serial')}`,
        `signer_cert=${file('signer.pem')}`,
        `signer_key=${file('signer.key')}`,
        `certs=${file('root.pem')}`,
        'signer_digest=sha256',
        `default_policy=${policyOid}`,
        `other_policies=${policyOid}`,
        'digests=sha256',
        'accuracy=millisecs:1',
        'clock_precision_digits=3',
        'ordering=yes',
        'tsa_name=yes',
        'ess_cert_id_chain=no',
        'ess_cert_id_alg=sha256',
      ].join('\n')
    );
    const signerCertificatePem = await readFile(file('signer.pem'), 'utf8');
    const authority: PublicationAuthority = Object.freeze({
      id: 'test-storage-offline-only',
      policyOid,
      maxAccuracyMs: 10,
      rootCertificatePem: await readFile(file('root.pem'), 'utf8'),
      signerCertificatePem,
      signerCertificateSha256: createHash('sha256')
        .update(new X509Certificate(signerCertificatePem).raw)
        .digest('hex'),
    });
    return {
      authority,
      // Sequential issuer (tests intentionally issue responses in order).
      async issue(queryDer: Uint8Array) {
        await writeFile(file('query.der'), queryDer);
        await ssl([
          'ts',
          '-reply',
          '-config',
          file('tsa.cnf'),
          '-queryfile',
          file('query.der'),
          '-out',
          file('response.der'),
        ]);
        return readFile(file('response.der'));
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
