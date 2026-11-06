import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertUploadPersistence } from './readiness.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'salem-volume-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const mounted = (root: string) => async () => `42 1 8:1 / ${root} rw - ext4 /dev/volume rw\n`;
it('allows ordinary local development without a Railway volume', async () => {
  await expect(assertUploadPersistence('./uploads', {})).resolves.toBeUndefined();
});
it.each([undefined, '/different-volume'])(
  'rejects absent or unrelated Railway volume %s',
  async (mount) => {
    await expect(
      assertUploadPersistence(root, {
        RAILWAY_ENVIRONMENT_ID: 'test',
        RAILWAY_VOLUME_MOUNT_PATH: mount,
      })
    ).rejects.toThrow('persistent Railway volume');
  }
);
it('rejects an asserted volume that is absent from the kernel mount table', async () => {
  await expect(
    assertUploadPersistence(
      root,
      { RAILWAY_ENVIRONMENT_ID: 'test', RAILWAY_VOLUME_MOUNT_PATH: root },
      mounted('/other')
    )
  ).rejects.toThrow('not mounted');
});
it('rejects sibling paths, traversal and symlinks escaping the actual mount', async () => {
  const env = { RAILWAY_ENVIRONMENT_ID: 'test', RAILWAY_VOLUME_MOUNT_PATH: root };
  for (const bad of [`${root}-copy`, path.join(root, '..', 'other'), './uploads']) {
    await expect(assertUploadPersistence(bad, env, mounted(root))).rejects.toThrow(
      'persistent Railway volume'
    );
  }
  await symlink(tmpdir(), path.join(root, 'escape'));
  await expect(
    assertUploadPersistence(path.join(root, 'escape'), env, mounted(root))
  ).rejects.toThrow('outside');
});
it('accepts a directory on the mounted filesystem, including escaped mount paths', async () => {
  const mount = path.join(root, 'persistent uploads');
  await mkdir(mount);
  await expect(
    assertUploadPersistence(
      path.join(mount, 'voice'),
      { RAILWAY_ENVIRONMENT_ID: 'test', RAILWAY_VOLUME_MOUNT_PATH: mount },
      mounted(mount.replaceAll(' ', '\\040'))
    )
  ).resolves.toBeUndefined();
});
