import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readBeaconProofFile } from '../../scripts/house-round-recovery.js';

const injected = vi.hoisted(() => ({ staleSize: false, readBytes: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>();
  return { ...original,
    fstatSync: (fd: number) => {
      const stat = original.fstatSync(fd);
      if (injected.staleSize) stat.size = 0;
      return stat;
    },
    statSync: (path: string) => {
      const stat = original.statSync(path);
      if (injected.staleSize) stat.size = 0;
      return stat;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const count = original.readSync(fd, buffer, offset, length, position);
      injected.readBytes += count;
      return count;
    },
  };
});
const directory = mkdtempSync(join(tmpdir(), 'playqube-proof-'));
let sequence = 0;
afterEach(() => { injected.staleSize = false; injected.readBytes = 0; });
// Remove only this test file's private fixture directory.
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function regular(bytes: number) {
  const path = join(directory, `proof-${sequence++}.json`);
  writeFileSync(path, JSON.stringify('x'.repeat(bytes - 2)));
  return path;
}
describe('bounded recovery proof file input', () => {
  it('accepts a regular JSON file exactly at the byte limit', () => {
    expect(readBeaconProofFile(regular(65_536))).toBe('x'.repeat(65_534));
  });
  it('rejects a regular file above the byte limit', () => {
    expect(() => readBeaconProofFile(regular(65_537))).toThrow('oversized');
  });
  it('bounds reads even if size metadata is stale after the file grows', () => {
    const path = regular(200_000);
    injected.staleSize = true;
    expect(() => readBeaconProofFile(path)).toThrow('oversized');
    expect(injected.readBytes).toBe(65_537);
  });
  it.skipIf(process.platform === 'win32')('rejects a FIFO without consuming its oversized input', () => {
    const path = join(directory, 'proof-pipe');
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    const writer = spawn(process.execPath, ['-e',
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify("x".repeat(200000)))', path], { stdio: 'ignore' });
    try { expect(() => readBeaconProofFile(path)).toThrow('regular file'); }
    finally { writer.kill(); }
    expect(injected.readBytes).toBe(0);
  });
  it.skipIf(process.platform === 'win32')('rejects a character device without reading it', () => {
    expect(() => readBeaconProofFile('/dev/null')).toThrow('regular file');
    expect(injected.readBytes).toBe(0);
  });
});
