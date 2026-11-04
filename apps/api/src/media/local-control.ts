import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { mediaMaintenance, type MediaMaintenance } from './maintenance.js';

const MAX_FRAME = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exact = (value: unknown) => JSON.stringify(value);

async function protectedJson(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > MAX_FRAME) {
      throw new Error('Invalid local maintenance authority/state file');
    }
    const buffer = Buffer.alloc(MAX_FRAME + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FRAME) throw new Error('Oversized local maintenance input');
    const text = buffer.subarray(0, size).toString('utf8');
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error('Invalid local maintenance JSON'); }
    return { value, fingerprint: `${stat.dev}:${stat.ino}:${text}` };
  } finally { await handle.close(); }
}

async function assertDirectory(directory: string, anchor?: FileHandle): Promise<void> {
  if (!isAbsolute(directory) || await realpath(directory) !== directory) throw new Error('Maintenance directory must be absolute and canonical');
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Maintenance directory must be owner-only');
  }
  if (anchor) {
    const original = await anchor.stat();
    if (original.ino !== stat.ino || original.dev !== stat.dev) throw new Error('Maintenance directory was replaced');
  }
}

export function controlPayload(challenge: string, incarnation: string, railway: object, timeoutMs: number, requestId: string): string {
  return JSON.stringify({ protocol: 'salem-media-maintenance-v1', challenge, incarnation, railway, command: 'close-and-drain', timeoutMs, requestId });
}

export function mediaControlAddress(installationId: string): string {
  if (!UUID.test(installationId)) throw new Error('Invalid installation identity');
  return `\0salem-media-${installationId}`;
}

