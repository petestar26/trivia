import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile, chmod, link } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaMaintenance } from './maintenance.js';
import { controlPayload, mediaControlAddress, startLocalMediaControl, verifyControlFrame, signedControlFrame } from './local-control.js';
import { closePinnedMediaTarget } from './operator-client.js';

const slowCrypto=vi.hoisted(()=>({delay:0}));
vi.mock('node:crypto',async importOriginal=>{
  const crypto=await importOriginal<typeof import('node:crypto')>();
  return {...crypto,sign:(...args:any[])=>{
    if(slowCrypto.delay){const until=performance.now()+slowCrypto.delay;while(performance.now()<until){/* blocked signing */}}
    return (crypto.sign as any)(...args);
  }};
});

// This managed runtime rejects AF_UNIX with EPERM. TEST ONLY adapter maps
// abstract names to real loopback streams, keeping protocol/journal code real.
// Production has no alternate transport or bypass. Actual AF_UNIX operation
// remains a required external validation before any installation.
vi.mock('node:net', async importOriginal => {
  const net = await importOriginal<typeof import('node:net')>();
  const ports = new Map<string, number>();
  return {
    ...net,
    createServer: (...args: any[]) => {
      const server = (net.createServer as any)(...args);
      const listen = server.listen.bind(server); const close = server.close.bind(server);
      let name: string | undefined;
      server.listen = (path: string, callback: () => void) => {
        name = path;
        if (ports.has(path)) { queueMicrotask(() => server.emit('error', Object.assign(new Error('Address in use'), {code:'EADDRINUSE'}))); return server; }
        return listen({ host: '127.0.0.1', port: 0 }, () => { ports.set(path, server.address().port); callback(); });
      };
      server.close = (callback: () => void) => { if (name) ports.delete(name); return close(callback); };
      return server;
    },
    connect: (path: string) => {
      const port = ports.get(path);
      return port ? net.connect({host:'127.0.0.1',port}) : net.connect(path);
    },
  };
});

// All authority is ephemeral TEST ONLY. No deployment identity/key enrollment.
const keys = generateKeyPairSync('ed25519');
const serverKeys = generateKeyPairSync('ed25519');
let directory: string;
let installationId: string;
let server: FastifyInstance;
let expected: ReturnType<ReturnType<typeof mediaMaintenance>['snapshot']>;
const sockets: Socket[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'salem-media-test-'));
  installationId = randomUUID();
  vi.stubEnv('MEDIA_MAINTENANCE_DIRECTORY', directory);
  for (const field of ['PROJECT', 'ENVIRONMENT', 'SERVICE', 'DEPLOYMENT']) vi.stubEnv(`RAILWAY_${field}_ID`, randomUUID());
  server = Fastify();
  expected = mediaMaintenance(server).snapshot();
  await writeFile(join(directory, 'authority.json'), JSON.stringify({ version: 1, installationId, railway: expected.railway, operatorPublicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }), serverPublicKey: serverKeys.publicKey.export({format:'pem',type:'spki'}) }), { mode: 0o600 });
  await writeFile(join(directory, 'server-key.json'), JSON.stringify({version:1,serverPrivateKey:serverKeys.privateKey.export({format:'pem',type:'pkcs8'})}), {mode:0o600});
  await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, status: 'enrolled', installationId }), { mode: 0o600 });
});
afterEach(async () => {
  slowCrypto.delay=0;
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.destroy();
  await server.close();
  await rm(directory, { recursive: true, force: true });
  await rm(`${directory}-moved`, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function connection() {
  const socket = connect(mediaControlAddress(installationId)); sockets.push(socket);
  socket.on('error', () => {});
  const lines: any[] = []; const waiters: ((value: any) => void)[] = []; let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString(); let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      const waiter = waiters.shift(); if (waiter) waiter(line); else lines.push(line);
    }
  });
  const line = () => lines.length ? Promise.resolve(lines.shift()) : new Promise<any>(resolve => waiters.push(resolve));
  const requestId = randomUUID();
  socket.write(`${JSON.stringify({protocol:'salem-media-maintenance-v1',requestId})}\n`);
  const greeting = verifyControlFrame(await line(), serverKeys.publicKey);
  expect(greeting.requestId).toBe(requestId);
  return { socket, line, greeting, requestId };
}
async function command(options: { key?: typeof keys.privateKey; signature?: string; target?: object; incarnation?: string; timeoutMs?: number; command?: string } = {}) {
  const c = await connection();
  // Pin independently known expected incarnation/identity before signing.
  expect(c.greeting.incarnation).toBe(expected.incarnation); expect(c.greeting.railway).toEqual(expected.railway);
  const incarnation = options.incarnation ?? expected.incarnation;
  const railway = options.target ?? expected.railway;
  const timeoutMs = options.timeoutMs ?? 50;
  const signature = options.signature ?? sign(null, Buffer.from(controlPayload(c.greeting.challenge, incarnation, railway, timeoutMs, c.requestId)), options.key ?? keys.privateKey).toString('base64');
  c.socket.write(`${JSON.stringify({ command: options.command ?? 'close-and-drain', challenge: c.greeting.challenge, requestId: c.requestId, incarnation, railway, timeoutMs, signature })}\n`);
  const response = await c.line();
  if (response.error) return response;
  const verified = verifyControlFrame(response, serverKeys.publicKey);
  expect(verified.requestId).toBe(c.requestId); expect(verified.challenge).toBe(c.greeting.challenge);
  return verified.receipt;
}

