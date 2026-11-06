import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Run at API startup, not build time: Railway mounts volumes only at runtime. */
export async function assertUploadPersistence(
  basePath: string,
  env: { RAILWAY_ENVIRONMENT_ID?: string; RAILWAY_VOLUME_MOUNT_PATH?: string } = process.env,
  readMountInfo = () => readFile('/proc/self/mountinfo', 'utf8')
): Promise<void> {
  if (!env.RAILWAY_ENVIRONMENT_ID) return;
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!mount || !path.isAbsolute(mount) || !path.isAbsolute(basePath) || !within(mount, basePath)) {
    throw new Error(
      'Upload storage requires a persistent Railway volume and an absolute STORAGE_LOCAL_PATH inside its mount.'
    );
  }
  // A variable alone is not proof of a mounted filesystem. Match the kernel's
  // mount table, decoding the octal escapes used for spaces and backslashes.
  const mounts = (await readMountInfo())
    .split('\n')
    .map((line) =>
      line
        .split(' ')[4]
        ?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    );
  if (!mounts.includes(path.resolve(mount))) {
    throw new Error(
      'The configured upload volume is not mounted; refusing temporary upload storage.'
    );
  }
  await mkdir(basePath, { recursive: true });
  if (!within(await realpath(mount), await realpath(basePath))) {
    throw new Error('STORAGE_LOCAL_PATH resolves outside the persistent upload volume.');
  }
}