export function signedControlFrame(payload: object, key: KeyObject) {
  return { payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64') };
}

export function verifyControlFrame(frame: any, key: KeyObject): any {
  if (!frame || typeof frame.signature !== 'string' || !frame.payload ||
    !verify(null, Buffer.from(JSON.stringify(frame.payload)), key, Buffer.from(frame.signature, 'base64'))) {
    throw new Error('Untrusted local control response');
  }
  return frame.payload;
}

function socketControl(gate: MediaMaintenance, authority: KeyObject, serverKey: KeyObject, clients: Set<Socket>): Server {
  let commandsInFlight = 0;
  return createServer(socket => {
    // Abstract sockets have no filesystem ACL. Both peers authenticate via
    // independently pinned keys. Bound resources even for local strangers.
    if (clients.size >= 16 || commandsInFlight >= 16) { socket.destroy(); return; }
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    const challenge = randomBytes(32).toString('hex');
    const issued = performance.now();
    const expiry = setTimeout(() => socket.destroy(), 5000);
    socket.once('close', () => clearTimeout(expiry));
    const target = gate.snapshot();
    socket.on('error', () => { /* Never log command frames/signatures. */ });
    let frame = '';
    let requestId: string | undefined;
    let consumed = false;
    socket.on('data', chunk => {
      if (consumed) return;
      frame += chunk.toString('utf8');
      if (Buffer.byteLength(frame) > MAX_FRAME) { consumed = true; socket.destroy(); return; }
      const newline = frame.indexOf('\n');
      if (newline < 0) return;
      if (!requestId) {
        try {
          const hello = JSON.parse(frame.slice(0, newline));
          if (hello.protocol !== 'salem-media-maintenance-v1' || !UUID.test(hello.requestId) || frame.slice(newline + 1).trim() || performance.now() - issued >= 5000) throw new Error('Invalid hello');
          requestId = hello.requestId;
          frame = '';
          socket.write(`${JSON.stringify(signedControlFrame({ protocol: 'salem-media-maintenance-v1', requestId, challenge, incarnation: target.incarnation, railway: target.railway }, serverKey))}\n`);
        } catch { socket.destroy(); }
        return;
      }
      consumed = true;
      let command: any;
      try {
        if (performance.now() - issued >= 5000 || frame.slice(newline + 1).trim()) throw new Error('Expired or extra frame');
        command = JSON.parse(frame.slice(0, newline));
        if (command.command !== 'close-and-drain' || command.requestId !== requestId || command.incarnation !== target.incarnation ||
          exact(command.railway) !== exact(target.railway) || command.challenge !== challenge ||
          !Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 60_000 ||
          typeof command.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(command.signature) ||
          !verify(null, Buffer.from(controlPayload(challenge, command.incarnation, command.railway, command.timeoutMs, requestId)), authority, Buffer.from(command.signature, 'base64'))) {
          throw new Error('Invalid command');
        }
      } catch { clearTimeout(expiry); socket.end(`${JSON.stringify({ error: 'unauthorized' })}\n`); return; }
      if (commandsInFlight >= 16) { socket.destroy(); return; }
      commandsInFlight++;
      clearTimeout(expiry);
      const publicationDeadline = performance.now() + command.timeoutMs;
      const deadline = setTimeout(() => socket.destroy(), command.timeoutMs + 5000);
      socket.once('close', () => clearTimeout(deadline));
      void gate.closeAndDrain(command.timeoutMs).then(receipt => {
        if (socket.destroyed) return;
        const frame = () => `${JSON.stringify(signedControlFrame({ protocol: 'salem-media-maintenance-v1', requestId, challenge, command: 'close-and-drain', timeoutMs: command.timeoutMs, receipt }, serverKey))}\n`;
        let response = frame();
        // The budget covers local receipt signing/serialization up to enqueue,
        // not delivery time on the operator's connection.
        if (receipt.drained && performance.now() >= publicationDeadline) {
          receipt.drained = false; receipt.outcome = 'timeout'; response = frame();
        }
        socket.end(response);
      }).catch(() => socket.destroy()).finally(() => { commandsInFlight--; });
    });
  });
}

/** No enrollment/reset helper: externally established durable authority required. */
export async function startLocalMediaControl(server: FastifyInstance): Promise<void> {
  const directory = process.env.MEDIA_MAINTENANCE_DIRECTORY;
  if (directory === undefined) return;
  // Linux abstract UDS support arrived in Node 20.8. Never fall back to a
  // pathname socket whose automatic unlink could remove a substituted file.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || major < 20 || (major === 20 && minor < 8)) throw new Error('Maintenance requires Linux and Node >=20.8');
  const gate = mediaMaintenance(server);
  await assertDirectory(directory);
  const anchor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const anchored = (name: string) => join(`/proc/self/fd/${anchor.fd}`, name);
  let control: Server | undefined;
  const clients = new Set<Socket>();
  try {
    await assertDirectory(directory, anchor);
    const authorityFile = await protectedJson(anchored('authority.json'));
    const authority = authorityFile.value;
    if (authority.version !== 1 || !UUID.test(authority.installationId) || exact(authority.railway) !== exact(gate.identity)) {
      throw new Error('Maintenance authority identity mismatch');
    }
    let key: KeyObject;
    try {
      if (typeof authority.operatorPublicKey !== 'string' || !authority.operatorPublicKey.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error();
      key = createPublicKey(authority.operatorPublicKey);
      if (key.export({format:'pem',type:'spki'}) !== authority.operatorPublicKey) throw new Error();
    } catch { throw new Error('Invalid public-only operator key'); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Maintenance authority must be Ed25519');
    const serverKeyFile = await protectedJson(anchored('server-key.json'));
    let serverKey: KeyObject;
    try { serverKey = createPrivateKey(serverKeyFile.value.serverPrivateKey); } catch { throw new Error('Invalid server receipt key'); }
    if (authority.operatorPublicKey === authority.serverPublicKey || serverKey.asymmetricKeyType !== 'ed25519' || createPublicKey(serverKey).export({format:'pem',type:'spki'}) !== authority.serverPublicKey) throw new Error('Maintenance server key mismatch');
    let stateFile = await protectedJson(anchored('state.json'));
    const state = stateFile.value;
    if (state.version !== 1 || !['enrolled', 'consumed'].includes(state.status) || state.installationId !== authority.installationId ||
      Object.keys(state).sort().join(',') !== 'installationId,status,version') throw new Error('Maintenance enrollment/recovery required');
    const guard = async () => {
      await assertDirectory(directory, anchor);
      if ((await protectedJson(anchored('authority.json'))).fingerprint !== authorityFile.fingerprint ||
        (await protectedJson(anchored('state.json'))).fingerprint !== stateFile.fingerprint ||
        (await protectedJson(anchored('server-key.json'))).fingerprint !== serverKeyFile.fingerprint) throw new Error('Maintenance authority/state changed');
    };
    const optional = async (name: string) => {
      try { return await protectedJson(anchored(name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const record = async (name: string, value: object) => {
      await guard();
      const intended = `${JSON.stringify(value)}\n`;
      const file = await open(anchored(name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const owned = await file.stat();
      try { await file.writeFile(intended); await file.sync(); }
      finally { await file.close(); }
      await anchor.sync();
      await guard();
      const written = await protectedJson(anchored(name));
      if (written.fingerprint !== `${owned.dev}:${owned.ino}:${intended}`) throw new Error('Maintenance record replaced');
      return written;
    };
    let consumed = await optional('consumed.json');
    const oldClosed = await optional('closed.json');
    const recoveryRequired = consumed !== null;
    if (consumed) {
      const previous = consumed.value;
      if (previous.version !== 1 || previous.status !== 'running' || !UUID.test(previous.incarnation) ||
        previous.installationId !== authority.installationId || exact(previous.railway) !== exact(gate.identity)) {
        throw new Error('Maintenance consumed record requires recovery');
      }
      if (oldClosed && exact(oldClosed.value) !== exact({ ...previous, status: 'closed' })) throw new Error('Conflicting maintenance close record');
    } else {
      if (oldClosed || state.status !== 'enrolled') throw new Error('Missing maintenance consumed record');
      consumed = await record('consumed.json', {
        version: 1, status: 'running', installationId: authority.installationId, incarnation: gate.incarnation, railway: gate.identity,
      });
      // Consume the actual grant via a verified held FD. Loss of only the
      // journal can never turn a running installation back into enrollment.
      const stateHandle = await open(anchored('state.json'), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const held = await stateHandle.stat();
        if (!held.isFile() || held.nlink !== 1 || held.uid !== process.getuid?.() || (held.mode & 0o077) !== 0) throw new Error('Unsafe enrollment grant');
        const current = await protectedJson(anchored('state.json'));
        if (current.fingerprint !== stateFile.fingerprint || !current.fingerprint.startsWith(`${held.dev}:${held.ino}:`)) throw new Error('Enrollment grant changed');
        await stateHandle.truncate(0);
        await stateHandle.writeFile(`${JSON.stringify({ ...state, status: 'consumed' })}\n`);
        await stateHandle.sync();
        await anchor.sync();
        const updated = await protectedJson(anchored('state.json'));
        if (!updated.fingerprint.startsWith(`${held.dev}:${held.ino}:`) || exact(updated.value) !== exact({ ...state, status: 'consumed' })) throw new Error('Consumed grant changed');
        stateFile = updated;
      } finally { await stateHandle.close(); }
      await guard();
    }
    const consumedFingerprint = consumed.fingerprint;
    const journal = consumed.value;
    let closedFingerprint: string | undefined;
    gate.configure(async () => {
      await guard();
      if ((await protectedJson(anchored('consumed.json'))).fingerprint !== consumedFingerprint) throw new Error('Maintenance consumed record changed');
      if (recoveryRequired) return; // Never certify or rewrite a prior process.
      closedFingerprint = (await record('closed.json', { ...journal, status: 'closed' })).fingerprint;
      if ((await protectedJson(anchored('consumed.json'))).fingerprint !== consumedFingerprint) throw new Error('Maintenance consumed record changed');
    }, recoveryRequired, async () => {
      await guard();
      if ((await protectedJson(anchored('consumed.json'))).fingerprint !== consumedFingerprint) throw new Error('Maintenance consumed record changed');
      if (!recoveryRequired && (await protectedJson(anchored('closed.json'))).fingerprint !== closedFingerprint) throw new Error('Maintenance close record changed');
    });
    control = socketControl(gate, key, serverKey, clients);
    await new Promise<void>((resolve, reject) => {
      control!.once('error', reject);
      control!.listen(mediaControlAddress(authority.installationId), () => { control!.off('error', reject); resolve(); });
    });
    control.on('error', () => { void gate.markCleanupFailure(); });
    server.addHook('onClose', async () => {
      await gate.closeAndDrain(1);
      for (const socket of clients) socket.destroy();
      await new Promise<void>(resolve => control!.close(() => resolve()));
      await anchor.close();
    });
  } catch (error) {
    await gate.markCleanupFailure();
    for (const socket of clients) socket.destroy();
    if (control?.listening) await new Promise<void>(resolve => control!.close(() => resolve()));
    await anchor.close();
    throw error;
  }
}
