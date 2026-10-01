import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PUBLICATION_JSON_BYTES,
  QUICKNET_CHAIN_HASH,
  QUICKNET_PROTOCOL,
  SPIN90_RULES_ID,
  quicknetTargetForCutoff,
} from '@socialplay/shared';
import {
  main,
  parsePublicationVerifyCommand,
  readPublicationArchiveFile,
} from '../../scripts/publication-receipt-verify.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(path.join(tmpdir(), 'publication-reader-test-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
const file = () => path.join(directory, 'evidence.json');
// Parser failure is intentional: exercise bounded IO independently of trust.
const write = (value = '{}') => {
  writeFileSync(file(), value);
  return file();
};
describe('offline publication command', () => {
  it('requires both the file and earlier hash; rejects duplicates and trust overrides', () => {
    const args = ['--file=a=b.json', `--commitment=${'a'.repeat(64)}`];
    expect(parsePublicationVerifyCommand(args)).toEqual({
      file: 'a=b.json',
      commitmentHash: 'a'.repeat(64),
    });
    for (const bad of [
      [],
      [args[0]],
      [...args, args[0]],
      [...args, '--root=x'],
      ['--file', 'x'],
      [...args, '--url=https://untrusted'],
    ])
      expect(() => parsePublicationVerifyCommand(bad)).toThrow();
  });
  it('safe exit metadata never exposes paths or underlying parse errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await main([`--file=${write('private malformed text')}`, `--commitment=${'a'.repeat(64)}`])
    ).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('{"status":"BLOCKED"}');
  });
  it('usage/help cannot enable network or trust configuration', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(await main([])).toBe(2);
  });
  it('opens nonblocking and closes on parser failure', () => {
    expect(() => readPublicationArchiveFile(write())).toThrow();
    expect(openSync).toHaveBeenCalledWith(file(), expect.any(Number));
    expect(vi.mocked(openSync).mock.calls[0][1] as number).toBe(
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
    );
    expect(closeSync).toHaveBeenCalledOnce();
  });
  it('rejects nonregular and oversized files before a read, with descriptor cleanup', () => {
    expect(() => readPublicationArchiveFile(directory)).toThrow();
    expect(readSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    expect(() =>
      readPublicationArchiveFile(write(' '.repeat(MAX_PUBLICATION_JSON_BYTES + 1)))
    ).toThrow();
    expect(readSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledOnce();
  });
  it('bounds growth after fstat to at most limit + 1 bytes, including partial reads', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs');
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const stat = actual.fstatSync(fd);
      appendFileSync(file(), ' '.repeat(MAX_PUBLICATION_JSON_BYTES * 2));
      return stat;
    });
    let readBytes = 0;
    vi.mocked(readSync).mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null
    ) => {
      const count = actual.readSync(
        fd,
        buffer,
        offset as number,
        Math.min(length as number, 17),
        position as number | null
      );
      readBytes += count;
      return count;
    }) as typeof readSync);
    expect(() => readPublicationArchiveFile(write())).toThrow();
    expect(readBytes).toBe(MAX_PUBLICATION_JSON_BYTES + 1);
    expect(closeSync).toHaveBeenCalledOnce();
    vi.mocked(readSync).mockImplementation(actual.readSync);
  });
  it('reads the opened descriptor if its pathname is replaced', async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs');
    vi.mocked(fstatSync).mockImplementationOnce((fd) => {
      const stat = actual.fstatSync(fd);
      renameSync(file(), path.join(directory, 'old'));
      writeFileSync(file(), ' '.repeat(MAX_PUBLICATION_JSON_BYTES * 2));
      return stat;
    });
    expect(() => readPublicationArchiveFile(write())).toThrow();
    expect(vi.mocked(readSync).mock.results[0].value).toBe(2);
    expect(closeSync).toHaveBeenCalledOnce();
  });
  it('reads exact-limit regular JSON successfully and closes its descriptor', () => {
    const now = Date.now(),
      closesAtMs = now + 120_000,
      target = quicknetTargetForCutoff(closesAtMs);
    const archive = {
      schema: 'playqube-spin-publication-v1',
      roundId: 'cli:1',
      proof: {
        schema: 'playqube-spin-proof-v1',
        stage: 'PENDING',
        reveal: null,
        commitmentHash: 'a'.repeat(64),
        commitment: {
          roundId: 'cli:1',
          rulesId: SPIN90_RULES_ID,
          protocol: QUICKNET_PROTOCOL,
          chainHash: QUICKNET_CHAIN_HASH,
          opensAtMs: now - 40_000,
          pinnedAtMs: now - 30_000,
          preparedAtMs: now - 20_000,
          closesAtMs,
          seedCommitment: 'b'.repeat(64),
          beaconRound: target.beaconRound,
          beaconTimeMs: target.beaconTimeMs,
        },
      },
      authority: {
        authorityId: 'structural-only-test',
        rootCertificateSha256: 'c'.repeat(64),
        signerCertificateSha256: 'd'.repeat(64),
        policyOid: '1.2.3',
        maxAccuracyMs: 10,
      },
      request: { sha256: 'e'.repeat(64), derBase64: 'AA==', nonceHex: '1' },
      receipt: null,
    };
    expect(
      readPublicationArchiveFile(
        write(JSON.stringify(archive).padEnd(MAX_PUBLICATION_JSON_BYTES, ' '))
      )
    ).toEqual(archive);
    expect(closeSync).toHaveBeenCalledOnce();
  });
  it('rejects invalid UTF-8 instead of replacing bytes', () => {
    writeFileSync(file(), Buffer.from([0xff]));
    expect(() => readPublicationArchiveFile(file())).toThrow();
    expect(closeSync).toHaveBeenCalledOnce();
  });
  it('closes after fstat and read exceptions', () => {
    vi.mocked(fstatSync).mockImplementationOnce(() => {
      throw new Error('private stat failure');
    });
    expect(() => readPublicationArchiveFile(write())).toThrow();
    expect(closeSync).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw new Error('private read failure');
    });
    expect(() => readPublicationArchiveFile(write())).toThrow();
    expect(closeSync).toHaveBeenCalledOnce();
  });
});
