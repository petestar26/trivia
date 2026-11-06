import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@socialplay/config', () => ({
  config: { STORAGE_PROVIDER: 'local', STORAGE_LOCAL_PATH: './unused' },
}));
import { LocalStorageProvider } from './index.js';
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it('retains uploaded bytes, nested keys and metadata across provider recreation', async () => {
  root = await mkdtemp(join(tmpdir(), 'salem-persistence-'));
  const bytes = Buffer.from('disposable persistence fixture');
  const file = { bucket: 'voice-messages', key: 'member/recording.ogg' };
  const first = new LocalStorageProvider(root);
  const receipt = await first.upload({
    ...file,
    file: bytes,
    mimeType: 'audio/ogg',
    originalName: 'recording.ogg',
  });
  const replacement = new LocalStorageProvider(root);
  expect(await replacement.download(file)).toEqual(bytes);
  expect(await replacement.getFileInfo(file.bucket, file.key)).toMatchObject({
    size: bytes.length,
    etag: receipt.etag,
  });
  expect(await replacement.listFiles(file.bucket)).toHaveLength(1);
  await replacement.delete(file);
  expect(await first.fileExists(file.bucket, file.key)).toBe(false);
});