describe('independently authenticated local-only control', () => {
  const target = () => ({installationId,incarnation:expected.incarnation,railway:expected.railway,serverPublicKey:serverKeys.publicKey.export({format:'pem',type:'spki'}).toString()});
  it('strict operator helper accepts only a mutually authenticated, pinned, correlated receipt', async () => {
    await startLocalMediaControl(server);
    await expect(closePinnedMediaTarget({...target(),serverPublicKey:generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString()},keys.privateKey,100)).rejects.toThrow('Untrusted');
    await expect(closePinnedMediaTarget({...target(),incarnation:randomUUID()},keys.privateKey,100)).rejects.toThrow('Untrusted');
    expect(mediaMaintenance(server).snapshot().closed).toBe(false);
    const verified = await closePinnedMediaTarget(target(),keys.privateKey,100);
    expect(verifyControlFrame(verified,serverKeys.publicKey).receipt).toMatchObject({drained:true,incarnation:expected.incarnation});
  });

  it('cannot publish a successful signed receipt after synchronous signing exceeds the original budget', async () => {
    await startLocalMediaControl(server);
    slowCrypto.delay=35;
    expect(await command({timeoutMs:20})).toMatchObject({drained:false,outcome:'timeout',closed:true});
  });

  it.each(['wrong-key', 'stale-request', 'altered-receipt'])('rejects rogue endpoint %s without trusting its readiness claim', async attack => {
    const rogueKey = generateKeyPairSync('ed25519').privateKey;
    const rogue = createServer(socket => {
      let phase = 0; let requestId = ''; let buffer = '';
      socket.on('error',()=>{});
      socket.on('data',chunk=>{
        buffer+=chunk.toString(); if(!buffer.includes('\n')) return;
        const message=JSON.parse(buffer.trim());buffer='';
        if(phase++===0){
          requestId=message.requestId;
          socket.write(`${JSON.stringify(signedControlFrame({protocol:'salem-media-maintenance-v1',requestId:attack==='stale-request'?randomUUID():requestId,challenge:'a'.repeat(64),incarnation:expected.incarnation,railway:expected.railway},attack==='wrong-key'?rogueKey:serverKeys.privateKey))}\n`);
        } else {
          const frame=signedControlFrame({protocol:'salem-media-maintenance-v1',requestId,challenge:'a'.repeat(64),command:'close-and-drain',timeoutMs:100,receipt:{incarnation:expected.incarnation,railway:expected.railway,scope:'single-api-server-instance-only',drained:false}},serverKeys.privateKey);
          (frame.payload as any).receipt.drained=true;
          socket.end(`${JSON.stringify(frame)}\n`);
        }
      });
    });
    await new Promise<void>(resolve=>rogue.listen(mediaControlAddress(installationId),resolve));
    try { await expect(closePinnedMediaTarget(target(),keys.privateKey,100)).rejects.toThrow('Untrusted'); }
    finally {await new Promise<void>(resolve=>rogue.close(()=>resolve()));}
  });

  it('rejects missing/wrong authority, stale identity/incarnation and resume/force commands', async () => {
    await startLocalMediaControl(server);
    expect(await command({ signature: '' })).toEqual({ error: 'unauthorized' });
    expect(await command({ key: generateKeyPairSync('ed25519').privateKey })).toEqual({ error: 'unauthorized' });
    expect(await command({ incarnation: randomUUID() })).toEqual({ error: 'unauthorized' });
    expect(await command({ target: { ...expected.railway, RAILWAY_REPLICA_ID: 'different' } })).toEqual({ error: 'unauthorized' });
    expect(await command({ command: 'resume' })).toEqual({ error: 'unauthorized' });
    expect(await command({ command: 'force' })).toEqual({ error: 'unauthorized' });
    expect(mediaMaintenance(server).snapshot().closed).toBe(false);
    expect((await server.inject({ method: 'POST', url: '/api/v1/media-maintenance', payload: { force: true } })).statusCode).toBe(404);
    expect(await command()).toMatchObject({ drained: true, closed: true, incarnation: expected.incarnation, railway: expected.railway });
    expect(await command()).toMatchObject({ drained: true });
    expect(JSON.parse(await readFile(join(directory, 'closed.json'), 'utf8')).incarnation).toBe(expected.incarnation);
  });

  it('retains durable restart latch and never calls a previous incarnation drained', async () => {
    await startLocalMediaControl(server);
    const oldRelease = mediaMaintenance(server).admit();
    expect(await command({ timeoutMs: 10 })).toMatchObject({ outcome: 'timeout', active: 1, drained: false });
    await server.close();
    server = Fastify(); expected = mediaMaintenance(server).snapshot();
    await startLocalMediaControl(server);
    expect(() => mediaMaintenance(server).admit()).toThrow();
    expect(await command()).toMatchObject({ outcome: 'recovery-required', drained: false, active: 0 });
    oldRelease();
    expect(await command()).toMatchObject({ drained: false, outcome: 'recovery-required' });
  });

  it('never treats loss of only the consumed journal as a fresh grant', async () => {
    await startLocalMediaControl(server);
    expect(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).status).toBe('consumed');
    await rm(join(directory,'consumed.json'));
    await server.close(); server=Fastify();
    await expect(startLocalMediaControl(server)).rejects.toThrow('Missing');
    expect(JSON.parse(await readFile(join(directory,'state.json'),'utf8')).status).toBe('consumed');
  });

  it('revalidates journal after the last in-flight operation settles', async () => {
    await startLocalMediaControl(server);
    const release=mediaMaintenance(server).admit(); const pending=command({timeoutMs:1000});
    await vi.waitFor(async()=>{expect(JSON.parse(await readFile(join(directory,'closed.json'),'utf8')).status).toBe('closed');});
    await writeFile(join(directory,'consumed.json'),'{}',{mode:0o600});
    release(); expect(await pending).toMatchObject({outcome:'latch-failed',drained:false,active:0});
  });

  it('refuses multiply linked grant without changing its other alias', async () => {
    const alias=join(directory,'unrelated.json'); await link(join(directory,'state.json'),alias);
    const original=await readFile(alias,'utf8');
    await expect(startLocalMediaControl(server)).rejects.toThrow('authority/state');
    expect(await readFile(alias,'utf8')).toBe(original);
  });

  it.each(['operator-private', 'same-key'])('requires public-only independent keys: %s', async bad => {
    const authority=JSON.parse(await readFile(join(directory,'authority.json'),'utf8'));
    authority.operatorPublicKey=bad==='operator-private'?keys.privateKey.export({format:'pem',type:'pkcs8'}):authority.serverPublicKey;
    await writeFile(join(directory,'authority.json'),JSON.stringify(authority),{mode:0o600});
    await expect(startLocalMediaControl(server)).rejects.toThrow(bad==='operator-private'?'public-only':'server key');
  });

  it('does not include malformed key/JSON contents in startup diagnostics', async () => {
    await writeFile(join(directory,'server-key.json'),'{"private":"TEST-SECRET-MARKER"', {mode:0o600});
    const error=await startLocalMediaControl(server).catch(error=>error);
    expect(error.message).not.toContain('TEST-SECRET-MARKER'); expect(error.message).toBe('Invalid local maintenance JSON');
  });

  it('records actual native AF_UNIX refusal without a production transport fallback', async () => {
    const net=await vi.importActual<typeof import('node:net')>('node:net');
    const native=net.createServer();
    const result=await new Promise<string>(resolve=>{native.once('error',(error:any)=>resolve(error.code));native.listen(`\0salem-native-test-${randomUUID()}`,()=>native.close(()=>resolve('supported')));});
    expect(['EPERM','supported']).toContain(result);
    // In this managed runtime the observed result is EPERM; successful fixture
    // transport tests above do not claim native AF_UNIX was exercised.
  });

  it('refuses displaced directories and replaced or conflicting immutable records', async () => {
    await startLocalMediaControl(server);
    await rename(directory, `${directory}-moved`);
    expect(await command()).toMatchObject({ drained: false, outcome: 'latch-failed' });
    expect(await readFile(join(`${directory}-moved`, 'consumed.json'), 'utf8')).toContain(expected.incarnation);
  });

  it.each(['authority.json', 'state.json', 'consumed.json', 'closed.json'])('revalidates %s on every repeated receipt', async name => {
    await startLocalMediaControl(server);
    expect(await command()).toMatchObject({ drained: true });
    await writeFile(join(directory, name), '{}', { mode: 0o600 });
    expect(await command()).toMatchObject({ drained: false, outcome: 'latch-failed' });
    expect(await readFile(join(directory, name), 'utf8')).toBe('{}');
  });

  it('rejects missing/ambiguous state and insecure authority without any reset', async () => {
    await rm(join(directory, 'state.json'));
    await expect(startLocalMediaControl(server)).rejects.toThrow();
    await writeFile(join(directory, 'state.json'), '{}', { mode: 0o600 });
    await expect(startLocalMediaControl(server)).rejects.toThrow('recovery');
    await chmod(join(directory, 'authority.json'), 0o644);
    await expect(startLocalMediaControl(server)).rejects.toThrow('authority/state');
  });

  it('refuses existing exclusive ownership and conflicting closed journal', async () => {
    await writeFile(join(directory, 'closed.json'), '{}', { mode: 0o600 });
    await expect(startLocalMediaControl(server)).rejects.toThrow('Missing');
    expect(await readFile(join(directory, 'closed.json'), 'utf8')).toBe('{}');
  });

  it('expires a challenge after an absolute deadline despite trickle input', async () => {
    await startLocalMediaControl(server);
    const c = await connection();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The already-created deadline is real, so this case uses a second socket
    // created under the timer clock, and advances without any blocking wait.
    const d = await connection();
    d.socket.write('{');
    const closed = new Promise<void>(resolve => d.socket.once('close', () => resolve()));
    await vi.advanceTimersByTimeAsync(5001);
    await closed;
    expect(mediaMaintenance(server).snapshot().closed).toBe(false);
    c.socket.destroy();
  });
});
