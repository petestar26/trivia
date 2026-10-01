import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodePublicationDer,
  MAX_PUBLICATION_JSON_BYTES,
  parsePublicPublicationArchive,
  parsePublicationArchiveText,
  QUICKNET_CHAIN_HASH,
  QUICKNET_PROTOCOL,
  SPIN90_RULES_ID,
  quicknetTargetForCutoff,
  spinPublicCommitmentFrame,
  spinSeedCommitmentFrame,
} from '@socialplay/shared';
import type { PublicPublicationArchive, SpinPublicProof } from '@socialplay/shared';
import { offlineTimestampAuthority } from '../../test/offline-timestamp-authority.js';
import {
  createPublicationRequest,
  publicationAuthorityIdentity,
  verifyPublicationWitness,
  PublicationWitnessUnavailable,
} from './publication-witness.js';
import { inspectTimestampRequest } from './rfc3161-codec.js';
import { verifyPortablePublicationArchive } from './publication-receipt.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let tsa: Awaited<ReturnType<typeof offlineTimestampAuthority>>;
let archive: PublicPublicationArchive;
beforeAll(async () => {
  tsa = await offlineTimestampAuthority();
  const now = Date.now(),
    roundId = 'portable-receipt:1',
    closesAtMs = now + 120_000;
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
  const proof: SpinPublicProof = {
    schema: 'playqube-spin-proof-v1',
    stage: 'PENDING',
    reveal: null,
    commitment,
    commitmentHash: hash(spinPublicCommitmentFrame(commitment)),
  };
  const request = await createPublicationRequest(proof, tsa.authority.id, [tsa.authority]);
  const response = await tsa.issue(request.queryDer);
  const witness = await verifyPublicationWitness(proof, request, response, [tsa.authority]);
  archive = {
    schema: 'playqube-spin-publication-v1',
    roundId,
    proof,
    authority: publicationAuthorityIdentity(tsa.authority.id, [tsa.authority]),
    request: {
      sha256: hash(request.queryDer),
      derBase64: request.queryDer.toString('base64'),
      nonceHex: inspectTimestampRequest(request.queryDer).nonce,
    },
    receipt: {
      sha256: witness.responseSha256,
      derBase64: response.toString('base64'),
      serialHex: witness.serial,
      observedFromMs: witness.observedFromMs,
      observedThroughMs: witness.observedThroughMs,
    },
  };
});
afterAll(async () => {
  await tsa?.dispose();
});
const verify = (raw: unknown) =>
  verifyPortablePublicationArchive(raw, archive.proof.commitmentHash, [tsa.authority]);

