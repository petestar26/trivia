import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MAX_PUBLICATION_JSON_BYTES, parsePublicationArchiveText } from '@socialplay/shared';
import { verifyPortablePublicationArchive } from '../games/economics/publication-receipt.js';

const usage =
  'publication-receipt-verify --file=archive.json --commitment=<earlier-saved-64-hex-hash>; offline verification uses approved source trust only';
export function parsePublicationVerifyCommand(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const index = arg.indexOf('=');
    const name = arg.slice(0, index),
      value = arg.slice(index + 1);
    if (index < 0 || !['--file', '--commitment'].includes(name) || !value || values.has(name))
      throw new Error();
    values.set(name, value);
  }
  const file = values.get('--file'),
    commitmentHash = values.get('--commitment');
  if (!file || !commitmentHash || !/^[0-9a-f]{64}$/.test(commitmentHash)) throw new Error();
  return { file, commitmentHash };
}
export function readPublicationArchiveFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PUBLICATION_JSON_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_PUBLICATION_JSON_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_PUBLICATION_JSON_BYTES) throw new Error();
    return parsePublicationArchiveText(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
    );
  } finally {
    closeSync(fd);
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  let command: ReturnType<typeof parsePublicationVerifyCommand>;
  try {
    command = parsePublicationVerifyCommand(args);
  } catch {
    console.error(usage);
    return 2;
  }
  try {
    const result = await verifyPortablePublicationArchive(
      readPublicationArchiveFile(command.file),
      command.commitmentHash
    );
    console.log(JSON.stringify(result));
    return result.status === 'VERIFIED_TIMESTAMP' ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ status: 'BLOCKED' }));
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(JSON.stringify({ status: 'BLOCKED' }));
      process.exitCode = 1;
    });
}
