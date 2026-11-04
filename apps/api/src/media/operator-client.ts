import { createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { controlPayload, mediaControlAddress, verifyControlFrame } from './local-control.js';

export interface PinnedMediaTarget {
  installationId: string;
  incarnation: string;
  railway: Readonly<Record<string, string | null>>;
  serverPublicKey: string;
}

/** The target must come from an independently trusted operator record, NEVER
 * from a socket greeting. No credential enrollment, target discovery or reopen. */
export async function closePinnedMediaTarget(target: PinnedMediaTarget, operatorKey: KeyObject, timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid drain timeout');
  let serverKey: KeyObject;
  try {
    if (!target.serverPublicKey.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error();
    serverKey = createPublicKey(target.serverPublicKey);
    if (serverKey.asymmetricKeyType !== 'ed25519' || operatorKey.type !== 'private' || operatorKey.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(operatorKey).export({format:'pem',type:'spki'}) === target.serverPublicKey) throw new Error();
  } catch { throw new Error('Invalid independent operator/server keys'); }
  const requestId = randomUUID();
  const waitDeadline = performance.now() + timeoutMs + 5500;
  return new Promise<any>((resolve, reject) => {
    const socket = connect(mediaControlAddress(target.installationId));
    const deadline = setTimeout(() => fail(new Error('Local control deadline exceeded')), timeoutMs + 5500);
    let buffer = ''; let challenge: string | undefined; let done = false;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(deadline); socket.destroy(); reject(error); };
    socket.once('error', () => fail(new Error('Local control connection failed')));
    socket.once('close', () => { if (!done) fail(new Error('Local control closed without a verified receipt')); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ protocol: 'salem-media-maintenance-v1', requestId })}\n`));
    socket.on('data', chunk => {
      if (done) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 8192) { fail(new Error('Oversized local control response')); return; }
      const at = buffer.indexOf('\n'); if (at < 0) return;
      try {
        if (buffer.slice(at + 1).trim()) throw new Error('Unexpected control frame');
        const frame = JSON.parse(buffer.slice(0, at)); buffer = '';
        const payload = verifyControlFrame(frame, serverKey);
        if (performance.now() >= waitDeadline) throw new Error('Local control deadline exceeded');
        if (payload.protocol !== 'salem-media-maintenance-v1' || payload.requestId !== requestId) throw new Error('Stale control response');
        if (!challenge) {
          if (payload.incarnation !== target.incarnation || JSON.stringify(payload.railway) !== JSON.stringify(target.railway) ||
            typeof payload.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(payload.challenge)) throw new Error('Control target mismatch');
          const matchedChallenge: string = payload.challenge;
          challenge = matchedChallenge;
          const signature = sign(null, Buffer.from(controlPayload(matchedChallenge, target.incarnation, target.railway, timeoutMs, requestId)), operatorKey).toString('base64');
          socket.write(`${JSON.stringify({ command: 'close-and-drain', requestId, challenge, incarnation: target.incarnation, railway: target.railway, timeoutMs, signature })}\n`);
        } else {
          if (payload.challenge !== challenge || payload.command !== 'close-and-drain' || payload.timeoutMs !== timeoutMs ||
            payload.receipt?.incarnation !== target.incarnation || JSON.stringify(payload.receipt?.railway) !== JSON.stringify(target.railway) ||
            payload.receipt?.scope !== 'single-api-server-instance-only') throw new Error('Control receipt mismatch');
          if (performance.now() >= waitDeadline) throw new Error('Local control deadline exceeded');
          done = true; clearTimeout(deadline); socket.destroy(); resolve(frame);
        }
      } catch { fail(new Error('Untrusted local control response')); }
    });
  });
}