describe('portable timestamp archive with independent trust and earlier receipt', () => {
  it('verifies real CMS/TSA/ESS bytes offline against independently configured certificates', async () => {
    expect(await verify(archive)).toEqual({
      status: 'VERIFIED_TIMESTAMP',
      roundId: archive.roundId,
      commitmentHash: archive.proof.commitmentHash,
      authorityId: tsa.authority.id,
      observedFromMs: archive.receipt!.observedFromMs,
      observedThroughMs: archive.receipt!.observedThroughMs,
    });
  });
  it('file pins cannot supply trust; default source trust remains empty', async () => {
    await expect(
      verifyPortablePublicationArchive(archive, archive.proof.commitmentHash)
    ).rejects.toThrow(PublicationWitnessUnavailable);
    await expect(
      verifyPortablePublicationArchive(archive, archive.proof.commitmentHash, [])
    ).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it('requires the independently saved hash even for otherwise authentic artifacts', async () => {
    for (const expected of ['', 'A'.repeat(64), '00'.repeat(32)])
      await expect(
        verifyPortablePublicationArchive(archive, expected, [tsa.authority])
      ).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it('a request without a receipt is explicitly unverified', async () => {
    expect(await verify({ ...archive, receipt: null })).toMatchObject({
      status: 'REQUEST_ONLY',
      observedFromMs: null,
      observedThroughMs: null,
    });
  });
  it.each([
    'authorityId',
    'rootCertificateSha256',
    'signerCertificateSha256',
    'policyOid',
    'maxAccuracyMs',
  ] as const)('rejects substituted authority metadata: %s', async (key) => {
    const changed = structuredClone(archive);
    Object.assign(changed.authority, {
      [key]:
        key === 'maxAccuracyMs'
          ? 20
          : key === 'policyOid'
            ? '1.2.3'
            : key === 'authorityId'
              ? 'other'
              : '00'.repeat(32),
    });
    await expect(verify(changed)).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it.each(['sha256', 'nonceHex'] as const)('rejects altered query metadata: %s', async (key) => {
    const changed = structuredClone(archive);
    changed.request[key] = key === 'sha256' ? '00'.repeat(32) : '1';
    await expect(verify(changed)).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it.each(['sha256', 'serialHex', 'observedFromMs', 'observedThroughMs'] as const)(
    'rejects altered receipt metadata: %s',
    async (key) => {
      const changed = structuredClone(archive);
      Object.assign(changed.receipt!, {
        [key]:
          key === 'sha256'
            ? '00'.repeat(32)
            : key === 'serialHex'
              ? 'ffffff'
              : (changed.receipt![key] as number) + 1,
      });
      await expect(verify(changed)).rejects.toThrow(PublicationWitnessUnavailable);
    }
  );
  it('rejects corrupted signature bytes even after updating their declared hash', async () => {
    const changed = structuredClone(archive),
      bytes = Buffer.from(changed.receipt!.derBase64, 'base64');
    bytes[bytes.length - 1] ^= 1;
    changed.receipt!.derBase64 = bytes.toString('base64');
    changed.receipt!.sha256 = hash(bytes);
    await expect(verify(changed)).rejects.toThrow(PublicationWitnessUnavailable);
  });
  it('snapshots the caller archive before async verification', async () => {
    const changed = structuredClone(archive),
      promise = verify(changed);
    changed.receipt!.observedFromMs += 1;
    changed.authority.policyOid = '1.2.3';
    expect(await promise).toMatchObject({
      status: 'VERIFIED_TIMESTAMP',
      observedFromMs: archive.receipt!.observedFromMs,
    });
  });
});

describe('bounded strict portable parser', () => {
  it('accepts the exact JSON-byte ceiling but rejects one byte more', () => {
    const text = JSON.stringify(archive).padEnd(MAX_PUBLICATION_JSON_BYTES, ' ');
    expect(parsePublicationArchiveText(text)).toEqual(archive);
    expect(() => parsePublicationArchiveText(text + ' ')).toThrow();
    expect(() =>
      parsePublicationArchiveText('é'.repeat(MAX_PUBLICATION_JSON_BYTES / 2 + 1))
    ).toThrow();
  });
  it.each(['rootCertificatePem', 'url', 'signingKey'])(
    'refuses uploaded trust or extra top-level fields: %s',
    (key) => {
      expect(() => parsePublicPublicationArchive({ ...archive, [key]: 'untrusted' })).toThrow();
    }
  );
  it('rejects mismatched rounds, drawn proof and accessor fields without invoking getters', () => {
    expect(() => parsePublicPublicationArchive({ ...archive, roundId: 'other' })).toThrow();
    expect(() =>
      parsePublicPublicationArchive({ ...archive, proof: { ...archive.proof, stage: 'DRAWN' } })
    ).toThrow();
    const input = { ...archive };
    let calls = 0;
    Object.defineProperty(input, 'request', {
      enumerable: true,
      get() {
        calls++;
        return archive.request;
      },
    });
    expect(() => parsePublicPublicationArchive(input)).toThrow();
    expect(calls).toBe(0);
  });
  it('canonical base64 rejects whitespace, unused pad bits, empty and oversized DER', () => {
    expect(decodePublicationDer('AA==', 1)).toEqual(new Uint8Array([0]));
    for (const bad of ['', 'AB==', 'AAA', 'AA==\n', '-A==', 'AAAA'])
      expect(() => decodePublicationDer(bad, 1)).toThrow();
    const changed = structuredClone(archive);
    changed.receipt!.derBase64 = Buffer.alloc(65_537).toString('base64');
    expect(() => parsePublicPublicationArchive(changed)).toThrow();
  });
});
